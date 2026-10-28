"""AgERA5 daily reference evapotranspiration into the copy (issue #604 R5-E):
product `agera5_et0`.

    Copernicus Climate Data Store (CDS), dataset `sis-agrometeorological-indicators`
    (AgERA5 v2.0), variable `reference_evapotranspiration` (FAO-56
    Penman-Monteith, mm/day), area D1.

A current-season evaporation option beside dPET's climatology (docs/model.md
§2.4a, docs/maps.md § Evaporation from the map): the app reads it from the
copy only; nothing here decides how a run uses it.

Licence CC BY 4.0 (Copernicus). Every place the app shows its values carries
`ATTRIBUTION` (docs/data-sources.md § agera5); the array's attributes hold it
too, so a reader of the copy alone still has it.

**One request per month, its calendar days.** AgERA5's days are local days
(00–24 local solar time, its documentation), each stored under its date, so
month M's request asks for M's days and writes exactly them (unlike
ERA5-Land's 00 UTC steps). `finalThrough` is the end of the contiguous run
of held months from the earliest (manifest.agera5_coverage).

**The grid.** AgERA5's 0.1 deg cells are centred on x.x5 deg, the copy's own
cells (index [0, 0] = lat -35.45, lon 10.05; 275 rows x 310 columns): the
values are taken as they are. A file whose points sit on x.x0 deg instead is
remapped as ERA5-Land's are (each cell the mean of its four corner points
that have a value, era5land.remap); any other lattice is refused. Cells are
placed by their coordinates, whatever order the file has.

**The download** is a zip of one NetCDF-4 file a day (AgERA5's usual form) or
a single NetCDF; either way the days must be exactly the month's. Each file
holds one data variable (its exact name in the real files is **unverified
until the first live run**; any single variable is taken) in mm/day
(`UNITS_MM_PER_DAY`; anything else is refused by name).

**Submit on one run, collect on a later one**, the same machinery as
ERA5-Land (cdsjob.py: the request state in `ingest-state/agera5_et0/`, the
intent before the submit, adopting a queued request after a crash, backoff
1–16 days and a loud stop after 5 failures, at most 4 requests queued, a
401/403 that stops the run and the rest of the UTC day, the lease).

**monthly** submits the newest complete month (its last day at least
`AVAILABLE_AFTER_DAYS` old: AgERA5 is about a week behind, **unverified until
the first live run**) and any month between it and the newest held one (at
most `CATCH_UP_MONTHS` back), then re-requests held months whose values may
still change. AgERA5 is built from ERA5, whose newest months are ERA5T,
replaced about two months on; its files don't say which, so a month's phase
is unknown and it is asked for again `RECHECK_AFTER_DAYS` after its end, then
every `RECHECK_EVERY_DAYS`, until `RECHECK_UNKNOWN_CAP_DAYS` after it. The
revision rule is CHIRPS's: a new revision, with a `changes` entry, only when
the values' hash changed.

**backfill** `{"month": "YYYY-MM"}` from 1979-01, as ERA5-Land's.

**Checks:** 0–30 mm/day after placing (a value outside fails the run before
anything is written; packing noise above -`NEGATIVE_NOISE_MM` becomes 0), and
the values hash (manifest.py).

**The key** is ERA5-Land's: the same Copernicus account, so the same secret
(`CDS_KEY_SECRET_ARN`, infra/era5land.tf), read at run time in live mode
only and never logged. Fixtures mode (the default) uses
fakecds.FakeAgera5Cds, which serves fixtures/agera5's synthetic zip.
**MirrorLagDays{Product=agera5_et0}** is published on every exit.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import logging
import zipfile
from pathlib import Path
from typing import Callable

import numpy as np

import cdsjob
import chirps_final
import era5land
import grid
import manifest
import zarrstore

log = logging.getLogger("ingest")

from agera5request import (  # noqa: E402,F401  (re-exported: agera5.DATASET, agera5.month_request, … stay its names)
    DATASET,
    PRODUCT,
    VARIABLE,
    month_days,
    month_request,
    request_month,
)
RUNBOOK = "docs/deployment.md § AgERA5"

#: The product's 0.1 deg grid on region D1, from 1979 (grid.py; backend/src/mirror/grid.ts PRODUCT_GRIDS).
GRID = grid.for_product(PRODUCT)
FIRST_MONTH = (GRID.first_year, 1)
FIRST_DAY = manifest.AGERA5_FIRST_DAY

#: A month's last day is on the CDS this many days after it (AgERA5 is about a week behind; unverified until the first live run).
AVAILABLE_AFTER_DAYS = 10
#: Re-request a month of unknown phase this long after its end (ERA5T is replaced about two months on)...
RECHECK_AFTER_DAYS = 75
#: ...and again this often...
RECHECK_EVERY_DAYS = 30
#: ...until this long after its end, when it counts as final.
RECHECK_UNKNOWN_CAP_DAYS = 180
CATCH_UP_MONTHS = 12
MAX_IN_FLIGHT = 4
BACKOFF_BASE_DAYS = 1
BACKOFF_MAX_DAYS = 16
MAX_ATTEMPTS = 5
COLLECT_RESERVE_S = 180.0
#: Packing noise below 0 down to this (mm) is 0; below it the check fails.
NEGATIVE_NOISE_MM = 0.001

PLAUSIBLE_MIN_MM = 0.0
PLAUSIBLE_MAX_MM = 30.0

UNITS_MM_PER_DAY = frozenset({"mm d-1", "mm day-1", "mm/day", "mm/d", "mm day^-1", "mm d^-1", "mm.d-1", "mm"})

ATTRIBUTION = (
    "Contains modified Copernicus Climate Change Service information [year]. "
    "Neither the European Commission nor ECMWF is responsible for any use that may be made of the Copernicus information or data it contains. "
    "Boogaard, H., Schubert, J., De Wit, A., Lazebnik, J., Hutjes, R., Van der Grijn, G. (2020): Agrometeorological indicators from 1979 to present derived from reanalysis. "
    "Copernicus Climate Change Service (C3S) Climate Data Store (CDS). DOI: 10.24381/cds.6c68c9bb"
)

#: The attribute the finals array carries beside zarrstore's own: the credit travels with the values.
ARRAY_ATTRS = {"attribution": ATTRIBUTION}

BadEvent = cdsjob.BadEvent
RequestsFailed = cdsjob.RequestsFailed
CdsError = cdsjob.CdsError


class ImplausibleValueError(ValueError):
    """A value outside 0-30 mm/day: stop before writing."""


class AgEra5FormatError(ValueError):
    """The download isn't laid out as this job expects: refuse rather than guess."""


# --- months --------------------------------------------------------------------------

month_str = cdsjob.month_str
parse_month = cdsjob.parse_month
month_end = cdsjob.month_end


def newest_complete_month(today: dt.date) -> tuple[int, int]:
    """The newest month whose last day the CDS should hold by `today`."""
    ym = cdsjob.prev_month((today.year, today.month))
    while month_end(ym) + dt.timedelta(days=AVAILABLE_AFTER_DAYS) > today:
        ym = cdsjob.prev_month(ym)
    return ym


def file_url(ym) -> str:
    """The manifest's `url` for a month's request: what was asked, not the (expiring) download link."""
    return f"cds://{DATASET}/{VARIABLE}/{month_str(ym)}"


def url_month(url: str) -> tuple[int, int] | None:
    return manifest.agera5_file_month(url)



# --- reading one month's download -------------------------------------------------------


@dataclasses.dataclass
class MonthValues:
    first_day: dt.date
    values: np.ndarray  # float32 mm/day, (days, GRID.rows, GRID.cols), south-up
    preliminary: bool | None  # AgERA5's files say nothing about ERA5T: always None

    @property
    def last_day(self) -> dt.date:
        return self.first_day + dt.timedelta(days=self.values.shape[0] - 1)


def _lattice(coords: np.ndarray, edge: float) -> str:
    """'centres' when the points sit on x.x5 deg (the copy's cells), 'corners' on x.x0 deg."""
    frac = np.mod(np.round((np.asarray(coords, dtype=np.float64) - edge) / GRID.step, 4), 1.0)
    if np.allclose(frac, 0.5, atol=0.02):
        return "centres"
    if np.allclose(np.minimum(frac, 1.0 - frac), 0.0, atol=0.02):
        return "corners"
    raise AgEra5FormatError("the points are on neither a x.x5 nor a x.x0 deg lattice")


def _offset(coords, origin: float, count: int, name: str) -> tuple[int, bool]:
    """(index of `origin` in the axis, whether the axis descends)."""
    try:
        return era5land._axis_offset(coords, origin, count, name)
    except ValueError as e:
        raise AgEra5FormatError(str(e)) from None


def _read_one(path_or_bytes) -> tuple[list[dt.date], np.ndarray, np.ndarray, np.ndarray]:
    """(days, values (days, lat, lon) as in the file, lats, lons) of one NetCDF."""
    import io

    import xarray as xr

    src = io.BytesIO(path_or_bytes) if isinstance(path_or_bytes, bytes) else path_or_bytes
    with xr.open_dataset(src, engine="h5netcdf", decode_times=True, mask_and_scale=True) as ds:
        names = [n for n, v in ds.data_vars.items() if v.ndim >= 2]
        if len(names) != 1:
            raise AgEra5FormatError(f"expected one data variable, got {sorted(names)}")
        var = ds[names[0]]
        units = str(var.attrs.get("units", "")).strip()
        if units not in UNITS_MM_PER_DAY:
            raise AgEra5FormatError(f"{names[0]} is in {units!r}, expected mm/day (one of {sorted(UNITS_MM_PER_DAY)})")
        lat = next((d for d in ("lat", "latitude") if d in var.dims), None)
        lon = next((d for d in ("lon", "longitude") if d in var.dims), None)
        tname = next((d for d in ("time", "valid_time") if d in var.dims), None)
        if lat is None or lon is None or tname is None or var.dims != (tname, lat, lon):
            raise AgEra5FormatError(f"{names[0]} dims are {var.dims}, expected (time, lat, lon)")
        times = np.asarray(ds[tname].values, dtype="datetime64[D]")
        days = [dt.date.fromisoformat(str(t)) for t in times]
        return days, np.array(var.values, dtype=np.float64), np.asarray(ds[lat].values, dtype=np.float64), np.asarray(ds[lon].values, dtype=np.float64)


def _place(raw: np.ndarray, lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
    """(days, lat, lon) as in the file -> (days, GRID.rows, GRID.cols) south-up cells."""
    kind = _lattice(lats, grid.REGION["s"])
    if _lattice(lons, grid.REGION["w"]) != kind:
        raise AgEra5FormatError("latitude and longitude are on different lattices")
    if kind == "centres":
        origin, rows, cols = GRID.origin, GRID.rows, GRID.cols
    else:
        origin, rows, cols = {"lat": grid.REGION["s"], "lon": grid.REGION["w"]}, GRID.rows + 1, GRID.cols + 1
    i0, lat_desc = _offset(lats, origin["lat"], rows, "latitude")
    j0, lon_desc = _offset(lons, origin["lon"], cols, "longitude")
    if lat_desc:
        raw = raw[:, ::-1, :]
    if lon_desc:
        raw = raw[:, :, ::-1]
    pts = raw[:, i0 : i0 + rows, j0 : j0 + cols]
    return pts.astype(np.float32) if kind == "centres" else era5land.remap(pts)


def check_plausible(values: np.ndarray, first_day: dt.date, source: str) -> None:
    bad = ~np.isnan(values) & ((values < PLAUSIBLE_MIN_MM) | (values > PLAUSIBLE_MAX_MM))
    if bad.any():
        d, r, c = (int(i) for i in np.argwhere(bad)[0])
        raise ImplausibleValueError(
            f"{source} has {int(bad.sum())} value(s) outside {PLAUSIBLE_MIN_MM:g}-{PLAUSIBLE_MAX_MM:g} mm/day, the first "
            f"{float(values[d, r, c])} mm on {first_day + dt.timedelta(days=d)} at {GRID.origin['lat'] + r * GRID.step:.2f}, {GRID.origin['lon'] + c * GRID.step:.2f}"
        )


def read_month(path: str, ym) -> MonthValues:
    """Month `ym`'s download (a zip of daily NetCDF files, or one NetCDF) as the copy's daily ET0 in mm."""
    parts: list[tuple[list[dt.date], np.ndarray, np.ndarray, np.ndarray]] = []
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            names = sorted(n for n in z.namelist() if n.endswith(".nc"))
            if not names:
                raise AgEra5FormatError(f"{path} is a zip with no .nc file")
            parts = [_read_one(z.read(n)) for n in names]
    else:
        parts = [_read_one(path)]
    by_day: dict[dt.date, np.ndarray] = {}
    for days, raw, lats, lons in parts:
        placed = _place(raw, lats, lons)
        for k, d in enumerate(days):
            if d in by_day:
                raise AgEra5FormatError(f"{path} holds {d} twice")
            by_day[d] = placed[k]
    expected = month_days(ym)
    if sorted(by_day) != expected:
        got = sorted(by_day)
        raise AgEra5FormatError(f"{path} holds {got[0] if got else '-'}..{got[-1] if got else '-'} ({len(got)} days), not every day of {month_str(ym)}")
    values = np.stack([by_day[d] for d in expected]).astype(np.float32)
    values[(values < 0) & (values > -NEGATIVE_NOISE_MM)] = 0.0
    check_plausible(values, expected[0], path)
    return MonthValues(expected[0], values, None)


# --- the 0.1 deg finals array ---------------------------------------------------------


def coverage(files: list[dict]) -> tuple[str, str] | None:
    return manifest.agera5_coverage(files)


def ingest_month(mirror: zarrstore.Mirror, ym, path: Path, now: Callable[[], str] = manifest.utc_now) -> dict:
    """Write one month's request into `agera5_et0` and record it in the manifest (CHIRPS's revision rule)."""
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
                # The copy didn't hold the previous values: claim every cell and the widest plausible difference.
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


# --- the run (cdsjob.py) ------------------------------------------------------------------


def state_key() -> str:
    return cdsjob.state_key(PRODUCT)


def refused_key() -> str:
    return cdsjob.refused_key(PRODUCT)


def backoff_seconds(attempts: int) -> float:
    return cdsjob.backoff_seconds(attempts, BACKOFF_BASE_DAYS, BACKOFF_MAX_DAYS)


def recheck_at(ym, preliminary: bool | None, today: dt.date) -> str | None:
    return cdsjob.recheck_at(ym, preliminary, today, RECHECK_AFTER_DAYS, RECHECK_EVERY_DAYS, RECHECK_UNKNOWN_CAP_DAYS)


def read_cds_key(arn: str, client=None) -> str:
    return cdsjob.read_cds_key(arn, client, PRODUCT, RUNBOOK)


def validate_event(event, today: dt.date) -> dict:
    return cdsjob.validate_month_event(event, today, PRODUCT, FIRST_MONTH, newest_complete_month, "AgERA5")


def lag_days(m: dict | None, today: dt.date) -> int:
    through = dt.date.fromisoformat(m["finalThrough"]) if m and m["finalThrough"] else FIRST_DAY - dt.timedelta(days=1)
    return (today - through).days


def _fake(variant, today):
    import fakecds

    return fakecds.FakeAgera5Cds(variant=variant, today=today)


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


def run(mirror: zarrstore.Mirror, mode: str, month: str | None, r: cdsjob.Run) -> dict:
    return cdsjob.run(SPEC, mirror, mode, month, r)


def handler(event, context=None, s3_client=None, metrics=None, cds=None, clock=None, today=None, secrets_client=None):
    """Run one agera5_et0 event. `s3_client`, `metrics`, `cds`, `clock`, `today` and `secrets_client` are for tests."""
    return cdsjob.handle(SPEC, event, context, s3_client=s3_client, metrics=metrics, cds=cds, clock=clock, today=today, secrets_client=secrets_client)

