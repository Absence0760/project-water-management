"""ERA5-Land daily rain into the copy (issue #604 R4-A, D15): product `era5l`.

    Copernicus Climate Data Store (CDS), dataset `reanalysis-era5-land`,
    variable `total_precipitation`, the 00 UTC step of each day, area D1.

Licence CC BY 4.0. Every place the app shows ERA5-Land's values carries
`ATTRIBUTION` (docs/data-sources.md § era5-land); the array's attributes hold
it too, so a reader of the copy alone still has it.

**How a day is defined (UTC).** ERA5-Land's `tp` is accumulated from 00 UTC:
the value at hour h is the rain since 00 UTC that day, and the value at
00 UTC is the whole previous day (the 24 hours ending at 00 UTC, ECMWF's
ERA5-Land documentation). So the day D total is the 00 UTC step of D + 1,
and nothing is summed: one field a day. A day here is the UTC calendar day
00:00–24:00, stored under that date. CHIRPS v3's day lines up with it in
shape but not wholly in substance: CHIRPS builds pentad totals and splits
them into days with ERA5's (`rnl`) or IMERG's (`sat`) daily fractions, both
UTC days, so the same date means the same UTC day; but the pentad totals
blend in gauges read in the local morning (about 06 UTC), so near a pentad's
edge a storm's rain can sit a day apart in the two products
(docs/data-sources.md § era5-land).

**One request per month, named by its steps.** A request asks for the 00 UTC
steps of every day of month M, which are the totals for the last day of M-1
through the second-last day of M. So month M's request writes the days
[first(M) - 1, last(M) - 1], each day is written by exactly one request, and
the last day of M comes with M+1's. (Asking for M's days 2..end plus the 1st
of M+1 can't be one CDS request: its fields are the product of the year,
month and day lists.) The 1950-01 request's first step is the start of the
record, so its written days start on 1950-01-01.

**The 0.1 deg grid (r4-shared.md).** The copy's cells are centred on
x.x5 deg (index [0, 0] = lat -35.45, lon 10.05; 275 rows x 310 columns, rows
northwards). ERA5-Land's CDS grid has its points on x.x0 deg, each the
centre of a 0.1 deg box. A copy cell is covered by exactly four of those
boxes, a quarter each, so its value is the mean of its four corner points:
the area-weighted (conservative) remap, which keeps the region's total rain.
Over sea ERA5-Land has no value; a coastal cell takes the mean of the corners
that have one, and a cell with none is NaN.

**Never wait inside a Lambda: submit on one run, collect on a later one.**
The CDS queues requests for minutes to hours. A run submits a month's request
and records its id in `ingest-state/era5l/requests.json`; later runs ask its
status, and once it is `successful` download the result whole (through the
polite client) and write it. Per month:

- at most one request in flight, and never more than `MAX_IN_FLIGHT` across
  months (the CDS's own per-user queue);
- the intent is written *before* the submit, and a run that finds an intent
  with no id (a crash between the two), or no state file at all (state lost),
  first looks for its own queued request among the account's recent jobs
  (`find`) and adopts it rather than submitting again;
- a failed request (failed, rejected, deleted, or gone) is resubmitted with
  backoff, 1, 2, 4, 8 days (`BACKOFF_*`), and after `MAX_ATTEMPTS` the run
  stops resubmitting and raises `RequestsFailed` every run (the errors
  alarm) until the operator clears that month's entry.

**monthly** (the daily rule): collect what is ready; then submit the newest
complete month (its last 00 UTC step at least `AVAILABLE_AFTER_DAYS` old,
ERA5-Land-T being about 5 days behind) and any month between it and the
newest held one (at most `CATCH_UP_MONTHS` back); then re-request each held month whose values may still
change upstream (`recheckAt`, below).

**ERA5T revisions.** The newest months are ERA5-Land-T, preliminary, and the
consolidated ERA5-Land replaces them about two months later; ECMWF says the
values can differ. The CDS gives no ETag, so a month whose file carried
preliminary data (`expver` other than 0001), or whose phase is unknown, is
requested once more `RECHECK_AFTER_DAYS` after its end, and again every
`RECHECK_EVERY_DAYS` while it stays preliminary. The revision rule is
CHIRPS's (chirps_final.ingest_file): a new revision, with a `changes` entry,
only when the values' hash changed; the same values only move `fetchedAt`.

**backfill** `{"month": "YYYY-MM"}`: marks the month wanted, collects what is
ready and submits wanted months while slots are free (newest first); the
daily run keeps draining the wanted months, so one pass over the months is
enough and later invocations only speed it up. AWS's `nsf-ncar-era5` carries
ERA5, not ERA5-Land (checked 2026-10-27), so the backfill uses the CDS too.

**Units and checks:** m to mm (x 1000), the 0-2000 mm check after the remap
(a value outside fails the run before anything is written; packing noise
above -`NEGATIVE_NOISE_MM` becomes 0), and the values hash (manifest.py).

**A 401 or 403 stops the run** (polite.StopRun), never retried, and writes a
same-day refused marker (`ingest-state/era5l/refused.json`) so another run
that day (a backfill invocation) does not knock again. **The lease**
(lease.py) is held for the whole run. **MirrorLagDays{Product=era5l}** is
published on every exit (`handler`).

**The key** comes from Secrets Manager by ARN (`CDS_KEY_SECRET_ARN`), read at
run time in live mode only and never logged. Fixtures mode (the default)
uses fakecds.FakeCds, which serves a synthetic NetCDF; no key, no network.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import logging
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Callable

import numpy as np

import chirps_final
import cloudwatch
import lease
import manifest
import polite
import zarrstore

log = logging.getLogger("ingest")

PRODUCT = "era5l"
DATASET = "reanalysis-era5-land"
VARIABLE = "total_precipitation"
CDS_URL = "https://cds.climate.copernicus.eu/api"

#: The copy's 0.1 deg grid on region D1 (r4-shared.md).
REGION = {"w": 10.0, "s": -35.5, "e": 41.0, "n": -8.0}
STEP = 0.1
ORIGIN = {"lat": -35.45, "lon": 10.05}
ROWS = 275
COLS = 310
#: ERA5-Land's points over the region: on x.x0 deg, one more each way than the cells.
POINT_ORIGIN = {"lat": -35.5, "lon": 10.0}
POINT_ROWS = ROWS + 1
POINT_COLS = COLS + 1

FIRST_YEAR = 1950
FIRST_MONTH = (1950, 1)
FIRST_DAY = dt.date(1950, 1, 1)
DOYS = 366
FINALS_CHUNKS = (1, DOYS, 20, 20)
REGION_CELLS = ROWS * COLS

#: A month's last 00 UTC step is on the CDS this many days after it (ERA5-Land-T is ~5 days behind).
AVAILABLE_AFTER_DAYS = 6
#: Re-request a preliminary (or unknown) month this long after its end (the consolidated data are ~2 months behind)...
RECHECK_AFTER_DAYS = 75
#: ...and again this often while it stays preliminary.
RECHECK_EVERY_DAYS = 30
#: The monthly run fills a gap after the newest held month back this far at most; older gaps are the backfill's.
CATCH_UP_MONTHS = 12
#: The most requests queued at the CDS at once, across months.
MAX_IN_FLIGHT = 4
#: A failed month is resubmitted after BACKOFF_BASE_DAYS * 2^(attempts-1), at most BACKOFF_MAX_DAYS...
BACKOFF_BASE_DAYS = 1
BACKOFF_MAX_DAYS = 16
#: ...and not after this many failures.
MAX_ATTEMPTS = 5
#: Don't start a download with less than this left of the Lambda's time (a month is a few MB; the write a minute or two).
COLLECT_RESERVE_S = 180.0
#: GRIB packing leaves tiny negative accumulations; above this (mm) they are 0, below it the check fails.
NEGATIVE_NOISE_MM = 0.001
#: The ERA5-Land phase in the file: 0001 is consolidated, anything else (0005) ERA5-Land-T.
FINAL_EXPVER = "0001"

PLAUSIBLE_MIN_MM = 0.0
PLAUSIBLE_MAX_MM = 2000.0

ATTRIBUTION = (
    "Contains modified Copernicus Climate Change Service information [year]. "
    "Neither the European Commission nor ECMWF is responsible for any use that may be made of the Copernicus information or data it contains. "
    "Muñoz Sabater, J. (2019): ERA5-Land hourly data from 1950 to present. Copernicus Climate Change Service (C3S) Climate Data Store (CDS). "
    "DOI: 10.24381/cds.e2161bac"
)

_MONTH = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")
_URL_MONTH = re.compile(r"/(\d{4})-(0[1-9]|1[0-2])$")


class BadEvent(ValueError):
    pass


class ImplausibleValueError(ValueError):
    """A value outside 0-2000 mm after the remap: stop before writing."""


class RequestsFailed(RuntimeError):
    """A month's request failed MAX_ATTEMPTS times: the operator looks (ingest/README.md)."""


class CdsError(RuntimeError):
    """The CDS answered something other than a refusal that this run can't use (a 5xx, a 429)."""


# --- months and days ----------------------------------------------------------


def month_str(ym: tuple[int, int]) -> str:
    return f"{ym[0]:04d}-{ym[1]:02d}"


def parse_month(s: str) -> tuple[int, int]:
    m = _MONTH.match(s)
    if not m:
        raise ValueError(f'month must be "YYYY-MM", got {s!r}')
    return int(m[1]), int(m[2])


def next_month(ym):
    y, m = ym
    return (y + 1, 1) if m == 12 else (y, m + 1)


def prev_month(ym):
    y, m = ym
    return (y - 1, 12) if m == 1 else (y, m - 1)


def month_end(ym) -> dt.date:
    return dt.date(*next_month(ym), 1) - dt.timedelta(days=1)


def written_days(ym) -> tuple[dt.date, dt.date]:
    """The days month `ym`'s request writes: the totals its 00 UTC steps hold."""
    first = max(dt.date(*ym, 1) - dt.timedelta(days=1), FIRST_DAY)
    return first, month_end(ym) - dt.timedelta(days=1)


def newest_complete_month(today: dt.date) -> tuple[int, int]:
    """The newest month whose last 00 UTC step the CDS should hold by `today`."""
    ym = prev_month((today.year, today.month))
    while month_end(ym) + dt.timedelta(days=AVAILABLE_AFTER_DAYS) > today:
        ym = prev_month(ym)
    return ym


def file_url(ym) -> str:
    """The manifest's `url` for a month's request: what was asked, not the (expiring) download link."""
    return f"cds://{DATASET}/{VARIABLE}/{month_str(ym)}"


def url_month(url: str) -> tuple[int, int] | None:
    m = _URL_MONTH.search(url)
    return (int(m[1]), int(m[2])) if m and url.startswith(f"cds://{DATASET}/") else None


def month_request(ym) -> dict:
    """The CDS request for month `ym`: every day's 00 UTC step, region D1, one unarchived NetCDF."""
    days = month_end(ym).day
    return {
        "variable": [VARIABLE],
        "year": f"{ym[0]:04d}",
        "month": f"{ym[1]:02d}",
        "day": [f"{d:02d}" for d in range(1, days + 1)],
        "time": ["00:00"],
        "data_format": "netcdf",
        "download_format": "unarchived",
        "area": [REGION["n"], REGION["w"], REGION["s"], REGION["e"]],
    }


def request_month(req: dict) -> tuple[int, int] | None:
    """The month a CDS request (ours, as the CDS echoes it back) asks for, or None if it isn't one of ours."""

    def one(v):
        return v[0] if isinstance(v, list) and len(v) == 1 else v

    try:
        if [str(v) for v in (req.get("variable") if isinstance(req.get("variable"), list) else [req.get("variable")])] != [VARIABLE]:
            return None
        if [str(t) for t in (req.get("time") if isinstance(req.get("time"), list) else [req.get("time")])] not in (["00:00"], ["00"]):
            return None
        return int(one(req["year"])), int(one(req["month"]))
    except (KeyError, TypeError, ValueError):
        return None


# --- reading one month's NetCDF --------------------------------------------------


@dataclasses.dataclass
class MonthValues:
    first_day: dt.date
    values: np.ndarray  # float32 mm, (days, ROWS, COLS), south-up
    preliminary: bool | None  # None when the file says nothing about expver

    @property
    def last_day(self) -> dt.date:
        return self.first_day + dt.timedelta(days=self.values.shape[0] - 1)


def _axis_offset(coords, origin: float, count: int, name: str) -> tuple[int, bool]:
    """(index of `origin` in the axis, whether the axis descends)."""
    c = np.asarray(coords, dtype=np.float64)
    if c.size < 2:
        raise ValueError(f"{name} has fewer than two values")
    desc = c[0] > c[-1]
    if desc:
        c = c[::-1]
    if not np.allclose(np.diff(c), STEP, atol=1e-4):
        raise ValueError(f"{name} is not in {STEP} deg steps")
    i0 = round((origin - c[0]) / STEP)
    if i0 < 0 or i0 + count > c.size or abs(c[i0] - origin) > STEP / 4:
        raise ValueError(f"{name} ({c[0]:.3f}..{c[-1]:.3f}) does not hold the region's points from {origin}")
    return i0, desc


def remap(points_mm: np.ndarray) -> np.ndarray:
    """(days, POINT_ROWS, POINT_COLS) south-up points -> (days, ROWS, COLS) cells:
    each cell the mean of its four corner points that have a value, NaN if none do."""
    p = np.asarray(points_mm, dtype=np.float64)
    corners = [p[:, :-1, :-1], p[:, 1:, :-1], p[:, :-1, 1:], p[:, 1:, 1:]]
    total = np.zeros(corners[0].shape)
    count = np.zeros(corners[0].shape)
    for c in corners:
        have = ~np.isnan(c)
        total += np.where(have, c, 0.0)
        count += have
    out = np.full(total.shape, np.nan)
    np.divide(total, count, out=out, where=count > 0)
    return out.astype(np.float32)


def check_plausible(values: np.ndarray, first_day: dt.date, source: str) -> None:
    bad = ~np.isnan(values) & ((values < PLAUSIBLE_MIN_MM) | (values > PLAUSIBLE_MAX_MM))
    if bad.any():
        d, r, c = (int(i) for i in np.argwhere(bad)[0])
        raise ImplausibleValueError(
            f"{source} has {int(bad.sum())} value(s) outside {PLAUSIBLE_MIN_MM:g}-{PLAUSIBLE_MAX_MM:g} mm, the first "
            f"{float(values[d, r, c])} mm on {first_day + dt.timedelta(days=d)} at {ORIGIN['lat'] + r * STEP:.2f}, {ORIGIN['lon'] + c * STEP:.2f}"
        )


def read_month(path: str, ym) -> MonthValues:
    """Month `ym`'s request as the CDS returns it (NetCDF-4: tp(valid_time,
    latitude, longitude) in m), as the copy's daily totals in mm."""
    import xarray as xr

    with xr.open_dataset(path, engine="h5netcdf", decode_times=True, mask_and_scale=True) as ds:
        if "tp" not in ds:
            raise ValueError(f"{path} has no tp variable (got {sorted(ds.data_vars)})")
        tp = ds["tp"]
        units = str(tp.attrs.get("units", "")).strip()
        if units != "m":
            raise ValueError(f"tp is in {units!r}, expected m")
        tp = tp.squeeze([d for d in tp.dims if tp.sizes[d] == 1 and d not in ("latitude", "longitude")], drop=True)
        tname = next((d for d in ("valid_time", "time") if d in tp.dims), None)
        if tname is None or tp.dims != (tname, "latitude", "longitude"):
            raise ValueError(f"tp dims are {tp.dims}, expected (valid_time, latitude, longitude)")
        times = np.asarray(ds[tname].values, dtype="datetime64[s]")
        i0, lat_desc = _axis_offset(ds["latitude"].values, POINT_ORIGIN["lat"], POINT_ROWS, "latitude")
        j0, lon_desc = _axis_offset(ds["longitude"].values, POINT_ORIGIN["lon"], POINT_COLS, "longitude")
        if lon_desc:
            raise ValueError("longitude descends")
        raw = np.array(tp.values, dtype=np.float64)
        expver = None
        if "expver" in ds.variables:
            expver = [str(v.decode() if isinstance(v, bytes) else v).strip() for v in np.atleast_1d(ds["expver"].values)]

    if lat_desc:
        raw = raw[:, ::-1, :]
    points = raw[:, i0 : i0 + POINT_ROWS, j0 : j0 + POINT_COLS]

    steps = [dt.datetime.fromisoformat(str(t)) for t in times]
    if any((s.hour, s.minute, s.second) != (0, 0, 0) for s in steps):
        raise ValueError(f"{path} holds steps other than 00 UTC")
    expected = [dt.date(*ym, d) for d in range(1, month_end(ym).day + 1)]
    if [s.date() for s in steps] != expected:
        raise ValueError(f"{path} holds steps {steps[0].date()}..{steps[-1].date()} ({len(steps)}), not every day of {month_str(ym)} at 00 UTC")

    # Each 00 UTC step is the previous UTC day's total; drop any day before the record.
    days = [s.date() - dt.timedelta(days=1) for s in steps]
    keep = [i for i, d in enumerate(days) if d >= FIRST_DAY]
    points = points[keep]
    mm = points * 1000.0
    mm[(mm < 0) & (mm > -NEGATIVE_NOISE_MM)] = 0.0
    values = remap(mm)
    first_day = days[keep[0]]
    check_plausible(values, first_day, path)
    preliminary = None
    if expver:
        expver = [expver[i] for i in keep] if len(expver) == len(days) else expver
        preliminary = any(v.lstrip("0") != FINAL_EXPVER.lstrip("0") for v in expver)
    return MonthValues(first_day, values, preliminary)


# --- the 0.1 deg finals array ---------------------------------------------------


def _attributes() -> dict:
    return {
        "firstYear": FIRST_YEAR,
        "region": dict(REGION),
        "grid": {"origin": dict(ORIGIN), "step": STEP},
        "attribution": ATTRIBUTION,
    }


def read_finals(root: Path, first_day: dt.date, days: int) -> np.ndarray | None:
    import zarr

    if not (root / PRODUCT / "zarr.json").exists():
        return None
    arr = zarr.open_array(store=zarr.storage.LocalStore(root), path=PRODUCT, mode="r", zarr_format=3)
    out = np.full((days, ROWS, COLS), np.nan, dtype=np.float32)
    for year, d0, d1, off in zarrstore.finals_spans(first_day, days):
        yi = year - arr.attrs["firstYear"]
        if 0 <= yi < arr.shape[0]:
            out[off : off + d1 - d0] = arr[yi, d0:d1]
    return out


def write_finals(root: Path, first_day: dt.date, values: np.ndarray):
    """Write consecutive days into `era5l`'s finals array, (years, 366, 275, 310), chunk (1, 366, 20, 20)."""
    values = np.asarray(values, dtype=np.float32)
    if values.ndim != 3 or values.shape[1:] != (ROWS, COLS):
        raise ValueError(f"values must be (days, {ROWS}, {COLS}), got {values.shape}")
    spans = zarrstore.finals_spans(first_day, values.shape[0])
    years = spans[-1][0] - FIRST_YEAR + 1
    arr = zarrstore._open_or_create(root, PRODUCT, (years, DOYS, ROWS, COLS), FINALS_CHUNKS, ("year", "doy", "lat", "lon"), _attributes())
    if arr.shape[0] < years:
        arr.resize((years, DOYS, ROWS, COLS))
    for year, d0, d1, off in spans:
        if year < FIRST_YEAR:
            raise ValueError(f"{year} is before {PRODUCT}'s first year {FIRST_YEAR}")
        arr[year - FIRST_YEAR, d0:d1] = values[off : off + d1 - d0]
    return arr


def year_prefixes(first_day: dt.date, days: int) -> list[str]:
    return [f"{PRODUCT}/zarr.json", *(f"{PRODUCT}/c/{y - FIRST_YEAR}/" for y, *_ in zarrstore.finals_spans(first_day, days))]


def coverage(files: list[dict]) -> tuple[str, str] | None:
    """(first day, last day) of the contiguous run of months held, from the earliest."""
    months = {ym for f in files if (ym := url_month(f["url"])) is not None}
    if not months:
        return None
    first = min(months)
    last = first
    while next_month(last) in months:
        last = next_month(last)
    return written_days(first)[0].isoformat(), written_days(last)[1].isoformat()


def new_manifest() -> dict:
    m = manifest.new(PRODUCT)
    m["region"] = dict(REGION)
    m["grid"] = {"origin": dict(ORIGIN), "step": STEP}
    return m


def ingest_month(mirror: zarrstore.Mirror, ym, path: Path, now: Callable[[], str] = manifest.utc_now) -> dict:
    """Write one month's request into `era5l` and record it in the manifest (CHIRPS's revision rule)."""
    mv = read_month(str(path), ym)
    days = mv.values.shape[0]
    url = file_url(ym)
    sha = manifest.values_sha256(mv.values)
    m = manifest.read(mirror, PRODUCT) or new_manifest()
    previous = manifest.file_entry(m, url)

    outcome = "unchanged"
    if previous is None or previous["valuesSha256"] != sha:
        with mirror.stage(year_prefixes(mv.first_day, days)) as root:
            old = read_finals(root, mv.first_day, days)
            write_finals(root, mv.first_day, mv.values)
        if previous is None:
            outcome = "added"
        else:
            m["revision"] += 1
            if old is not None and manifest.values_sha256(old) == previous["valuesSha256"]:
                cells, max_abs = chirps_final._diff(old, mv.values)
            else:
                # The copy didn't hold the previous values (a run died between
                # the chunks and the manifest): claim every cell and the widest
                # plausible difference, never 0 (chirps_final.ingest_file says why).
                cells, max_abs = REGION_CELLS, PLAUSIBLE_MAX_MM - PLAUSIBLE_MIN_MM
            m["changes"].append({"revision": m["revision"], "days": [mv.first_day.isoformat(), mv.last_day.isoformat()], "cellsChanged": cells, "maxAbsDiff": max_abs})
            outcome = "changed"

    manifest.upsert_file(m, {"url": url, "etag": None, "lastModified": None, "size": path.stat().st_size, "valuesSha256": sha, "revision": m["revision"], "fetchedAt": now()})
    first, last = m["years"]["first"], m["years"]["last"]
    m["years"] = {"first": min(filter(None, [first, mv.first_day.year])), "last": max(filter(None, [last, mv.last_day.year]))}
    cov = coverage(m["files"])
    m["finalThrough"] = cov[1] if cov else None
    manifest.write(mirror, m)
    return {"month": month_str(ym), "outcome": outcome, "days": [mv.first_day.isoformat(), mv.last_day.isoformat()], "revision": m["revision"], "preliminary": mv.preliminary}


# --- the request state ------------------------------------------------------------


def state_key() -> str:
    return f"ingest-state/{PRODUCT}/requests.json"


def refused_key() -> str:
    return f"ingest-state/{PRODUCT}/refused.json"


_ENTRY = {
    "requestId": None,  # the CDS job in flight, or None
    "submittedAt": None,  # set before the submit: an id-less entry with it is an intent a crash interrupted
    "purpose": None,  # new | recheck | backfill
    "wanted": False,  # a backfill asked for it and it waits for a slot
    "attempts": 0,  # failures since the last success
    "retryAt": None,  # no resubmit before this (ISO UTC)
    "lastError": None,
    "collectedAt": None,
    "preliminary": None,  # the held file's phase: True (ERA5-Land-T), False, or None (unknown)
    "recheckAt": None,  # re-request on or after this day (YYYY-MM-DD)
}


def read_state(mirror) -> tuple[dict, bool]:
    """(the state, whether it existed)."""
    doc = mirror.read_json(state_key())
    if doc is None:
        return {"months": {}}, False
    months = {k: {**_ENTRY, **v} for k, v in (doc.get("months") or {}).items() if _MONTH.match(k)}
    return {"months": months}, True


def write_state(mirror, st: dict) -> None:
    mirror.write_json(state_key(), {"months": {k: st["months"][k] for k in sorted(st["months"])}})


def _iso(t: float) -> str:
    return dt.datetime.fromtimestamp(t, dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _epoch(s: str | None) -> float | None:
    return None if not s else dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.UTC).timestamp()


def backoff_seconds(attempts: int) -> float:
    return min(BACKOFF_BASE_DAYS * 2 ** max(0, attempts - 1), BACKOFF_MAX_DAYS) * 86400.0


def recheck_at(ym, preliminary: bool | None, today: dt.date) -> str | None:
    """When to ask for a held month again: never once it is consolidated."""
    due = month_end(ym) + dt.timedelta(days=RECHECK_AFTER_DAYS)
    if preliminary is False:
        return None
    if preliminary is True:
        return max(due, today + dt.timedelta(days=RECHECK_EVERY_DAYS)).isoformat()
    return due.isoformat() if today < due else None


# --- the CDS clients ------------------------------------------------------------------


class LiveCds:
    """The CDS through ecmwf-datastores-client, with our User-Agent, no
    client-side retry loop, at most one call a second, and a 401/403 raised as
    polite.StopRun. The result is downloaded through polite.PoliteClient."""

    def __init__(self, key: str, contact: str | None = None, url: str = CDS_URL, http: polite.PoliteClient | None = None, sleep=time.sleep, clock=time.monotonic):
        import requests
        from ecmwf.datastores import Client

        ua = polite.user_agent(contact)

        class _Session(requests.Session):
            def request(self, method, url, **kw):
                kw["headers"] = {**(kw.get("headers") or {}), "User-Agent": ua}
                return super().request(method, url, **kw)

        self.client = Client(url=url, key=key, progress=False, maximum_tries=1, retry_after=1, sleep_max=1, timeout=60, session=_Session())
        self.http = http or polite.PoliteClient(contact=contact)
        self.sleep = sleep
        self.clock = clock
        self._last = None

    def _call(self, what: str, fn):
        import requests

        if self._last is not None and (wait := self._last + 1.0 - self.clock()) > 0:
            self.sleep(wait)
        self._last = self.clock()
        try:
            return fn()
        except requests.HTTPError as e:
            status = getattr(e.response, "status_code", None)
            if status in (401, 403):
                raise polite.StopRun(f"{CDS_URL} ({what})", status) from None
            if status == 404:
                return KeyError(what)
            raise CdsError(f"the CDS answered HTTP {status} to {what}") from None

    def submit(self, dataset: str, request: dict) -> str:
        out = self._call("submit", lambda: self.client.submit(dataset, request).request_id)
        if isinstance(out, KeyError):
            raise CdsError(f"the CDS has no dataset {dataset} (404)")
        return out

    def status(self, request_id: str) -> str:
        """accepted | running | successful | failed | rejected | dismissed | deleted | missing (404)."""
        out = self._call("status", lambda: self.client.get_remote(request_id).status)
        return "missing" if isinstance(out, KeyError) else str(out)

    def find(self, dataset: str, ym) -> str | None:
        """Our own request for `ym` still queued or done among the account's recent jobs (state lost)."""
        jobs = self._call("jobs", lambda: self.client.get_jobs(limit=10, sortby="-created", status=["accepted", "running", "successful"]).request_ids)
        if isinstance(jobs, KeyError):
            return None
        for rid in jobs:
            remote = self._call("job", lambda rid=rid: self.client.get_remote(rid))
            if isinstance(remote, KeyError):
                continue
            meta = self._call("job", lambda: (remote.collection_id, remote.request))
            if not isinstance(meta, KeyError) and meta[0] == dataset and request_month(meta[1]) == tuple(ym):
                return rid
        return None

    def download(self, request_id: str, dest: str) -> int:
        results = self._call("results", lambda: self.client.get_results(request_id))
        if isinstance(results, KeyError):
            raise CdsError(f"request {request_id} has no results (404)")
        res = self.http.get(results.location, dest=dest)
        if res.size is not None and res.size != results.content_length:
            raise CdsError(f"request {request_id}: downloaded {res.size} bytes of {results.content_length}")
        return Path(dest).stat().st_size


def read_cds_key(arn: str, client=None) -> str:
    """The CDS API key from Secrets Manager (live mode only). Never logged."""
    if not arn:
        raise RuntimeError("CDS_KEY_SECRET_ARN is not set: live era5l needs the CDS key's secret (docs/deployment.md § ERA5-Land)")
    if client is None:
        import boto3

        client = boto3.client("secretsmanager")
    value = client.get_secret_value(SecretId=arn).get("SecretString") or ""
    value = value.strip()
    if not value:
        raise RuntimeError("the CDS key's secret has no value yet: the operator puts it in (docs/deployment.md § ERA5-Land)")
    return value


# --- one run --------------------------------------------------------------------------


@dataclasses.dataclass
class Run:
    cds: object
    budget: chirps_final.Budget
    today: dt.date
    clock: Callable[[], float] = time.time
    now: Callable[[], str] = manifest.utc_now
    workdir: str | None = None


def _refused_today(mirror, today: dt.date) -> dict | None:
    doc = mirror.read_json(refused_key())
    return doc if doc and doc.get("date") == today.isoformat() else None


def _held_months(m: dict | None) -> dict[tuple[int, int], dict]:
    return {ym: f for f in (m or {}).get("files", []) if (ym := url_month(f["url"]))}


def run(mirror: zarrstore.Mirror, mode: str, month: str | None, r: Run) -> dict:
    with lease.hold(mirror, PRODUCT, r.clock):
        refused = _refused_today(mirror, r.today)
        if refused:
            raise polite.StopRun(f"{CDS_URL} (refused earlier today, {refused.get('status')})", refused.get("status") or 403)
        try:
            return _run(mirror, mode, month, r)
        except polite.StopRun as e:
            mirror.write_json(refused_key(), {"date": r.today.isoformat(), "status": e.status, "at": _iso(r.clock())})
            raise


def _run(mirror, mode, month, r: Run) -> dict:
    st, existed = read_state(mirror)
    months = st["months"]
    held = _held_months(manifest.read(mirror, PRODUCT))
    now = r.clock()
    out = {"collected": [], "submitted": [], "failed": [], "inFlight": 0, "gaveUp": []}

    # A held month the state has no entry for (state lost, or a copy written
    # elsewhere): rebuild its recheck from the manifest.
    for ym, f in held.items():
        e = months.setdefault(month_str(ym), dict(_ENTRY))
        if e["collectedAt"] is None and e["requestId"] is None and e["submittedAt"] is None:
            e["collectedAt"] = f["fetchedAt"]
            e["recheckAt"] = recheck_at(ym, None, dt.datetime.strptime(f["fetchedAt"][:10], "%Y-%m-%d").date())

    # 1. Collect: every request in flight, oldest month first.
    for key in sorted(k for k, e in months.items() if e["requestId"]):
        e = months[key]
        ym = parse_month(key)
        status = r.cds.status(e["requestId"])
        if status in ("accepted", "running"):
            continue
        if status == "successful":
            if not r.budget.allows(0):
                log.info("%s: %s is ready, but too little time is left; the next run collects it", PRODUCT, key)
                continue
            with tempfile.TemporaryDirectory(prefix="era5l-", dir=r.workdir) as tmp:
                path = Path(tmp) / f"era5l-{key}.nc"
                r.cds.download(e["requestId"], str(path))
                res = ingest_month(mirror, ym, path, r.now)
            log.info("%s: %s %s (%s), revision %s", PRODUCT, res["outcome"], key, e["purpose"], res["revision"])
            res["purpose"] = e["purpose"]
            out["collected"].append(res)
            e.update(requestId=None, submittedAt=None, wanted=False, attempts=0, retryAt=None, lastError=None, collectedAt=r.now(), preliminary=res["preliminary"], recheckAt=recheck_at(ym, res["preliminary"], r.today), purpose=None)
            held[ym] = {}
        else:
            e["attempts"] += 1
            e.update(requestId=None, submittedAt=None, lastError=f"the request ended {status}", retryAt=_iso(now + backoff_seconds(e["attempts"])))
            log.warning("%s: the %s request ended %s (attempt %d); resubmitting after %s", PRODUCT, key, status, e["attempts"], e["retryAt"])
            out["failed"].append({"month": key, "status": status, "attempts": e["attempts"], "retryAt": e["retryAt"]})
        write_state(mirror, st)

    # 2. What this run wants, in priority order.
    wanted: list[tuple[tuple[int, int], str]] = []
    if mode == "monthly":
        newest = newest_complete_month(r.today)
        # Catch up at most CATCH_UP_MONTHS after a gap: older months are the backfill's.
        floor = newest
        for _ in range(CATCH_UP_MONTHS - 1):
            floor = prev_month(floor)
        start = max(next_month(max(held)), floor) if held else newest
        ym = start
        while ym <= newest:
            if ym not in held:
                wanted.append((ym, "new"))
            ym = next_month(ym)
        for key in sorted(months):
            e = months[key]
            if parse_month(key) in held and e["recheckAt"] and e["recheckAt"] <= r.today.isoformat():
                wanted.append((parse_month(key), "recheck"))
    else:
        ym = parse_month(month)
        e = months.setdefault(month, dict(_ENTRY))
        if ym not in held:
            e["wanted"] = True
    for key in sorted((k for k, e in months.items() if e["wanted"]), reverse=True):
        if parse_month(key) not in held and (parse_month(key), "new") not in wanted:
            wanted.append((parse_month(key), "backfill"))

    # 3. Submit while slots are free: at most one request per month in flight.
    in_flight = sum(1 for e in months.values() if e["requestId"])
    for ym, purpose in wanted:
        key = month_str(ym)
        e = months.setdefault(key, dict(_ENTRY))
        if e["requestId"]:
            continue
        if e["attempts"] >= MAX_ATTEMPTS:
            out["gaveUp"].append(key)
            continue
        if e["retryAt"] and _epoch(e["retryAt"]) > now:
            continue
        if in_flight >= MAX_IN_FLIGHT:
            break
        rid = None
        if e["submittedAt"] or not existed:
            # An intent a crash interrupted, or the state was lost: is our request already queued?
            rid = r.cds.find(DATASET, ym)
            if rid:
                log.info("%s: adopting the CDS request %s already queued for %s", PRODUCT, rid, key)
        if rid is None:
            e.update(submittedAt=_iso(now), purpose=purpose)
            write_state(mirror, st)  # the intent, before the submit
            try:
                rid = r.cds.submit(DATASET, month_request(ym))
            except CdsError as err:
                e["attempts"] += 1
                e.update(submittedAt=None, lastError=str(err), retryAt=_iso(now + backoff_seconds(e["attempts"])))
                write_state(mirror, st)
                out["failed"].append({"month": key, "status": "submit-error", "attempts": e["attempts"], "retryAt": e["retryAt"]})
                continue
            log.info("%s: submitted %s (%s) as %s", PRODUCT, key, purpose, rid)
        e.update(requestId=rid, submittedAt=e["submittedAt"] or _iso(now), purpose=purpose)
        out["submitted"].append({"month": key, "purpose": purpose, "requestId": rid})
        in_flight += 1
        write_state(mirror, st)

    out["inFlight"] = in_flight
    write_state(mirror, st)
    if out["gaveUp"]:
        raise RequestsFailed(f"{PRODUCT}: the requests for {', '.join(out['gaveUp'])} failed {MAX_ATTEMPTS} times; clear their entries in {state_key()} to try again (ingest/README.md)")
    return out


# --- the handler (lambda_handler.py hands era5l events here) ----------------------------


def validate_event(event, today: dt.date) -> dict:
    if not isinstance(event, dict):
        raise BadEvent("the event must be a JSON object")
    extra = set(event) - {"product", "mode", "month"}
    if extra:
        raise BadEvent(f"unknown event keys: {sorted(extra)}")
    if event.get("product") != PRODUCT:
        raise BadEvent(f"product must be {PRODUCT!r}")
    mode, month = event.get("mode"), event.get("month")
    if mode not in ("monthly", "backfill"):
        raise BadEvent(f"mode must be monthly or backfill, got {mode!r}")
    if mode == "monthly" and month is not None:
        raise BadEvent("a monthly run takes no month")
    if mode == "backfill":
        if not (isinstance(month, str) and _MONTH.match(month)):
            raise BadEvent(f'a backfill names its month ("month": "YYYY-MM"), got {month!r}')
        ym = parse_month(month)
        if ym < FIRST_MONTH:
            raise BadEvent(f"ERA5-Land starts at {month_str(FIRST_MONTH)}, not {month}")
        if ym > newest_complete_month(today):
            raise BadEvent(f"{month} is not complete on the CDS yet (newest {month_str(newest_complete_month(today))})")
    return {"product": PRODUCT, "mode": mode, "month": month}


def lag_days(m: dict | None, today: dt.date) -> int:
    through = dt.date.fromisoformat(m["finalThrough"]) if m and m["finalThrough"] else FIRST_DAY - dt.timedelta(days=1)
    return (today - through).days


def _publish_lag(mirror, metrics, today) -> int:
    value = lag_days(manifest.read(mirror, PRODUCT), today)
    metrics.publish(PRODUCT, value)
    return value


def handler(event, context=None, s3_client=None, metrics=None, cds=None, clock=None, today=None, secrets_client=None):
    """Run one era5l event. `s3_client`, `metrics`, `cds` (a CDS client),
    `clock`, `today` and `secrets_client` are for tests."""
    today_d = (today or (lambda: dt.datetime.now(dt.UTC).date()))()
    ev = validate_event(event, today_d)
    source = os.environ.get("FEED_SOURCE", "fixtures")
    if source not in ("fixtures", "live"):
        raise RuntimeError(f"FEED_SOURCE must be fixtures or live, got {source!r}")
    mirror_url = os.environ.get("MIRROR_URL")
    if not mirror_url:
        raise RuntimeError("MIRROR_URL is not set (file:///abs/path or s3://bucket)")
    mirror = zarrstore.Mirror.from_url(mirror_url, s3_client=s3_client)
    live = source == "live"
    if metrics is None:
        metrics = cloudwatch.CloudWatchSink() if live else cloudwatch.LocalSink()

    try:
        if cds is None:
            if live:
                cds = _LazyLiveCds(lambda: LiveCds(read_cds_key(os.environ.get("CDS_KEY_SECRET_ARN", ""), secrets_client), contact=os.environ.get("INGEST_CONTACT")))
            else:
                import fakecds

                cds = fakecds.FakeCds(variant=os.environ.get("INGEST_FIXTURE_VARIANT") or None, today=today_d)
        r = Run(cds=cds, budget=chirps_final.Budget(context, COLLECT_RESERVE_S), today=today_d, **({"clock": clock} if clock else {}))
        out = run(mirror, ev["mode"], ev["month"], r)
    except lease.MirrorBusy as e:
        lag = _publish_lag(mirror, metrics, today_d)
        if ev["mode"] == "backfill":
            raise
        log.info("%s: %s; the run holding it does this work", PRODUCT, e)
        return _result(ev, source, mirror, {"busy": str(e)}, lag)
    except BaseException:
        try:
            _publish_lag(mirror, metrics, today_d)
        except Exception:
            log.exception("%s: could not publish %s while failing", PRODUCT, cloudwatch.METRIC)
        raise
    lag = _publish_lag(mirror, metrics, today_d)
    return _result(ev, source, mirror, out, lag)


class _LazyLiveCds:
    """Reads the key (and builds the client) only when the run first needs the CDS."""

    def __init__(self, make):
        self._make = make
        self._cds = None

    def __getattr__(self, name):
        if self._cds is None:
            self._cds = self._make()
        return getattr(self._cds, name)


def _result(ev, source, mirror, out, lag) -> dict:
    m = manifest.read(mirror, PRODUCT)
    return {"product": PRODUCT, "mode": ev["mode"], "source": source, "revision": m["revision"] if m else None, "finalThrough": m["finalThrough"] if m else None, "lagDays": lag, **out}
