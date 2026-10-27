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
`RECHECK_EVERY_DAYS` while it stays preliminary. A month whose phase stays
unknown (a file without `expver`) is asked for every `RECHECK_EVERY_DAYS`
too, until a read says it is consolidated or `RECHECK_UNKNOWN_CAP_DAYS`
after its end: without `expver` the copy cannot tell ERA5-Land-T from
ERA5-Land, so it keeps asking through the window in which ECMWF replaces
ERA5-Land-T (about two months, so 180 days leaves room for a late
consolidation) and then treats the month as final. The revision rule is
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
from pathlib import Path
from typing import Callable

import numpy as np

import cdsjob
import chirps_final
import grid
import manifest
import zarrstore

log = logging.getLogger("ingest")

PRODUCT = "era5l"
DATASET = "reanalysis-era5-land"
VARIABLE = "total_precipitation"
CDS_URL = cdsjob.CDS_URL
RUNBOOK = "docs/deployment.md § ERA5-Land"

#: The product's 0.1 deg grid on region D1, from 1950 (grid.py; backend/src/mirror/grid.ts PRODUCT_GRIDS).
GRID = grid.for_product(PRODUCT)
#: ERA5-Land's points over the region: on x.x0 deg (the region's edges), one more each way than the cells.
POINT_ORIGIN = {"lat": grid.REGION["s"], "lon": grid.REGION["w"]}
POINT_ROWS = GRID.rows + 1
POINT_COLS = GRID.cols + 1

FIRST_MONTH = (GRID.first_year, 1)
FIRST_DAY = manifest.ERA5L_FIRST_DAY

#: A month's last 00 UTC step is on the CDS this many days after it (ERA5-Land-T is ~5 days behind).
AVAILABLE_AFTER_DAYS = 6
#: Re-request a preliminary (or unknown) month this long after its end (the consolidated data are ~2 months behind)...
RECHECK_AFTER_DAYS = 75
#: ...and again this often while it stays preliminary (or unknown).
RECHECK_EVERY_DAYS = 30
#: A month whose files never say their phase (no `expver`) stops being rechecked this long after its end:
#: ERA5-Land replaces ERA5-Land-T about two months on, so 180 days covers a late consolidation with room to spare.
RECHECK_UNKNOWN_CAP_DAYS = 180
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

_MONTH = cdsjob.MONTH_RE


BadEvent = cdsjob.BadEvent
RequestsFailed = cdsjob.RequestsFailed
CdsError = cdsjob.CdsError


class ImplausibleValueError(ValueError):
    """A value outside 0-2000 mm after the remap: stop before writing."""


# --- months and days ----------------------------------------------------------


month_str = cdsjob.month_str
parse_month = cdsjob.parse_month
next_month = cdsjob.next_month
prev_month = cdsjob.prev_month
month_end = cdsjob.month_end


def written_days(ym) -> tuple[dt.date, dt.date]:
    """The days month `ym`'s request writes: the totals its 00 UTC steps hold (manifest.era5l_written_days)."""
    return manifest.era5l_written_days(tuple(ym))


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
    """The month a manifest file's URL (file_url) names: manifest.era5l_file_month."""
    return manifest.era5l_file_month(url)


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
        "area": [grid.REGION["n"], grid.REGION["w"], grid.REGION["s"], grid.REGION["e"]],
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
    values: np.ndarray  # float32 mm, (days, GRID.rows, GRID.cols), south-up
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
    step = GRID.step
    if not np.allclose(np.diff(c), step, atol=1e-4):
        raise ValueError(f"{name} is not in {step} deg steps")
    i0 = round((origin - c[0]) / step)
    if i0 < 0 or i0 + count > c.size or abs(c[i0] - origin) > step / 4:
        raise ValueError(f"{name} ({c[0]:.3f}..{c[-1]:.3f}) does not hold the region's points from {origin}")
    return i0, desc


def remap(points_mm: np.ndarray) -> np.ndarray:
    """(days, POINT_ROWS, POINT_COLS) south-up points -> (days, GRID.rows, GRID.cols) cells:
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
            f"{float(values[d, r, c])} mm on {first_day + dt.timedelta(days=d)} at {GRID.origin['lat'] + r * GRID.step:.2f}, {GRID.origin['lon'] + c * GRID.step:.2f}"
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


#: The attribute the finals array carries beside zarrstore's own (firstYear, region, grid): the credit travels with the values.
ARRAY_ATTRS = {"attribution": ATTRIBUTION}


def coverage(files: list[dict]) -> tuple[str, str] | None:
    """(first day, last day) of the contiguous run of days the months held write (manifest.era5l_coverage)."""
    return manifest.era5l_coverage(files)


def ingest_month(mirror: zarrstore.Mirror, ym, path: Path, now: Callable[[], str] = manifest.utc_now) -> dict:
    """Write one month's request into `era5l` and record it in the manifest (CHIRPS's revision rule)."""
    mv = read_month(str(path), ym)
    days = mv.values.shape[0]
    url = file_url(ym)
    sha = manifest.values_sha256(mv.values)
    m = manifest.read(mirror, PRODUCT) or manifest.new(PRODUCT)
    previous = manifest.file_entry(m, url)

    outcome = "unchanged"
    if previous is None or previous["valuesSha256"] != sha:
        with mirror.stage(zarrstore.finals_year_prefixes(PRODUCT, mv.first_day, days)) as root:
            old = zarrstore.read_finals(root, PRODUCT, mv.first_day, days)
            zarrstore.write_finals(root, PRODUCT, mv.first_day, mv.values, attrs=ARRAY_ATTRS)
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
                cells, max_abs = GRID.rows * GRID.cols, PLAUSIBLE_MAX_MM - PLAUSIBLE_MIN_MM
            m["changes"].append({"revision": m["revision"], "days": [mv.first_day.isoformat(), mv.last_day.isoformat()], "cellsChanged": cells, "maxAbsDiff": max_abs})
            outcome = "changed"

    manifest.upsert_file(m, {"url": url, "etag": None, "lastModified": None, "size": path.stat().st_size, "valuesSha256": sha, "revision": m["revision"], "fetchedAt": now()})
    first, last = m["years"]["first"], m["years"]["last"]
    m["years"] = {"first": min(filter(None, [first, mv.first_day.year])), "last": max(filter(None, [last, mv.last_day.year]))}
    cov = coverage(m["files"])
    m["finalThrough"] = cov[1] if cov else None
    manifest.write(mirror, m)
    return {"month": month_str(ym), "outcome": outcome, "days": [mv.first_day.isoformat(), mv.last_day.isoformat()], "revision": m["revision"], "preliminary": mv.preliminary}


# --- the request state and the run: cdsjob.py, shared with agera5.py ---------------


def state_key() -> str:
    return cdsjob.state_key(PRODUCT)


def refused_key() -> str:
    return cdsjob.refused_key(PRODUCT)


_ENTRY = cdsjob.ENTRY


def read_state(mirror) -> tuple[dict, bool]:
    """(the state, whether it existed)."""
    return cdsjob.read_state(mirror, PRODUCT)


def write_state(mirror, st: dict) -> None:
    cdsjob.write_state(mirror, PRODUCT, st)


_iso = cdsjob._iso
_epoch = cdsjob._epoch


def backoff_seconds(attempts: int) -> float:
    return cdsjob.backoff_seconds(attempts, BACKOFF_BASE_DAYS, BACKOFF_MAX_DAYS)


def recheck_at(ym, preliminary: bool | None, today: dt.date) -> str | None:
    """When to ask for a held month again: never once it is consolidated.
    A preliminary month: from RECHECK_AFTER_DAYS after its end, then every
    RECHECK_EVERY_DAYS. A month of unknown phase (no `expver`): the same, but
    not past RECHECK_UNKNOWN_CAP_DAYS after its end, when it counts as final."""
    return cdsjob.recheck_at(ym, preliminary, today, RECHECK_AFTER_DAYS, RECHECK_EVERY_DAYS, RECHECK_UNKNOWN_CAP_DAYS)


# --- the CDS clients ------------------------------------------------------------------

LiveCds = cdsjob.LiveCds
_LazyLiveCds = cdsjob.LazyLiveCds
Run = cdsjob.Run


def read_cds_key(arn: str, client=None) -> str:
    """The CDS API key from Secrets Manager (live mode only). Never logged."""
    return cdsjob.read_cds_key(arn, client, PRODUCT, RUNBOOK)


# --- one run --------------------------------------------------------------------------


def _fake(variant, today):
    import fakecds

    return fakecds.FakeCds(variant=variant, today=today)


# Every callable goes through this module's globals at call time, so a test that patches one sees it.
SPEC = cdsjob.CdsProduct(
    product=PRODUCT,
    dataset=DATASET,
    runbook=RUNBOOK,
    newest_complete_month=lambda today: newest_complete_month(today),
    month_request=lambda ym: month_request(ym),
    request_month=lambda req: request_month(req),
    url_month=lambda url: url_month(url),
    ingest_month=lambda *a, **kw: ingest_month(*a, **kw),
    recheck_at=lambda ym, p, today: recheck_at(ym, p, today),
    backoff_seconds=lambda attempts: backoff_seconds(attempts),
    validate_event=lambda event, today: validate_event(event, today),
    lag_days=lambda m, today: lag_days(m, today),
    fake=lambda variant, today: _fake(variant, today),
    max_in_flight=MAX_IN_FLIGHT,
    max_attempts=MAX_ATTEMPTS,
    catch_up_months=CATCH_UP_MONTHS,
    collect_reserve_s=COLLECT_RESERVE_S,
)


def run(mirror: zarrstore.Mirror, mode: str, month: str | None, r: Run) -> dict:
    return cdsjob.run(SPEC, mirror, mode, month, r)


# --- the handler (lambda_handler.py hands era5l events here) ----------------------------


def validate_event(event, today: dt.date) -> dict:
    return cdsjob.validate_month_event(event, today, PRODUCT, FIRST_MONTH, newest_complete_month, "ERA5-Land")


def lag_days(m: dict | None, today: dt.date) -> int:
    through = dt.date.fromisoformat(m["finalThrough"]) if m and m["finalThrough"] else FIRST_DAY - dt.timedelta(days=1)
    return (today - through).days


def handler(event, context=None, s3_client=None, metrics=None, cds=None, clock=None, today=None, secrets_client=None):
    """Run one era5l event. `s3_client`, `metrics`, `cds` (a CDS client),
    `clock`, `today` and `secrets_client` are for tests."""
    return cdsjob.handle(SPEC, event, context, s3_client=s3_client, metrics=metrics, cds=cds, clock=clock, today=today, secrets_client=secrets_client)
