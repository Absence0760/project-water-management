"""NASA POWER's daily meteorology, as FAO-56 reference evapotranspiration, into
the copy (issue #604 R5-E): product `power_et0`, the fallback for AgERA5's
`agera5_et0` on the days AgERA5 doesn't hold yet (its newest month waits for
the month's end plus about ten days; POWER is 2–7 days behind).

**Source.** NASA Prediction of Worldwide Energy Resources (POWER), the daily
**regional** API, `https://power.larc.nasa.gov/api/temporal/daily/regional`,
community AG, JSON, local solar time days. Licence CC BY 4.0 ("no restrictions
on the use, access and download", with a request to cite the project;
docs/data-sources.md § nasa-power). No key, no sign-in.

**POWER publishes no reference ET**, so we compute it (fao56.py, FAO-56
Penman-Monteith, eq. 6) from six of its daily parameters: `T2M_MAX`,
`T2M_MIN`, `T2MDEW` (°C), `WS2M` (m/s), `ALLSKY_SFC_SW_DWN` (MJ m-2 day-1 in
the AG community) and `PS` (kPa), each point's latitude from the response.
A point-day where any of them is POWER's fill value (`header.fill_value`,
-999) or missing is NaN.

**The requests.** POWER's regional endpoint takes **one parameter a
request**, so a run asks for each of the six parameters over each tile of
region D1, tiles of at most `TILE_MAX_DEG` (10) degrees a side, cut evenly
(4 x 3 = 12 tiles): 72 requests, each for the whole window of days, at most
one a second through polite.PoliteClient (our User-Agent with the contact,
`Retry-After` on 429/503). **A 403 (or 401) stops the run** and writes a
same-day refused marker (`ingest-state/power_et0/refused.json`), so no other
run that UTC day knocks again; there is no retry. **POWER's exact regional
limits (largest box, whether `time-standard` applies to a regional request)
are unverified until the first live run**: the tile size is a constant, and
POWER's JSON shape is checked strictly, so a different answer fails loudly
rather than being misread.

**The grid.** POWER's points (0.5 deg for its meteorology) are placed by the
coordinates each response gives, never assumed. They must form a regular
lattice (every latitude with every longitude); each 0.1 deg copy cell takes
the ET0 of the POWER point nearest its centre, along each axis, and a cell
more than half a spacing beyond the outermost points is NaN. So 25 copy cells
share one POWER value: this is a coarse fallback, labelled as such wherever
it shows.

**The copy.** Daily layout (zarrstore.write_daily), 0.1 deg (grid.TENTH),
array `firstDay` 1981-01-01, attribute `attribution` (`ATTRIBUTION`). The
manifest (`power_et0/manifest.json`): `finalThrough` always null,
`prelimThrough` the newest held day, one `files` entry a day with url
`power://temporal/daily/regional/fao56-et0/YYYY-MM-DD` (no ETag or
Last-Modified: a day is computed from 72 responses). The held days are
exactly the days a file names, each on its own (as imerg_late's).

**A run** (`{"product": "power_et0", "mode": "recent", "days": N}`, N 1–60,
default 30, daily):
1. A refusal earlier this UTC day ends the run before any request.
2. The product's lease (lease.py).
3. Days older than `KEEP_DAYS` (120) are dropped: out of the manifest first,
   then their chunks.
4. The window is the N days ending `LAG_DAYS` (3) before today. Every run
   reads the whole window again: POWER revises recent days as its sources
   catch up. If the Lambda's time runs short before all 72 responses are in,
   nothing is written and the next run starts over.
5. Per day: ET0, the 0–30 mm check, the values hash (D8). A day with no value
   anywhere (POWER doesn't have it yet) is skipped, not held. A new day is an
   addition; a held day whose values changed bumps the revision with a
   `changes` entry; the same values only move `fetchedAt`.

**MirrorLagDays{Product=power_et0}** on every exit once the event is valid
and the copy reachable: today minus `prelimThrough`, or `LAG_DAYS +
RECENT_DAYS + 1` when nothing is held.

Fixtures mode: power_fixture.FakePower answers in POWER's JSON shape with
synthetic values; no network.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import json
import logging
import math
import os
import shutil
import urllib.parse

import numpy as np

import chirps_final
import cloudwatch
import fao56
import grid
import lease
import manifest
import polite
import zarrstore

log = logging.getLogger("ingest")

PRODUCT = "power_et0"
MODES = ("recent",)
BASE = "https://power.larc.nasa.gov/api/temporal/daily/regional"
COMMUNITY = "AG"
#: Each parameter and the units the AG community's JSON gives it.
PARAMETERS = {"T2M_MAX": "C", "T2M_MIN": "C", "T2MDEW": "C", "WS2M": "m/s", "ALLSKY_SFC_SW_DWN": "MJ/m^2/day", "PS": "kPa"}
TILE_MAX_DEG = 10.0
GRID = grid.for_product(PRODUCT)
ARRAY_FIRST_DAY = dt.date(1981, 1, 1)
#: POWER's newest day is about this many days old (2–7 days, its documentation).
LAG_DAYS = 3
RECENT_DAYS = 30
MAX_DAYS = 60
KEEP_DAYS = 120
#: Don't start a request with less than this left (the write of up to 60 days takes about a minute).
REQUEST_RESERVE_S = 120.0
PLAUSIBLE_MIN_MM = 0.0
PLAUSIBLE_MAX_MM = 30.0
URL_PREFIX = "power://temporal/daily/regional/fao56-et0/"

ATTRIBUTION = "NASA Prediction of Worldwide Energy Resources (POWER) Project, CC BY 4.0; FAO-56 Penman-Monteith reference evapotranspiration computed by us from its daily meteorology"
ARRAY_ATTRS = {"attribution": ATTRIBUTION}


class BadEvent(ValueError):
    pass


class PowerFormatError(ValueError):
    """POWER's answer isn't the JSON this job expects: refuse rather than misread."""


class ImplausibleValueError(ValueError):
    """An ET0 outside 0–30 mm/day: stop before writing."""


class Refused(polite.StopRun):
    """A 403, or a 401: stop, mark the day, never retry."""


def refused_key() -> str:
    return f"ingest-state/{PRODUCT}/refused.json"


def array_key() -> str:
    return f"{PRODUCT}/zarr.json"


def day_url(day: dt.date) -> str:
    return f"{URL_PREFIX}{day.isoformat()}"


def validate_event(event) -> dict:
    if not isinstance(event, dict):
        raise BadEvent("the event must be a JSON object")
    extra = set(event) - {"product", "mode", "days"}
    if extra:
        raise BadEvent(f"unknown event keys: {sorted(extra)}")
    if event.get("product") != PRODUCT:
        raise BadEvent(f"product must be {PRODUCT!r}")
    if event.get("mode") not in MODES:
        raise BadEvent(f"mode must be one of {MODES}, got {event.get('mode')!r}")
    days = event.get("days", RECENT_DAYS)
    if not isinstance(days, int) or isinstance(days, bool) or not 1 <= days <= MAX_DAYS:
        raise BadEvent(f"days must be a whole number 1–{MAX_DAYS}, got {days!r}")
    return {"product": PRODUCT, "mode": event["mode"], "days": days}


# --- the requests ---------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class Tile:
    s: float
    n: float
    w: float
    e: float


def tiles(region: dict = grid.REGION, size: float = TILE_MAX_DEG) -> list[Tile]:
    """Region D1 cut evenly into tiles of at most `size` degrees a side, south-west first."""
    ny = math.ceil(round((region["n"] - region["s"]) / size, 9))
    nx = math.ceil(round((region["e"] - region["w"]) / size, 9))
    dy = (region["n"] - region["s"]) / ny
    dx = (region["e"] - region["w"]) / nx
    r = lambda x: round(x, 4)  # noqa: E731
    return [Tile(r(region["s"] + a * dy), r(region["s"] + (a + 1) * dy), r(region["w"] + b * dx), r(region["w"] + (b + 1) * dx)) for a in range(ny) for b in range(nx)]


def request_url(parameter: str, tile: Tile, start: dt.date, end: dt.date) -> str:
    q = {
        "parameters": parameter,
        "community": COMMUNITY,
        "latitude-min": f"{tile.s:g}",
        "latitude-max": f"{tile.n:g}",
        "longitude-min": f"{tile.w:g}",
        "longitude-max": f"{tile.e:g}",
        "start": f"{start:%Y%m%d}",
        "end": f"{end:%Y%m%d}",
        "format": "JSON",
        "time-standard": "LST",
    }
    return f"{BASE}?{urllib.parse.urlencode(q)}"


def parse_response(body: bytes, parameter: str, days: list[dt.date]) -> dict[tuple[float, float], np.ndarray]:
    """{(lat, lon): values per day (NaN for fill or missing)} for one parameter's regional JSON."""
    try:
        doc = json.loads(body)
    except ValueError:
        raise PowerFormatError(f"POWER's answer for {parameter} is not JSON") from None
    if not isinstance(doc, dict) or doc.get("type") != "FeatureCollection" or not isinstance(doc.get("features"), list):
        raise PowerFormatError(f"POWER's answer for {parameter} is not a FeatureCollection")
    fill = (doc.get("header") or {}).get("fill_value", -999)
    units = ((doc.get("parameters") or {}).get(parameter) or {}).get("units")
    if units is not None and units != PARAMETERS[parameter]:
        raise PowerFormatError(f"POWER gives {parameter} in {units!r}, expected {PARAMETERS[parameter]!r}")
    keys = [f"{d:%Y%m%d}" for d in days]
    out: dict[tuple[float, float], np.ndarray] = {}
    for f in doc["features"]:
        try:
            lon, lat = (float(x) for x in f["geometry"]["coordinates"][:2])
            series = f["properties"]["parameter"][parameter]
        except (KeyError, TypeError, ValueError, IndexError):
            raise PowerFormatError(f"a feature of POWER's answer for {parameter} has no point or no {parameter}") from None
        v = np.array([series.get(k, np.nan) if isinstance(series.get(k), (int, float)) else np.nan for k in keys], dtype=np.float64)
        v[v == fill] = np.nan
        out[(round(lat, 4), round(lon, 4))] = v
    return out


# --- ET0 and placement --------------------------------------------------------------------


def point_et0(fields: dict[str, dict[tuple[float, float], np.ndarray]], days: list[dt.date]) -> dict[tuple[float, float], np.ndarray]:
    """ET0 per point and day, mm; NaN where any input is missing."""
    points = set.intersection(*(set(f) for f in fields.values())) if fields else set()
    doy = np.array([d.timetuple().tm_yday for d in days])
    out = {}
    for p in points:
        get = lambda k: fields[k][p]  # noqa: E731
        out[p] = fao56.et0(get("T2M_MAX"), get("T2M_MIN"), get("T2MDEW"), get("WS2M"), get("ALLSKY_SFC_SW_DWN"), get("PS"), p[0], doy)
    return out


def _nearest(axis: np.ndarray, centres: np.ndarray) -> np.ndarray:
    """Index into `axis` (ascending) of the point nearest each centre; -1 beyond half a spacing past either end."""
    idx = np.abs(centres[:, None] - axis[None, :]).argmin(axis=1)
    half = (np.min(np.diff(axis)) / 2.0 if axis.size > 1 else 0.25) + 1e-6
    idx[np.abs(axis[idx] - centres) > half] = -1
    return idx


def place(points: dict[tuple[float, float], np.ndarray], ndays: int) -> np.ndarray:
    """(ndays, GRID.rows, GRID.cols) south-up: each cell the nearest POWER point's value."""
    out = np.full((ndays, GRID.rows, GRID.cols), np.nan, dtype=np.float32)
    if not points:
        return out
    lats = np.array(sorted({p[0] for p in points}))
    lons = np.array(sorted({p[1] for p in points}))
    if len(points) != lats.size * lons.size:
        raise PowerFormatError(f"POWER's points are not a regular lattice ({len(points)} points, {lats.size} latitudes x {lons.size} longitudes)")
    cube = np.stack([np.stack([points[(la, lo)] for lo in lons]) for la in lats])  # (lat, lon, day)
    ri = _nearest(lats, GRID.origin["lat"] + GRID.step * np.arange(GRID.rows))
    ci = _nearest(lons, GRID.origin["lon"] + GRID.step * np.arange(GRID.cols))
    rows_ok, cols_ok = ri >= 0, ci >= 0
    sub = cube[np.ix_(ri[rows_ok], ci[cols_ok])]  # (rows, cols, day)
    block = np.moveaxis(sub, 2, 0).astype(np.float32)
    out[:, np.flatnonzero(rows_ok)[:, None], np.flatnonzero(cols_ok)[None, :]] = block
    return out


def check_plausible(values: np.ndarray, day: dt.date) -> None:
    bad = ~np.isnan(values) & ((values < PLAUSIBLE_MIN_MM) | (values > PLAUSIBLE_MAX_MM))
    if bad.any():
        r, c = (int(i) for i in np.argwhere(bad)[0])
        raise ImplausibleValueError(
            f"POWER's ET0 has {int(bad.sum())} value(s) outside {PLAUSIBLE_MIN_MM:g}–{PLAUSIBLE_MAX_MM:g} mm/day, the first {float(values[r, c])} mm on {day} at "
            f"{GRID.origin['lat'] + r * GRID.step:.2f}, {GRID.origin['lon'] + c * GRID.step:.2f}"
        )


# --- the manifest and the array -----------------------------------------------------------


def held_days(m: dict) -> dict[dt.date, dict]:
    return {dt.date.fromisoformat(d): f for f in m["files"] if (d := manifest.power_file_day(f["url"]))}


def _refresh(m: dict) -> None:
    held = held_days(m)
    m["files"] = [held[d] for d in sorted(held)]
    if not held:
        m["years"] = {"first": None, "last": None}
        m["prelimThrough"] = None
        return
    m["years"] = {"first": min(held).year, "last": max(held).year}
    m["prelimThrough"] = max(held).isoformat()


def lag_days(m: dict | None, today: dt.date) -> int:
    if m is None or m["prelimThrough"] is None:
        return LAG_DAYS + RECENT_DAYS + 1
    return (today - dt.date.fromisoformat(m["prelimThrough"])).days


def write_day(mirror: zarrstore.Mirror, day: dt.date, values: np.ndarray) -> np.ndarray | None:
    """Write one day into `power_et0` (array firstDay 1981-01-01); the values it held before, or None past the array's end."""
    i = (day - ARRAY_FIRST_DAY).days
    if i < 0:
        raise ValueError(f"{day} is before {PRODUCT}'s firstDay {ARRAY_FIRST_DAY}")
    with mirror.stage([array_key(), f"{PRODUCT}/c/{i}/"]) as root:
        old = zarrstore.read_daily_day(root, PRODUCT, day)
        arr = zarrstore.write_daily(root, PRODUCT, day, values[None], array_first_day=ARRAY_FIRST_DAY)
        if arr.attrs.get("attribution") != ATTRIBUTION:
            arr.attrs.update(ARRAY_ATTRS)
    return old


def drop_days(mirror: zarrstore.Mirror, days: list[dt.date]) -> None:
    idx = [(d - ARRAY_FIRST_DAY).days for d in days if d >= ARRAY_FIRST_DAY]
    if not idx or mirror.read_json(array_key()) is None:
        return
    with mirror.stage([array_key(), *(f"{PRODUCT}/c/{i}/" for i in idx)]) as root:
        for i in idx:
            shutil.rmtree(root / PRODUCT / "c" / str(i), ignore_errors=True)


def read_refused(mirror) -> dict | None:
    doc = mirror.read_json(refused_key())
    if not isinstance(doc, dict) or not isinstance(doc.get("day"), str) or not isinstance(doc.get("at"), str):
        return None
    try:
        dt.date.fromisoformat(doc["day"])
    except ValueError:
        return None
    return doc


# --- a run ------------------------------------------------------------------------------------


def _iso_now() -> str:
    return dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _get(client: polite.PoliteClient, url: str) -> polite.Response:
    try:
        return client.get(url)
    except polite.StopRun as e:
        raise Refused(e.url, e.status) from None
    except polite.HttpError as e:
        if e.status == 401:
            raise Refused(e.url, 401) from None
        raise


def window(today: dt.date, days: int) -> list[dt.date]:
    end = today - dt.timedelta(days=LAG_DAYS)
    return [end - dt.timedelta(days=k) for k in range(days - 1, -1, -1)]


def fetch(client: polite.PoliteClient, days: list[dt.date], budget: chirps_final.Budget) -> np.ndarray | None:
    """The window's ET0 on the copy's grid, (days, rows, cols); None when the time ran out first."""
    fields: dict[str, dict] = {p: {} for p in PARAMETERS}
    for t in tiles():
        for p in PARAMETERS:
            if not budget.allows(0.0):
                return None
            res = _get(client, request_url(p, t, days[0], days[-1]))
            for k, v in parse_response(res.body or b"", p, days).items():
                fields[p].setdefault(k, v)  # a point on a shared tile edge: the first answer stands
    return place(point_et0(fields, days), len(days))


def run_recent(mirror: zarrstore.Mirror, client: polite.PoliteClient, today: dt.date, days: int = RECENT_DAYS, budget: chirps_final.Budget | None = None, now=_iso_now) -> dict:
    budget = budget or chirps_final.Budget(None, REQUEST_RESERVE_S)
    with lease.hold(mirror, PRODUCT):
        m = manifest.read(mirror, PRODUCT) or manifest.new(PRODUCT)
        held = held_days(m)
        oldest_kept = today - dt.timedelta(days=KEEP_DAYS)
        dropped = sorted(d for d in held if d < oldest_kept)
        if dropped:
            m["files"] = [f for d, f in held.items() if d >= oldest_kept]
            _refresh(m)
            manifest.write(mirror, m)
            drop_days(mirror, dropped)

        want = window(today, days)
        values = fetch(client, want, budget)
        if values is None:
            log.info("%s: too little time left to read every response; nothing written, the next run starts over", PRODUCT)
            return {"copied": [], "dropped": [d.isoformat() for d in dropped], "stopped": "deadline"}
        copied = []
        for k, day in enumerate(want):
            v = values[k]
            if np.isnan(v).all():
                continue  # POWER doesn't have this day yet
            check_plausible(v, day)
        for k, day in enumerate(want):
            v = values[k]
            if np.isnan(v).all():
                continue
            copied.append(_record(mirror, m, day, v, now))
            manifest.write(mirror, m)
        return {"copied": copied, "dropped": [d.isoformat() for d in dropped], "stopped": "copied" if copied else "nothing_new"}


def _record(mirror, m: dict, day: dt.date, values: np.ndarray, now) -> dict:
    sha = manifest.values_sha256(values[None])
    previous = held_days(m).get(day)
    outcome = "added"
    if previous is not None and previous["valuesSha256"] == sha:
        outcome = "unchanged"
    else:
        old = write_day(mirror, day, values)
        if previous is not None:
            m["revision"] += 1
            if old is not None and manifest.values_sha256(old[None]) == previous["valuesSha256"]:
                cells, max_abs = chirps_final._diff(old[None], values[None])
            else:
                cells, max_abs = GRID.rows * GRID.cols, PLAUSIBLE_MAX_MM - PLAUSIBLE_MIN_MM
            m["changes"].append({"revision": m["revision"], "days": [day.isoformat(), day.isoformat()], "cellsChanged": cells, "maxAbsDiff": max_abs})
            outcome = "changed"
    entry = {"url": day_url(day), "etag": None, "lastModified": None, "size": None, "valuesSha256": sha, "revision": m["revision"], "fetchedAt": now()}
    m["files"] = [f for f in m["files"] if f["url"] != entry["url"]] + [entry]
    _refresh(m)
    return {"day": day.isoformat(), "outcome": outcome}


# --- the Lambda entry (lambda_handler.py dispatches here) -----------------------------------------


def handle(event, context=None, s3_client=None, opener=None, metrics=None, today=None, clock=None, sleep=None):
    """Run one `power_et0` event. The injectables are for tests."""
    ev = validate_event(event)
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
    day = (today or (lambda: dt.datetime.now(dt.UTC).date()))()
    stamp = (lambda: dt.datetime.fromtimestamp(clock(), dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")) if clock else _iso_now

    def publish() -> int:
        value = lag_days(manifest.read(mirror, PRODUCT), day)
        metrics.publish(PRODUCT, value)
        return value

    client = None

    def result(out: dict, lag: int) -> dict:
        m = manifest.read(mirror, PRODUCT)
        return {"product": PRODUCT, "mode": ev["mode"], "source": source, "revision": m["revision"] if m else None, "prelimThrough": m["prelimThrough"] if m else None, "lagDays": lag, "requests": client.requests if client else 0, **out}

    try:
        refused = read_refused(mirror)
        if refused is not None and refused["day"] == day.isoformat():
            log.info("%s: refused earlier today (%s); asking nothing until tomorrow (UTC)", PRODUCT, refused["at"])
            return result({"copied": [], "dropped": [], "stopped": "refused_today", "refusedAt": refused["at"]}, publish())
        if opener is None and not live:
            import power_fixture

            opener = power_fixture.FakePower(latest=day - dt.timedelta(days=LAG_DAYS))
        client = polite.PoliteClient(
            contact=os.environ.get("INGEST_CONTACT"),
            min_interval=1.0 if live else 0.0,
            **({"opener": opener} if opener is not None else {}),
            **({"sleep": sleep} if sleep else {}),
            **({"clock": clock} if clock else {}),
        )
        try:
            out = run_recent(mirror, client, day, ev["days"], chirps_final.Budget(context, REQUEST_RESERVE_S), stamp)
        except Refused as e:
            mirror.write_json(refused_key(), {"v": 1, "day": day.isoformat(), "at": stamp(), "status": e.status, "host": urllib.parse.urlparse(e.url).hostname})
            log.error("%s: POWER answered HTTP %s; no more requests today (UTC)", PRODUCT, e.status)
            raise
    except lease.MirrorBusy as e:
        log.info("%s: %s; the run holding it does this work", PRODUCT, e)
        return result({"copied": [], "dropped": [], "stopped": "busy", "busy": str(e)}, publish())
    except BaseException:
        try:
            publish()
        except Exception:
            log.exception("%s: could not publish %s while failing", PRODUCT, cloudwatch.METRIC)
        raise
    return result(out, publish())
