"""IMERG Late for the recent days (issue #604 R4-D, D16): NASA's GPM IMERG
Late Run daily precipitation, `GPM_3IMERGDL`, into the copy's `imerg_late`
daily array at 0.1 deg.

IMERG Late is about 14 hours behind real time, so it covers the days CHIRPS
has no preliminary value for yet (CHIRPS preliminary is 2–7 days old). Which
source a day's rain comes from is the engine's choice (a later piece), not
this job's: it only keeps a small, versioned copy of the last 30 days.

**Source.** GES DISC, collection `GPM_3IMERGDL` version 07 (and 08 once it
ships; "IMERG V08 Final is due fall 2026", and Late follows), one NetCDF-4
file a day, `3B-DAY-L.MS.MRG.3IMERG.YYYYMMDD-S000000-E235959.V07C.nc4`
(the letter after V07 moves with GES DISC's minor releases: V07B, V07C). The
whole file is global, ~26 MB; we ask the **OPeNDAP** service
(opendap.earthdata.nasa.gov, Hyrax) for region D1 only, as a DAP4 NetCDF-4
response (`….dap.nc4?dap4.ce=/precipitation[0:1:0][1900:1:2209][545:1:819];…`),
about 0.2 MB a day. The granule names (and so their minor version letter)
come from one **CMR** search a run (cmr.earthdata.nasa.gov, no sign-in), so
the job never guesses a file name.

**Layout** (fixtures/imerg/make_imerg_fixture.py writes the same):
`precipitation(time, lon, lat)` float32, **lon before lat**; lon −179.95 …
179.95 and lat −89.95 … 89.95, both ascending, cell centres on x.x5;
`_FillValue` −9999.9; units `mm/day` (V07's daily mean rate; V06's variable
was `precipitationCal`, in mm, and is refused by name). A day's mean rate in
mm/day is that day's total in mm, which is what the copy holds. The reader
places every cell from its coordinates, never from the file's order: rows
come out south first and columns west first, the copy's layout, whatever
order and orientation the file has.

**The copy** (the shared brief's 0.1 deg grid): shape (days, 275, 310), chunk
(1, 55, 62), dims (day, lat, lon), `[0, 0]` the south-west cell centred at
−35.45, 10.05, rows growing northwards; float32, NaN fill, bytes + gzip 6.
`firstDay` is set when the array is made (30 days before that run's day).

**The manifest** (`imerg_late/manifest.json`): `finalThrough` is always null
(Late is never final), `prelimThrough` the end of the contiguous run of held
days from the oldest, and each `files` entry is one day's granule (its
OPeNDAP URL) with **`version`**: the collection's version, `V07` or `V08`
(the per-day version the bias correction is fitted by, D16). The minor
letter stays in the URL. ingest/manifest.py and backend/src/mirror/manifest.ts
don't yet accept that field (piece R4-B adds it), so this module validates
the rest of the manifest with manifest.validate and the version itself.

**A run** (`{"product": "imerg_late", "mode": "recent"}`, a few times a day):
1. A refusal earlier this UTC day (`ingest-state/imerg_late/refused.json`,
   `{v, day, at, status, host}`, written on a 403 or a 401) ends the run
   before any request: the next UTC day's first run tries again.
2. The product's lease (lease.py), so two runs never write one chunk.
3. Days older than KEEP_DAYS (30) are dropped: out of the manifest first,
   then their chunks.
4. One CMR search for the last `days` (10) days through yesterday. Per day
   the newest version listed wins. A day already held from that same granule
   is skipped with no request; a new day, or one whose granule changed (V08
   arrived, a reprocessing), is fetched, newest day first, at most one
   request a second, while the Lambda has time left.
5. Each day: subset, place, 0–2000 mm check, values hash (D8), write, record.
   A new day is an addition; a held day whose values changed bumps the
   revision with a `changes` entry. The manifest is saved after every day.

**MirrorLagDays{Product=imerg_late}** on every exit once the event is valid
and the copy reachable: today minus `prelimThrough`, or RECENT_DAYS + 1 when
nothing is held. A healthy copy reads 1 or 2.

**Credential.** Live mode only: an Earthdata Login user token, read at run
time from Secrets Manager (`EARTHDATA_TOKEN_SECRET_ARN`), sent as `Authorization:
Bearer` to the GES DISC hosts only and never on a redirect
(`add_unredirected_header`), never logged. Fixtures mode needs none: the fake
server (imerg_fixture.py) asks for nothing.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import json
import logging
import os
import re
import shutil
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

import chcnetcdf
import chirps_final
import cloudwatch
import grid
import lease
import manifest
import polite
import zarrstore

log = logging.getLogger("ingest")

PRODUCT = "imerg_late"
MODES = ("recent",)
SHORT_NAME = "GPM_3IMERGDL"
#: The collection versions searched; the newest a day has wins.
VERSIONS = ("07", "08")

# --- the 0.1 deg grid over region D1 (the shared brief) ----------------------------
STEP = 0.1
ORIGIN = {"lat": -35.45, "lon": 10.05}
ROWS = 275
COLS = 310
CHUNKS = (1, 55, 62)
DIMS = ("day", "lat", "lon")

# --- IMERG's global grid, for the OPeNDAP index ranges ----------------------------
IMERG_LON0 = -179.95
IMERG_LAT0 = -89.95
IMERG_NLON = 3600
IMERG_NLAT = 1800
LON_I0 = round((ORIGIN["lon"] - IMERG_LON0) / STEP)  # 1900
LAT_I0 = round((ORIGIN["lat"] - IMERG_LAT0) / STEP)  # 545

#: The days a run looks back over (through yesterday), newest first.
RECENT_DAYS = 10
#: Days older than this are dropped: CHIRPS preliminary (2–7 days behind) and then its finals cover them.
KEEP_DAYS = 30
#: Don't start a request with less than this left of the Lambda's time (a subset is ~0.2 MB).
REQUEST_RESERVE_S = 60.0

CMR_SEARCH = "https://cmr.earthdata.nasa.gov/search/granules.umm_json"
OPENDAP_PREFIX = "https://opendap.earthdata.nasa.gov/"
#: Hosts the Earthdata token is sent to. CMR's search needs none.
AUTH_HOSTS = frozenset({"opendap.earthdata.nasa.gov", "data.gesdisc.earthdata.nasa.gov"})
#: Earthdata Login's host: landing there means the token was not accepted.
URS_HOST = "urs.earthdata.nasa.gov"

UNITS_MM_PER_DAY = frozenset({"mm/day", "mm day-1", "mm d-1", "mm/d", "mm day^-1"})

_GRANULE = re.compile(r"3B-DAY-L\.MS\.MRG\.3IMERG\.(\d{8})-S000000-E235959\.(V(\d{2})[A-Z]?)\.nc4$")
_GRANULE_UR = re.compile(r"^GPM_3IMERGDL\.(\d{2}):(3B-DAY-L\.MS\.MRG\.3IMERG\.\d{8}-S000000-E235959\.V\d{2}[A-Z]?\.nc4)$")
_VERSION = re.compile(r"^V\d{2}$")
_TIME_UNITS = re.compile(r"^\s*(days|hours|minutes|seconds) since (\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*Z?\s*(?:UTC)?\s*$")

HDF5_SIGNATURE = b"\x89HDF\r\n\x1a\n"


class ImergFormatError(ValueError):
    """CMR or OPeNDAP answered with something this job doesn't expect: stop and alarm."""


class BadEvent(ValueError):
    pass


def refused_key() -> str:
    return f"ingest-state/{PRODUCT}/refused.json"


def array_key() -> str:
    return f"{PRODUCT}/zarr.json"


def _attributes(extra: dict | None = None) -> dict:
    return {**(extra or {}), "region": dict(grid.REGION), "grid": {"origin": dict(ORIGIN), "step": STEP}}


# --- the event ------------------------------------------------------------------


def validate_event(event) -> dict:
    """{"product": "imerg_late", "mode": "recent"} with an optional "days" (1–KEEP_DAYS)."""
    if not isinstance(event, dict):
        raise BadEvent("the event must be a JSON object")
    extra = set(event) - {"product", "mode", "days"}
    if extra:
        raise BadEvent(f"unknown event keys: {sorted(extra)}")
    if event.get("product") != PRODUCT:
        raise BadEvent(f"product must be {PRODUCT!r}, got {event.get('product')!r}")
    if event.get("mode") not in MODES:
        raise BadEvent(f"mode must be one of {MODES}, got {event.get('mode')!r}")
    days = event.get("days", RECENT_DAYS)
    if not isinstance(days, int) or isinstance(days, bool) or not 1 <= days <= KEEP_DAYS:
        raise BadEvent(f"days must be a whole number from 1 to {KEEP_DAYS}, got {days!r}")
    return {"product": PRODUCT, "mode": event["mode"], "days": days}


# --- CMR: which granules exist ---------------------------------------------------


@dataclasses.dataclass(frozen=True)
class Granule:
    day: dt.date
    version: str  # "V07" / "V08": the collection version (the manifest's `version`)
    tag: str  # "V07C": the file's own version, minor letter included
    url: str  # the OPeNDAP granule URL (no constraint)


def search_url(first: dt.date, last: dt.date) -> str:
    q = [("short_name", SHORT_NAME), *(("version[]", v) for v in VERSIONS), ("temporal", f"{first.isoformat()}T00:00:00Z,{last.isoformat()}T23:59:59Z"), ("page_size", "100"), ("sort_key", "-start_date")]
    return f"{CMR_SEARCH}?{urllib.parse.urlencode(q)}"


def granule_day(url: str) -> tuple[dt.date, str] | None:
    """(day, file version tag) a granule URL names, or None."""
    m = _GRANULE.search(urllib.parse.unquote(url))
    if not m:
        return None
    return dt.datetime.strptime(m[1], "%Y%m%d").date(), m[2]


def parse_search(body: bytes, first: dt.date, last: dt.date) -> dict[dt.date, Granule]:
    """The newest-version granule for each day CMR lists in [first, last]."""
    try:
        doc = json.loads(body)
        items = doc["items"]
    except (ValueError, KeyError, TypeError) as e:
        raise ImergFormatError(f"CMR's search answered something that isn't a UMM-G result ({e})") from None
    best: dict[dt.date, Granule] = {}
    for item in items:
        umm = item.get("umm") or {}
        m = _GRANULE_UR.match(str(umm.get("GranuleUR", "")))
        if not m:
            raise ImergFormatError(f"CMR listed a granule this job doesn't know the name of: {umm.get('GranuleUR')!r}")
        named = granule_day(m[2])
        assert named is not None
        day, tag = named
        if tag[1:3] != m[1]:
            raise ImergFormatError(f"{umm['GranuleUR']}: the collection is version {m[1]} but the file says {tag}")
        begin = str(((umm.get("TemporalExtent") or {}).get("RangeDateTime") or {}).get("BeginningDateTime", ""))[:10]
        if begin != day.isoformat():
            raise ImergFormatError(f"{umm['GranuleUR']}: CMR's time ({begin}) is not the day the file names ({day})")
        urls = [u.get("URL", "") for u in umm.get("RelatedUrls") or [] if str(u.get("URL", "")).startswith(OPENDAP_PREFIX)]
        if len(urls) != 1:
            raise ImergFormatError(f"{umm['GranuleUR']}: expected one OPeNDAP link in CMR's RelatedUrls, found {len(urls)}")
        if not first <= day <= last:
            continue
        g = Granule(day, f"V{m[1]}", tag, urls[0])
        held = best.get(day)
        if held is None or (g.version, g.tag) > (held.version, held.tag):
            best[day] = g
    return best


def subset_url(g: Granule) -> str:
    """OPeNDAP's DAP4 NetCDF-4 response for region D1 of one day: precipitation
    and its coordinates. Index order is the variable's, (time, lon, lat)."""
    x = f"[{LON_I0}:1:{LON_I0 + COLS - 1}]"
    y = f"[{LAT_I0}:1:{LAT_I0 + ROWS - 1}]"
    ce = f"/precipitation[0:1:0]{x}{y};/lon{x};/lat{y};/time[0:1:0]"
    return f"{g.url}.dap.nc4?dap4.ce={urllib.parse.quote(ce, safe='/')}"


# --- reading one day -------------------------------------------------------------


def _positions(coords: np.ndarray, origin: float, count: int, name: str) -> np.ndarray:
    """For each of the copy's `count` cells along an axis (from `origin`,
    growing), its position in the file's coordinate array. Any order or
    orientation; every coordinate must be on the 0.1 deg centres."""
    c = np.asarray(coords, dtype=np.float64).ravel()
    k = np.round((c - origin) / STEP)
    if c.size == 0 or np.any(np.abs(c - (origin + k * STEP)) > STEP / 4):
        raise ImergFormatError(f"{name} is not on IMERG's 0.1 deg cell centres (x.x5)")
    pos = np.full(count, -1, dtype=np.int64)
    for p, ki in enumerate(k.astype(np.int64)):
        if 0 <= ki < count:
            if pos[ki] != -1:
                raise ImergFormatError(f"{name} repeats the cell centred at {origin + ki * STEP:.2f}")
            pos[ki] = p
    if np.any(pos < 0):
        missing = origin + int(np.argmax(pos < 0)) * STEP
        raise ImergFormatError(f"{name} ({c.min():.2f}..{c.max():.2f}) does not cover the region (no cell at {missing:.2f})")
    return pos


def _time_day(var) -> dt.datetime:
    m = _TIME_UNITS.match(str(var.attrs.get("units", "")))
    if not m:
        raise ImergFormatError(f'time units "{var.attrs.get("units")}" are not "<unit> since YYYY-MM-DD[ hh:mm:ss]"')
    epoch = dt.datetime(int(m[2]), int(m[3]), int(m[4]), int(m[5] or 0), int(m[6] or 0), int(m[7] or 0))
    t = np.asarray(var[...], dtype=np.float64).ravel()
    if t.size != 1:
        raise ImergFormatError(f"a daily file holds one time, this one {t.size}")
    return epoch + dt.timedelta(**{m[1]: float(t[0])})


def read_region(path: str, day: dt.date) -> np.ndarray:
    """Region D1's values for `day`, (ROWS, COLS) float32 in the copy's layout
    (row 0 the southernmost, col 0 the westernmost), NaN where IMERG holds
    its fill. From a global file or an OPeNDAP subset alike."""
    import h5netcdf

    with open(path, "rb") as f:
        if f.read(8) != HDF5_SIGNATURE:
            raise ImergFormatError(f"{path} is not NetCDF-4/HDF5 (a login page or an error?)")
    with h5netcdf.File(path, "r") as f:
        if "precipitation" not in f.variables:
            old = " (that's V06's name: V07 calls it precipitation)" if "precipitationCal" in f.variables else ""
            raise ImergFormatError(f"no precipitation variable{old}; found {sorted(f.variables)}")
        p = f.variables["precipitation"]
        dims = tuple(p.dimensions)
        if sorted(dims) != ["lat", "lon", "time"]:
            raise ImergFormatError(f"precipitation dims are {dims}, expected time, lon and lat")
        if p.dtype != np.float32:
            raise ImergFormatError(f"precipitation is {p.dtype}, expected float32")
        for packed in ("scale_factor", "add_offset"):
            if packed in p.attrs:
                raise ImergFormatError(f"precipitation carries {packed}; the copy expects unpacked float32")
        units = str(p.attrs.get("units", "")).strip().lower()
        if units not in UNITS_MM_PER_DAY:
            raise ImergFormatError(f'precipitation units are "{p.attrs.get("units")}", expected mm/day (a daily file\'s mean rate)')
        if "time" in f.variables:
            t = _time_day(f.variables["time"])
            if not dt.datetime.combine(day, dt.time()) <= t < dt.datetime.combine(day + dt.timedelta(days=1), dt.time()):
                raise ImergFormatError(f"the file's time {t} is not on {day}")
        fills = {float(np.float32(v)) for k in ("_FillValue", "missing_value") if (v := p.attrs.get(k)) is not None}
        raw = np.asarray(p[...], dtype=np.float32)
        if raw.shape[dims.index("time")] != 1:
            raise ImergFormatError(f"a daily file holds one time, this one {raw.shape[dims.index('time')]}")
        # (lat, lon), whatever order the file keeps them in.
        a = np.transpose(raw, (dims.index("time"), dims.index("lat"), dims.index("lon")))[0]
        rows = _positions(f.variables["lat"][...], ORIGIN["lat"], ROWS, "lat")
        cols = _positions(f.variables["lon"][...], ORIGIN["lon"], COLS, "lon")
        values = np.array(a[np.ix_(rows, cols)], dtype=np.float32)
    for fill in fills | {float(np.float32(-9999.9))}:
        values[values == np.float32(fill)] = np.nan
    check_plausible(values, day, path)
    return values


def check_plausible(values: np.ndarray, day: dt.date, source: str) -> None:
    """chcnetcdf's 0–2000 mm, with this grid's coordinates in the message."""
    bad = ~np.isnan(values) & ((values < chcnetcdf.PLAUSIBLE_MIN_MM) | (values > chcnetcdf.PLAUSIBLE_MAX_MM))
    if bad.any():
        row, col = (int(i) for i in np.argwhere(bad)[0])
        raise chcnetcdf.ImplausibleValueError(
            f"{source} has {int(bad.sum())} implausible value(s) outside {chcnetcdf.PLAUSIBLE_MIN_MM:g}–{chcnetcdf.PLAUSIBLE_MAX_MM:g} mm, "
            f"the first {float(values[row, col])} mm on {day} at {ORIGIN['lat'] + row * STEP:.2f}, {ORIGIN['lon'] + col * STEP:.2f} (region row {row}, col {col})"
        )


# --- the manifest (with the per-day version) --------------------------------------


def new_manifest() -> dict:
    m = manifest.new(PRODUCT)
    m["grid"] = {"origin": dict(ORIGIN), "step": STEP}
    return m


def _checked(m: dict) -> dict:
    """The spec's checks (manifest.validate, on the manifest less `version`)
    plus this product's own: the 0.1 deg grid, no final days, one file per
    day whose name says its day, and a `version` V07/V08 that agrees with it."""
    bare = json.loads(json.dumps(m))
    for i, f in enumerate(bare.get("files") or []):
        if not isinstance(f, dict) or "version" not in f:
            raise ValueError(f"manifest: files[{i}] of {PRODUCT} must carry its version")
        v = f.pop("version")
        if not isinstance(v, str) or not _VERSION.match(v):
            raise ValueError(f"manifest: files[{i}].version must be V and two digits (V07, V08), got {v!r}")
        named = granule_day(f.get("url", ""))
        if named is None:
            raise ValueError(f"manifest: files[{i}].url names no IMERG day, got {f.get('url')!r}")
        if named[1][:3] != v:
            raise ValueError(f"manifest: files[{i}] is a {named[1]} file but says version {v}")
    manifest.validate(bare)
    if m["product"] != PRODUCT or m["grid"] != {"origin": ORIGIN, "step": STEP}:
        raise ValueError(f"manifest: not the {PRODUCT} manifest on the 0.1 deg grid")
    if m["finalThrough"] is not None:
        raise ValueError(f"manifest: {PRODUCT} holds no final days")
    days = [granule_day(f["url"])[0] for f in m["files"]]
    if len(set(days)) != len(days):
        raise ValueError(f"manifest: {PRODUCT} lists a day twice")
    return m


def read_manifest(mirror: zarrstore.Mirror) -> dict | None:
    doc = mirror.read_json(manifest.key(PRODUCT))
    return None if doc is None else _checked(doc)


def write_manifest(mirror: zarrstore.Mirror, m: dict) -> None:
    _checked(m)
    out = json.loads(manifest.dumps({**m, "files": [{k: v for k, v in f.items() if k != "version"} for f in m["files"]]}))
    out["files"] = [{**o, "version": f["version"]} for o, f in zip(out["files"], m["files"])]
    mirror.write_json(manifest.key(PRODUCT), out)


def held_days(m: dict) -> dict[dt.date, dict]:
    return {granule_day(f["url"])[0]: f for f in m["files"]}


def _refresh(m: dict) -> None:
    """files sorted by day; years; prelimThrough = the end of the contiguous run from the oldest held day."""
    held = held_days(m)
    m["files"] = [held[d] for d in sorted(held)]
    if not held:
        m["years"] = {"first": None, "last": None}
        m["prelimThrough"] = None
        return
    first = min(held)
    through = first
    while through + dt.timedelta(days=1) in held:
        through += dt.timedelta(days=1)
    m["years"] = {"first": first.year, "last": max(held).year}
    m["prelimThrough"] = through.isoformat()


def lag_days(m: dict | None, today: dt.date) -> int:
    """Today minus prelimThrough; RECENT_DAYS + 1 with nothing held (the window's day before)."""
    if m is None or m["prelimThrough"] is None:
        return RECENT_DAYS + 1
    return (today - dt.date.fromisoformat(m["prelimThrough"])).days


# --- the array -------------------------------------------------------------------


def array_first_day(mirror: zarrstore.Mirror) -> dt.date | None:
    meta = mirror.read_json(array_key())
    if meta is None:
        return None
    return dt.date.fromisoformat(meta["attributes"]["firstDay"])


def _open(root: Path, rows_days: int | None = None, first_day: dt.date | None = None):
    if (root / PRODUCT / "zarr.json").exists():
        return zarrstore._open_or_create(root, PRODUCT, None, CHUNKS, DIMS, _attributes())
    return zarrstore._open_or_create(root, PRODUCT, (rows_days, ROWS, COLS), CHUNKS, DIMS, _attributes({"firstDay": first_day.isoformat()}))


def write_day(mirror: zarrstore.Mirror, day: dt.date, values: np.ndarray, first_day_if_new: dt.date) -> np.ndarray | None:
    """Write one day into `imerg_late`, creating the array (firstDay
    `first_day_if_new`) when absent. Returns the values it held before (NaN
    where unwritten), or None when that day was past the array's end."""
    if values.shape != (ROWS, COLS):
        raise ValueError(f"a day is ({ROWS}, {COLS}), got {values.shape}")
    origin = array_first_day(mirror) or first_day_if_new
    i = (day - origin).days
    if i < 0:
        raise ValueError(f"{day} is before {PRODUCT}'s firstDay {origin}")
    with mirror.stage([array_key(), f"{PRODUCT}/c/{i}/"]) as root:
        arr = _open(root, i + 1, origin)
        old = np.array(arr[i]) if i < arr.shape[0] else None
        if arr.shape[0] <= i:
            arr.resize((i + 1, ROWS, COLS))
        arr[i] = values.astype(np.float32)
    return old


def drop_days(mirror: zarrstore.Mirror, days: list[dt.date]) -> None:
    """Delete the chunks of those days (a missing chunk reads as NaN)."""
    origin = array_first_day(mirror)
    if origin is None:
        return
    idx = [(d - origin).days for d in days if d >= origin]
    if not idx:
        return
    with mirror.stage([array_key(), *(f"{PRODUCT}/c/{i}/" for i in idx)]) as root:
        for i in idx:
            shutil.rmtree(root / PRODUCT / "c" / str(i), ignore_errors=True)


# --- the refusal marker ------------------------------------------------------------


def read_refused(mirror: zarrstore.Mirror) -> dict | None:
    """The last refusal ({"day": the run's UTC day, "at": ISO UTC, …}), or
    None; a marker that isn't one never blocks a run."""
    doc = mirror.read_json(refused_key())
    if not isinstance(doc, dict) or doc.get("v") != 1 or not isinstance(doc.get("at"), str) or not isinstance(doc.get("day"), str):
        return None
    try:
        dt.datetime.strptime(doc["at"], "%Y-%m-%dT%H:%M:%SZ")
        dt.date.fromisoformat(doc["day"])
    except ValueError:
        return None
    return doc


def write_refused(mirror: zarrstore.Mirror, day: dt.date, at: str, status: int, url: str) -> None:
    host = urllib.parse.urlparse(url).hostname
    mirror.write_json(refused_key(), {"v": 1, "day": day.isoformat(), "at": at, "status": status, "host": host})


class Refused(polite.StopRun):
    """A 403, or a 401 (the token refused): stop, mark the day, never retry."""


# --- the Earthdata token -------------------------------------------------------------


def fetch_token(secret_arn: str, client=None) -> str:
    """The Earthdata token from Secrets Manager. Never logged or returned anywhere else."""
    if client is None:
        import boto3

        client = boto3.client("secretsmanager")
    try:
        value = client.get_secret_value(SecretId=secret_arn).get("SecretString")
    except Exception as e:
        code = getattr(e, "response", {}).get("Error", {}).get("Code")
        if code == "ResourceNotFoundException":
            raise RuntimeError("the Earthdata token secret has no value yet: docs/deployment.md § IMERG Late") from None
        raise RuntimeError(f"could not read the Earthdata token secret ({code or type(e).__name__})") from None
    token = (value or "").strip()
    if not token:
        raise RuntimeError("the Earthdata token secret is empty: docs/deployment.md § IMERG Late")
    return token


class EarthdataOpener:
    """An opener for polite.PoliteClient that adds `Authorization: Bearer` to
    requests for AUTH_HOSTS only, as an unredirected header (urllib never
    copies it onto a redirect, so it can't reach S3 or anyone else), and turns
    a landing on Earthdata Login's page into a 401."""

    def __init__(self, token: str | None, base=None):
        self._token = token
        self.base = base or urllib.request.urlopen

    def __repr__(self):
        return f"EarthdataOpener(token={'set' if self._token else 'none'})"

    def __call__(self, req, timeout=None):
        if self._token and urllib.parse.urlparse(req.full_url).hostname in AUTH_HOSTS:
            req.add_unredirected_header("Authorization", f"Bearer {self._token}")
        res = self.base(req, timeout=timeout)
        landed = res.geturl() if hasattr(res, "geturl") else req.full_url
        if urllib.parse.urlparse(landed).hostname == URS_HOST:
            res.close()
            raise urllib.error.HTTPError(req.full_url, 401, "Earthdata Login did not accept the token", res.headers, None)
        return res


# --- a run -------------------------------------------------------------------------


def _get(client: polite.PoliteClient, url: str, **kw) -> polite.Response:
    try:
        return client.get(url, **kw)
    except polite.StopRun as e:
        raise Refused(e.url, e.status) from None
    except polite.HttpError as e:
        if e.status == 401:
            raise Refused(e.url, 401) from None
        raise


def _iso_now() -> str:
    return dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def run_recent(mirror: zarrstore.Mirror, client: polite.PoliteClient, today: dt.date, days: int = RECENT_DAYS, budget: chirps_final.Budget | None = None, now=_iso_now, workdir: str | None = None) -> dict:
    """One run (see the module header). Held under the product's lease."""
    budget = budget or chirps_final.Budget(None, REQUEST_RESERVE_S)
    with lease.hold(mirror, PRODUCT):
        m = read_manifest(mirror) or new_manifest()
        held = held_days(m)

        # Drop what is older than the window we keep: the manifest first, then the chunks.
        oldest_kept = today - dt.timedelta(days=KEEP_DAYS)
        dropped = sorted(d for d in held if d < oldest_kept)
        if dropped:
            m["files"] = [f for d, f in held.items() if d >= oldest_kept]
            _refresh(m)
            write_manifest(mirror, m)
            drop_days(mirror, dropped)
            held = held_days(m)

        first, last = today - dt.timedelta(days=days), today - dt.timedelta(days=1)
        res = _get(client, search_url(first, last))
        listed = parse_search(res.body or b"", first, last)
        todo = [g for d, g in sorted(listed.items(), reverse=True) if d not in held or held[d]["url"] != g.url]
        log.info("%s: CMR lists %d of the last %d days, %d to copy", PRODUCT, len(listed), days, len(todo))

        copied, stopped = [], "up_to_date"
        for g in todo:
            if not budget.allows(0.0):
                stopped = "deadline"
                log.info("%s: stopping before %s, too little time left; the next run continues", PRODUCT, g.day)
                break
            with tempfile.TemporaryDirectory(prefix="imerg-", dir=workdir) as tmp:
                path = Path(tmp) / "day.nc4"
                r = _get(client, subset_url(g), dest=str(path))
                if r.not_modified:
                    raise ImergFormatError(f"{g.url} answered 304 to an unconditional GET")
                values = read_region(str(path), g.day)
            copied.append(_record(mirror, m, g, values, r, today, now))
            write_manifest(mirror, m)  # after every day: a run cut short keeps what it copied
        if todo and len(copied) == len(todo):
            stopped = "copied"
        return {"copied": copied, "dropped": [d.isoformat() for d in dropped], "stopped": stopped, "listed": len(listed)}


def _record(mirror, m: dict, g: Granule, values: np.ndarray, r: polite.Response, today: dt.date, now) -> dict:
    sha = manifest.values_sha256(values[None])
    previous = held_days(m).get(g.day)
    outcome = "added"
    if previous is not None and previous["valuesSha256"] == sha:
        outcome = "unchanged"
    else:
        old = write_day(mirror, g.day, values, today - dt.timedelta(days=KEEP_DAYS))
        if previous is not None:
            m["revision"] += 1
            if old is not None and manifest.values_sha256(old[None]) == previous["valuesSha256"]:
                cells, max_abs = chirps_final._diff(old[None], values[None])
            else:
                # The copy didn't hold the previous values (a run died between chunks and manifest):
                # claim every cell and the widest plausible difference, never 0 (chirps_final.ingest_file).
                cells, max_abs = ROWS * COLS, chcnetcdf.PLAUSIBLE_MAX_MM - chcnetcdf.PLAUSIBLE_MIN_MM
            m["changes"].append({"revision": m["revision"], "days": [g.day.isoformat(), g.day.isoformat()], "cellsChanged": cells, "maxAbsDiff": max_abs})
            outcome = "changed"
    entry = {"url": g.url, "etag": r.etag, "lastModified": r.last_modified, "size": r.size, "valuesSha256": sha, "revision": m["revision"], "fetchedAt": now(), "version": g.version}
    m["files"] = [f for f in m["files"] if granule_day(f["url"])[0] != g.day] + [entry]
    _refresh(m)
    log.info("%s: %s %s (%s), revision %s", PRODUCT, outcome, g.day, g.tag, m["revision"])
    return {"day": g.day.isoformat(), "version": g.version, "tag": g.tag, "outcome": outcome}


# --- the Lambda entry (lambda_handler.py dispatches here) ------------------------------


def handle(event, context=None, s3_client=None, opener=None, metrics=None, today=None, clock=None, sleep=None, secrets_client=None):
    """Run one `imerg_late` event. The injectables are for tests."""
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
        value = lag_days(read_manifest(mirror), day)
        metrics.publish(PRODUCT, value)
        return value

    def result(out: dict) -> dict:
        m = read_manifest(mirror)
        return {"product": PRODUCT, "mode": ev["mode"], "source": source, "revision": m["revision"] if m else None, "prelimThrough": m["prelimThrough"] if m else None, "lagDays": lag, "requests": client.requests if client else 0, **out}

    client = None
    # Every exit from here publishes MirrorLagDays{Product=imerg_late} (the alarm treats none as breaching).
    try:
        refused = read_refused(mirror)
        refused_at = refused["at"] if refused is not None and refused["day"] == day.isoformat() else None
        if refused_at is not None:
            log.info("%s: refused earlier today (%s); asking nothing until tomorrow (UTC)", PRODUCT, refused_at)
            lag = publish()
            return result({"copied": [], "dropped": [], "stopped": "refused_today", "refusedAt": refused_at})
        if opener is None:
            if live:
                arn = os.environ.get("EARTHDATA_TOKEN_SECRET_ARN")
                if not arn:
                    raise RuntimeError("EARTHDATA_TOKEN_SECRET_ARN is not set (infra/imerg.tf)")
                opener = EarthdataOpener(fetch_token(arn, secrets_client))
            else:
                import imerg_fixture

                opener = imerg_fixture.FakeEarthdata(latest=day - dt.timedelta(days=1))
        client = polite.PoliteClient(
            contact=os.environ.get("INGEST_CONTACT"),
            min_interval=1.0 if live else 0.0,
            opener=opener,
            **({"sleep": sleep} if sleep else {}),
            **({"clock": clock} if clock else {}),
        )
        try:
            out = run_recent(mirror, client, day, ev["days"], chirps_final.Budget(context, REQUEST_RESERVE_S), stamp)
        except Refused as e:
            write_refused(mirror, day, stamp(), e.status, e.url)
            log.error("%s: %s answered HTTP %s; no more requests today (UTC)", PRODUCT, urllib.parse.urlparse(e.url).hostname, e.status)
            raise
    except lease.MirrorBusy as e:
        log.info("%s: %s; the run holding it does this work", PRODUCT, e)
        lag = publish()
        return result({"copied": [], "dropped": [], "stopped": "busy", "busy": str(e)})
    except BaseException:
        try:
            publish()
        except Exception:
            log.exception("%s: could not publish %s while failing", PRODUCT, cloudwatch.METRIC)
        raise
    lag = publish()
    return result(out)


if __name__ == "__main__":
    # Fixtures mode on this machine (ingest/README.md § IMERG Late):
    #   MIRROR_URL=file://$PWD/ingest/.mirror ingest/.venv/bin/python ingest/imerg.py [days]
    import sys

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if os.environ.get("FEED_SOURCE", "fixtures") != "fixtures":
        sys.exit("imerg.py from the command line runs fixtures mode only (FEED_SOURCE=fixtures)")
    os.environ.setdefault("MIRROR_URL", f"file://{Path(__file__).resolve().parent / '.mirror'}")
    ev = {"product": PRODUCT, "mode": "recent", **({"days": int(sys.argv[1])} if len(sys.argv) > 1 else {})}
    print(json.dumps(handle(ev), indent=2))
