"""The CHIRPS finals job (issue #604 R2-A, D4, D8): copy CHC's `byMonth`
NetCDF files for `rnl` and `sat` into the copy's finals arrays.

    https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/final/<rnl|sat>/netcdf/byMonth/
        chirps-v3.0.YYYY.MM.days_p05.nc      (rnl from 1981-01, sat from 2000-06)

**monthly** (run daily per product by EventBridge, infra/ingest.tf):

1. One conditional GET of the `byMonth` listing (an nginx autoindex page),
   with the validators the last *complete* run saved. A 304 ends the run.
2. Parse the listing (name, time to the minute in UTC, size in bytes) and
   diff it against the manifest's `files`: a month not in the manifest is
   new; one whose size or time differs from the manifest's `size` /
   `lastModified` is changed (CHC rewrites files in place, D8).
3. Download each new or changed month **whole**, oldest first, one at a time,
   at most **one file a minute** (D4), and only while the Lambda has time
   left for a whole file (`DOWNLOAD_RESERVE_S`); the rest wait for the next
   day. The listing's validators are saved only when nothing was left, so a
   run the budget cut short never turns into a 304 that hides the rest.
4. Each file goes through `ingest_file`: subset to the region and the 0–2000
   mm check (chcnetcdf), the values hash (D8), the Zarr write and the
   manifest. The revision goes up only when the values changed, with a
   `changes` entry; a re-copy with the same values moves `fetchedAt` and
   nothing else. `finalThrough` is the end of the contiguous run of months.

**backfill** `{"month": "YYYY-MM"}`: the same single-file path for one named
month, as one conditional GET of that file (a month already held with the
same validators is a 304 and changes nothing). R2-B's Step Functions map
calls it one month per invocation.

Pacing holds across invocations: the time of the last download is kept in
`ingest-state/<product>/state.json` beside the listing's validators, and a
run waits out the rest of that minute before its first download.

**One writer per product** (lease.py): every run holds the product's lease,
so a backfill and the daily run can't write the same year's chunks at once.
A monthly run that finds it held ends quietly; a backfill raises MirrorBusy.

**A 403 stops the run** (polite.StopRun) and is never retried: it propagates,
the Lambda errors, and the errors alarm and the DLQ see it.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import email.utils
import logging
import re
import tempfile
import time
from pathlib import Path
from typing import Callable

import numpy as np

import chcnetcdf
import grid
import lease
import manifest
import polite
import zarrstore

log = logging.getLogger("ingest")

BASE = "https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/final"

#: The first month CHC publishes byMonth finals for (Round 0, docs/spikes/604-round0.md).
FIRST_MONTH = {"rnl": (1981, 1), "sat": (2000, 6)}

#: D4: at most one file download a minute, across runs.
DOWNLOAD_INTERVAL_S = 60.0

#: Don't start a download with less than this left of the Lambda's time: a
#: ~350 MiB file took 37 s from af-south-1 (Round 0), and decoding, hashing
#: and writing a year's chunks to S3 take a few minutes more.
DOWNLOAD_RESERVE_S = 360.0

#: cellsChanged when the copy didn't hold the previous file's values (ingest_file): every cell of the region.
REGION_CELLS = grid.ROWS * grid.COLS

_NAME = re.compile(r"^chirps-v3\.0\.(\d{4})\.(0[1-9]|1[0-2])\.days_p05\.nc$")
_ROW = re.compile(r'<a href="([^"?#]+)">[^<]*</a>\s+(\d{2}-[A-Z][a-z]{2}-\d{4} \d{2}:\d{2})\s+(\S+)')


class ListingError(ValueError):
    """CHC's listing (or a file against it) isn't what this job expects: stop and alarm."""


def listing_url(product: str) -> str:
    return f"{BASE}/{product}/netcdf/byMonth/"


def file_url(product: str, year: int, month: int) -> str:
    return f"{listing_url(product)}chirps-v3.0.{year:04d}.{month:02d}.days_p05.nc"


def state_key(product: str) -> str:
    return f"ingest-state/{product}/state.json"


# --- the listing ------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class ListingEntry:
    name: str
    url: str
    month: tuple[int, int]
    modified: dt.datetime  # UTC, to the minute
    size: int | None  # bytes; None when the listing shows a rounded size (346M)


def parse_listing(html: str, product: str) -> list[ListingEntry]:
    """The byMonth files an nginx autoindex page lists, oldest first. Anything
    else on the page (the parent link, other files) is ignored; a page that
    lists no byMonth file at all is refused, since that means the layout moved."""
    first = FIRST_MONTH[product]
    out: dict[str, ListingEntry] = {}
    for href, when, size in _ROW.findall(html):
        m = _NAME.match(href)
        if not m:
            continue
        month = (int(m[1]), int(m[2]))
        if month < first:
            continue
        if href in out:
            raise ListingError(f"the {product} listing names {href} twice")
        modified = dt.datetime.strptime(when, "%d-%b-%Y %H:%M").replace(tzinfo=dt.UTC)
        out[href] = ListingEntry(href, listing_url(product) + href, month, modified, int(size) if size.isdigit() else None)
    if not out:
        raise ListingError(f"the {product} byMonth listing names no chirps-v3.0.YYYY.MM.days_p05.nc file: has CHC's layout changed?")
    return sorted(out.values(), key=lambda e: e.month)


def _http_minute(value: str | None) -> dt.datetime | None:
    """An HTTP date truncated to the minute (the listing's precision), UTC."""
    if not value:
        return None
    try:
        t = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if t is None:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.UTC)
    return t.astimezone(dt.UTC).replace(second=0, microsecond=0)


def needs_copy(entry: ListingEntry, held: dict | None) -> str | None:
    """'new', 'changed' or None (the manifest already holds this file as listed)."""
    if held is None:
        return "new"
    if entry.size is not None and held["size"] != entry.size:
        return "changed"
    if _http_minute(held["lastModified"]) != entry.modified:
        return "changed"
    return None


# --- pacing and the time budget ------------------------------------------------


class Budget:
    """The Lambda's time left (context.get_remaining_time_in_millis), or unlimited without a context."""

    def __init__(self, context=None, reserve_s: float = DOWNLOAD_RESERVE_S):
        self.context = context
        self.reserve_s = reserve_s

    def remaining_s(self) -> float | None:
        if self.context is None:
            return None
        return self.context.get_remaining_time_in_millis() / 1000.0

    def allows(self, wait_s: float) -> bool:
        left = self.remaining_s()
        return left is None or left - wait_s >= self.reserve_s


class Pacer:
    """At most one download every `interval` seconds, counting from `last` (epoch seconds, from the state object)."""

    def __init__(self, interval: float = DOWNLOAD_INTERVAL_S, last: float | None = None, clock: Callable[[], float] = time.time, sleep: Callable[[float], None] = time.sleep):
        self.interval = interval
        self.last = last
        self.clock = clock
        self.sleep = sleep

    def slot(self, budget: Budget) -> bool:
        """Wait for the next download's turn and return True, or return False
        (without waiting) when the budget wouldn't leave time for the file."""
        wait = 0.0 if self.last is None else max(0.0, self.last + self.interval - self.clock())
        if not budget.allows(wait):
            return False
        if wait > 0:
            self.sleep(wait)
        self.last = self.clock()
        return True


def _iso(t: float) -> str:
    return dt.datetime.fromtimestamp(t, dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _epoch(iso: str | None) -> float | None:
    if not iso:
        return None
    return dt.datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.UTC).timestamp()


def read_state(mirror: zarrstore.Mirror, product: str) -> dict:
    st = mirror.read_json(state_key(product)) or {}
    return {"listing": st.get("listing"), "lastDownloadAt": st.get("lastDownloadAt")}


def write_state(mirror: zarrstore.Mirror, product: str, st: dict) -> None:
    mirror.write_json(state_key(product), {"listing": st["listing"], "lastDownloadAt": st["lastDownloadAt"]})


# --- one file -----------------------------------------------------------------


def _diff(old: np.ndarray, new: np.ndarray) -> tuple[int, float]:
    """(cells whose series changed, the largest absolute difference where both have a value)."""
    both_nan = np.isnan(old) & np.isnan(new)
    changed = ~both_nan & ((old != new) | (np.isnan(old) != np.isnan(new)))
    cells = int(np.any(changed, axis=0).sum())
    finite = ~np.isnan(old) & ~np.isnan(new)
    max_abs = float(np.max(np.abs(old[finite] - new[finite]), initial=0.0))
    return cells, max_abs


def _check_month(url: str, first_day: dt.date, last_day: dt.date) -> None:
    """The file's days lie in the month its URL names and run to that month's
    last day, so manifest.finals_coverage can count the month as held whole."""
    ym = manifest.file_month(url)
    if ym is None:
        raise ValueError(f"{url} names no month (….YYYY.MM.days_p05.nc)")
    month_end = dt.date(ym[0] + ym[1] // 12, ym[1] % 12 + 1, 1) - dt.timedelta(days=1)
    if (first_day.year, first_day.month) != ym or last_day != month_end:
        raise ValueError(f"{url} holds {first_day}..{last_day}, not days of {ym[0]:04d}-{ym[1]:02d} through {month_end}")


def ingest_file(mirror: zarrstore.Mirror, product: str, url: str, path: Path, etag=None, last_modified=None, now=manifest.utc_now) -> dict:
    """Copy one CHC NetCDF file's region into `product` and record it in the manifest."""
    region = chcnetcdf.read_region(str(path))
    days = region.values.shape[0]
    last_day = region.first_day + dt.timedelta(days=days - 1)
    _check_month(url, region.first_day, last_day)
    sha = manifest.values_sha256(region.values)
    m = manifest.read(mirror, product) or manifest.new(product)
    previous = manifest.file_entry(m, url)

    outcome = "unchanged"
    if previous is None or previous["valuesSha256"] != sha:
        prefixes = zarrstore.finals_year_prefixes(product, region.first_day, days)
        with mirror.stage(prefixes) as root:
            old = zarrstore.read_finals(root, product, region.first_day, days)
            zarrstore.write_finals(root, product, region.first_day, region.values)
        if previous is None:
            outcome = "added"
        else:
            m["revision"] += 1
            if old is not None and manifest.values_sha256(old) == previous["valuesSha256"]:
                cells, max_abs = _diff(old, region.values)
            else:
                # The copy didn't hold the previous file's values: a run died
                # after uploading some or all of the new chunks but before the
                # manifest, and this retry reads them back (or the array is
                # gone). The old values are unknown, so the diff would claim
                # fewer cells than changed, 0 after a whole upload, and
                # 245_mirror_revision skips an entry with cellsChanged 0,
                # leaving stale cached finals unmarked. Claim every cell of the
                # region, and as maxAbsDiff the widest difference two plausible
                # values can have (chcnetcdf's 0–2000 mm): a true upper bound,
                # never 0.
                cells, max_abs = REGION_CELLS, chcnetcdf.PLAUSIBLE_MAX_MM - chcnetcdf.PLAUSIBLE_MIN_MM
            m["changes"].append({"revision": m["revision"], "days": [region.first_day.isoformat(), last_day.isoformat()], "cellsChanged": cells, "maxAbsDiff": max_abs})
            outcome = "changed"

    manifest.upsert_file(
        m,
        {
            "url": url,
            "etag": etag,
            "lastModified": last_modified,
            "size": path.stat().st_size,
            "valuesSha256": sha,
            "revision": m["revision"],
            "fetchedAt": now(),
        },
    )
    first, last = m["years"]["first"], m["years"]["last"]
    m["years"] = {"first": min(filter(None, [first, region.first_day.year])), "last": max(filter(None, [last, last_day.year]))}
    # The end of the contiguous run of months from the first copied, never the
    # newest day seen: a month not yet copied in between is not held.
    coverage = manifest.finals_coverage(m["files"])
    m["finalThrough"] = coverage[1] if coverage else None
    manifest.write(mirror, m)
    return {"url": url, "outcome": outcome, "days": [region.first_day.isoformat(), last_day.isoformat()], "revision": m["revision"]}


def _download(client: polite.PoliteClient, url: str, workdir: str | None, check: Callable[[polite.Response], None], ingest: Callable[[Path, polite.Response], dict], etag=None, last_modified=None) -> dict | None:
    """GET `url` into a temporary file and hand it to `ingest`; None on a 304."""
    with tempfile.TemporaryDirectory(prefix="chirps-", dir=workdir) as tmp:
        path = Path(tmp) / url.rsplit("/", 1)[-1]
        res = client.get(url, etag=etag, last_modified=last_modified, dest=str(path))
        if res.not_modified:
            return None
        check(res)
        return ingest(path, res)


# --- the two modes ------------------------------------------------------------


@dataclasses.dataclass
class Run:
    """What a mode needs besides the copy: the polite client, the pacing and the budget."""

    client: polite.PoliteClient
    budget: Budget
    interval: float = DOWNLOAD_INTERVAL_S
    clock: Callable[[], float] = time.time
    sleep: Callable[[float], None] = time.sleep
    workdir: str | None = None
    now: Callable[[], str] = manifest.utc_now

    def pacer(self, st: dict) -> Pacer:
        # The slot is taken before the polite client's own spacing (up to
        # min_interval more), so count that in: the requests themselves are
        # then at least `interval` apart.
        slack = self.client.min_interval if self.interval else 0.0
        return Pacer(self.interval + slack, _epoch(st["lastDownloadAt"]), self.clock, self.sleep)


def run_monthly(mirror: zarrstore.Mirror, product: str, run: Run) -> dict:
    """The daily run: the listing, its diff against the manifest, and the new or changed months the budget allows."""
    with lease.hold(mirror, product, run.clock):
        st = read_state(mirror, product)
        saved = st["listing"] or {}
        res = run.client.get(listing_url(product), etag=saved.get("etag"), last_modified=saved.get("lastModified"))
        if res.not_modified:
            log.info("%s: the byMonth listing is unchanged (304)", product)
            return {"listing": "not-modified", "files": [], "pending": 0}
        entries = parse_listing((res.body or b"").decode("utf-8", "replace"), product)
        m = manifest.read(mirror, product) or manifest.new(product)
        todo = [(e, why) for e in entries if (why := needs_copy(e, manifest.file_entry(m, e.url)))]
        log.info("%s: the listing names %d months, %d new or changed", product, len(entries), len(todo))

        pacer = run.pacer(st)
        results = []
        for e, why in todo:
            if not pacer.slot(run.budget):
                log.info("%s: stopping before %s, too little time left; the next run continues", product, e.name)
                break
            st["lastDownloadAt"] = _iso(pacer.last)
            st["listing"] = None  # until every listed month is held
            write_state(mirror, product, st)

            def check(r: polite.Response, e=e):
                if e.size is not None and r.size != e.size:
                    raise ListingError(f"{e.url}: the listing says {e.size} bytes, the download was {r.size}")
                if _http_minute(r.last_modified) != e.modified:
                    raise ListingError(f"{e.url}: Last-Modified {r.last_modified!r} is not the listing's {e.modified:%Y-%m-%d %H:%M} UTC (is the listing in another time zone?)")

            out = _download(run.client, e.url, run.workdir, check, lambda path, r, e=e: ingest_file(mirror, product, e.url, path, r.etag, r.last_modified, run.now))
            if out is None:
                raise ListingError(f"{e.url} answered 304 to an unconditional GET")
            out["reason"] = why
            log.info("%s: %s %s (%s), revision %s", product, out["outcome"], e.name, why, out["revision"])
            results.append(out)

        pending = len(todo) - len(results)
        st["listing"] = {"etag": res.etag, "lastModified": res.last_modified} if pending == 0 and (res.etag or res.last_modified) else None
        write_state(mirror, product, st)
        return {"listing": "read", "files": results, "pending": pending}


def run_backfill(mirror: zarrstore.Mirror, product: str, month: str, run: Run) -> dict:
    """One named month: a conditional GET of its file, then the same ingest_file."""
    y, mo = (int(p) for p in month.split("-"))
    if (y, mo) < FIRST_MONTH[product]:
        raise ValueError(f"CHC has no {product} byMonth file for {month} (it starts {FIRST_MONTH[product][0]:04d}-{FIRST_MONTH[product][1]:02d})")
    url = file_url(product, y, mo)
    with lease.hold(mirror, product, run.clock):
        st = read_state(mirror, product)
        held = manifest.file_entry(manifest.read(mirror, product) or manifest.new(product), url)
        pacer = run.pacer(st)
        if not pacer.slot(run.budget):
            raise polite.RetryLater(f"too little time left to download {url} in this invocation")
        st["lastDownloadAt"] = _iso(pacer.last)
        write_state(mirror, product, st)
        out = _download(
            run.client,
            url,
            run.workdir,
            lambda r: None,
            lambda path, r: ingest_file(mirror, product, url, path, r.etag, r.last_modified, run.now),
            etag=held["etag"] if held else None,
            last_modified=held["lastModified"] if held else None,
        )
        if out is None:
            log.info("%s: %s is unchanged (304)", product, url)
            out = {"url": url, "outcome": "not-modified", "days": None, "revision": None}
        else:
            log.info("%s: %s %s, revision %s", product, out["outcome"], url, out["revision"])
        return {"files": [out], "pending": 0}
