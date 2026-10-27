"""The manifest written next to each product as `<product>/manifest.json`
(issue #604, "Manifest spec").

    { product, revision, region: {w, s, e, n}, grid: {origin: {lat, lon}, step},
      years: {first, last}, finalThrough, prelimThrough,
      files: [{ url, etag, lastModified, size, valuesSha256, revision, fetchedAt, version? }],
      changes: [{ revision, days: [from, to], cellsChanged, maxAbsDiff }] }

`revision` is an integer from 1, dates are ISO `YYYY-MM-DD` (or null before
any day is copied), `fetchedAt` is ISO UTC (`…Z`). `valuesSha256` is the hex
SHA-256 of the region subset's float32 little-endian bytes in (day, lat, lon)
C order, with every NaN canonicalised to 0x7FC00000, so the same values hash
the same however a NaN's payload bits came out.

`dumps` writes the keys in the spec's order, so the file diffs cleanly.

For the finals products (`rnl`, `sat`), each file is one of CHC's `byMonth`
files and its URL names its month (`….YYYY.MM.days_p05.nc`). `finalThrough`
is the last day of the **contiguous** run of months from the first month
copied (`finals_coverage`), never the newest day seen: after a partial
backfill plus the newest month, the months between are not held, and a day
read as final there would be cached as final no-data for good. A manifest
whose `finalThrough` runs past that run is refused, here and by the Node
reader (backend/src/mirror/manifest.ts).

Per product (the same rules as the Node validator; backend/src/mirror/grid.ts
PRODUCT_GRIDS): `grid.step` is the product's (`PRODUCT_STEPS`: 0.05 for the
CHIRPS products, 0.1 for `era5l` and `imerg_late`), and `rnl` and `era5l`
hold no preliminary days. `imerg_late` holds no final days (IMERG Late is
never final): its held days are exactly the days a file names
(`imerg_held_days`), each standing on its own, and `prelimThrough` is the
newest of them (`imerg_coverage`), which it may not run past. A day with no
file is not held, never final no-data, and a gap does not stop the days after
it from being read: the product is a rolling window of recent days, whose
useful days are the newest (one day CMR never listed must not block the
next 30).
Its files are one a day, each URL naming its day as GPM's daily granule names
do (`3IMERG.YYYYMMDD-S000000-E235959.`), each optionally with the IMERG
collection `version` it came from (`V07`, later `V08`; the minor letter stays
in the URL), the per-day version the bias correction is fitted by (D16). No
other product's file carries a `version`.

`era5l`'s files are its CDS month requests (era5land.py), each URL naming
what was asked, exactly `cds://reanalysis-era5-land/total_precipitation/YYYY-MM`,
with no ETag or Last-Modified (the CDS gives none). Month M's request holds
the 00 UTC steps of M's days, which total the last day of M-1 through the
second-last day of M (`era5l_written_days`; the 1950-01 request starts at the
record, 1950-01-01). `finalThrough` may not run past the end of the
contiguous run of those days from the earliest month (`era5l_coverage`), as
for the CHIRPS finals.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import re

import numpy as np

import grid

CANONICAL_NAN = 0x7FC00000

_KEYS = ["product", "revision", "region", "grid", "years", "finalThrough", "prelimThrough", "files", "changes"]
_FILE_KEYS = ["url", "etag", "lastModified", "size", "valuesSha256", "revision", "fetchedAt"]
_CHANGE_KEYS = ["revision", "days", "cellsChanged", "maxAbsDiff"]
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
_SHA = re.compile(r"^[0-9a-f]{64}$")
_FILE_MONTH = re.compile(r"\.(\d{4})\.(0[1-9]|1[0-2])\.days_p05\.nc$")
_FILE_DAY = re.compile(r"3IMERG\.(\d{4})(\d{2})(\d{2})-S000000-E235959\.")
IMERG_VERSION = re.compile(r"^V\d{2}$")
_ERA5L_URL = re.compile(r"^cds://reanalysis-era5-land/total_precipitation/(\d{4})-(0[1-9]|1[0-2])$")
#: ERA5-Land's record starts here: the 1950-01 request's first step is the record's start.
ERA5L_FIRST_DAY = dt.date(1950, 1, 1)

FINALS_PRODUCTS = ("rnl", "sat")
# The step of each product's grid; a forecast issue (`gefs/<issue>`, `ecmwf/<issue>`) by its prefix.
PRODUCT_STEPS = {"rnl": 0.05, "sat": 0.05, "prelim": 0.05, "era5l": 0.1, "imerg_late": 0.1}
_FORECAST_STEPS = {"gefs": 0.05, "ecmwf": 0.1}
_NO_PRELIM = ("rnl", "era5l")


def product_step(product: str) -> float | None:
    """The step of `product`'s grid, or None for a product the copy doesn't know."""
    if product in PRODUCT_STEPS:
        return PRODUCT_STEPS[product]
    m = re.match(r"^(gefs|ecmwf)/\d{4}-\d{2}-\d{2}$", product)
    return _FORECAST_STEPS[m[1]] if m else None


def imerg_file_day(url: str) -> str | None:
    """The ISO day an IMERG daily file's URL names, or None."""
    m = _FILE_DAY.search(url)
    if not m:
        return None
    try:
        return dt.date(int(m[1]), int(m[2]), int(m[3])).isoformat()
    except ValueError:
        return None


def imerg_held_days(files: list[dict]) -> set[str]:
    """The ISO days imerg_late's files name: exactly its held days, each on its own (no contiguity)."""
    return {d for f in files if (d := imerg_file_day(f["url"])) is not None}


def imerg_coverage(files: list[dict]) -> tuple[str, str] | None:
    """(oldest, newest) day the files name; None when none. Days between with no file are not held (imerg_held_days)."""
    days = imerg_held_days(files)
    return (min(days), max(days)) if days else None


def file_month(url: str) -> tuple[int, int] | None:
    """The (year, month) a CHC byMonth file's URL names, or None."""
    m = _FILE_MONTH.search(url)
    return (int(m[1]), int(m[2])) if m else None


def _next_month(ym: tuple[int, int]) -> tuple[int, int]:
    y, mo = ym
    return (y + 1, 1) if mo == 12 else (y, mo + 1)


def finals_coverage(files: list[dict]) -> tuple[str, str] | None:
    """(first day, last day) of the contiguous run of months the files hold,
    from the earliest; None when they hold none. A month counts as held whole:
    CHC's byMonth file runs to the month's last day (lambda_handler checks)."""
    months = {ym for f in files if (ym := file_month(f["url"])) is not None}
    if not months:
        return None
    first = min(months)
    last = first
    while _next_month(last) in months:
        last = _next_month(last)
    ny, nm = _next_month(last)
    return dt.date(*first, 1).isoformat(), (dt.date(ny, nm, 1) - dt.timedelta(days=1)).isoformat()


def era5l_file_month(url: str) -> tuple[int, int] | None:
    """The (year, month) an era5l file's URL (its CDS request) names, or None."""
    m = _ERA5L_URL.match(url)
    return (int(m[1]), int(m[2])) if m else None


def era5l_written_days(ym: tuple[int, int]) -> tuple[dt.date, dt.date]:
    """The days month `ym`'s request holds: the last day of the month before
    through the second-last day of `ym` (each 00 UTC step is the previous
    day's total), never before ERA5L_FIRST_DAY."""
    first = max(dt.date(*ym, 1) - dt.timedelta(days=1), ERA5L_FIRST_DAY)
    return first, dt.date(*_next_month(ym), 1) - dt.timedelta(days=2)


def era5l_coverage(files: list[dict]) -> tuple[str, str] | None:
    """(first day, last day) of the contiguous run of days era5l's files hold,
    from the earliest month's; None when none names a month."""
    months = {ym for f in files if (ym := era5l_file_month(f["url"])) is not None}
    if not months:
        return None
    first = min(months)
    last = first
    while _next_month(last) in months:
        last = _next_month(last)
    return era5l_written_days(first)[0].isoformat(), era5l_written_days(last)[1].isoformat()


def values_sha256(values: np.ndarray) -> str:
    """The manifest's hash of a region subset (days, lat, lon)."""
    a = np.ascontiguousarray(values, dtype="<f4")
    bits = a.view("<u4").copy()
    bits[np.isnan(a)] = CANONICAL_NAN
    return hashlib.sha256(bits.tobytes(order="C")).hexdigest()


def utc_now() -> str:
    return dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def new(product: str) -> dict:
    """An empty manifest for a product on its grid (grid.for_product): revision 1, nothing copied yet."""
    attrs = grid.for_product(product).attrs
    return {
        "product": product,
        "revision": 1,
        "region": attrs["region"],
        "grid": attrs["grid"],
        "years": {"first": None, "last": None},
        "finalThrough": None,
        "prelimThrough": None,
        "files": [],
        "changes": [],
    }


def _fail(msg: str):
    raise ValueError(f"manifest: {msg}")


def _date_or_null(v, where):
    if v is not None and not (isinstance(v, str) and _DATE.match(v) and dt.date.fromisoformat(v)):
        _fail(f"{where} must be YYYY-MM-DD or null, got {v!r}")


def _int(v, where, minimum=0):
    if not isinstance(v, int) or isinstance(v, bool) or v < minimum:
        _fail(f"{where} must be an integer >= {minimum}, got {v!r}")


def _exact_keys(obj, keys, where):
    if not isinstance(obj, dict) or set(obj) != set(keys):
        _fail(f"{where} must have exactly the keys {keys}, got {sorted(obj) if isinstance(obj, dict) else obj!r}")


def validate(m: dict) -> dict:
    """Raise ValueError unless `m` holds exactly the spec; return it."""
    _exact_keys(m, _KEYS, "the manifest")
    if not isinstance(m["product"], str) or not m["product"]:
        _fail("product must be a non-empty string")
    _int(m["revision"], "revision", 1)
    _exact_keys(m["region"], ["w", "s", "e", "n"], "region")
    _exact_keys(m["grid"], ["origin", "step"], "grid")
    _exact_keys(m["grid"]["origin"], ["lat", "lon"], "grid.origin")
    for v in [*m["region"].values(), *m["grid"]["origin"].values(), m["grid"]["step"]]:
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            _fail(f"region and grid hold numbers, got {v!r}")
    _exact_keys(m["years"], ["first", "last"], "years")
    for k in ("first", "last"):
        if m["years"][k] is not None:
            _int(m["years"][k], f"years.{k}", 1900)
    _date_or_null(m["finalThrough"], "finalThrough")
    _date_or_null(m["prelimThrough"], "prelimThrough")
    if not isinstance(m["files"], list):
        _fail("files must be a list")
    for i, f in enumerate(m["files"]):
        _exact_keys(f, [*_FILE_KEYS, "version"] if isinstance(f, dict) and "version" in f else _FILE_KEYS, f"files[{i}]")
        if not isinstance(f["url"], str) or not f["url"]:
            _fail(f"files[{i}].url must be a non-empty string")
        for k in ("etag", "lastModified"):
            if f[k] is not None and not isinstance(f[k], str):
                _fail(f"files[{i}].{k} must be a string or null")
        if f["size"] is not None:  # null when the upstream gave no Content-Length (the Node validator, backend/src/mirror/manifest.ts, agrees)
            _int(f["size"], f"files[{i}].size")
        if not isinstance(f["valuesSha256"], str) or not _SHA.match(f["valuesSha256"]):
            _fail(f"files[{i}].valuesSha256 must be 64 lowercase hex digits")
        _int(f["revision"], f"files[{i}].revision", 1)
        if not isinstance(f["fetchedAt"], str) or not _UTC.match(f["fetchedAt"]):
            _fail(f"files[{i}].fetchedAt must be ISO UTC (…Z)")
        if "version" in f and not (isinstance(f["version"], str) and IMERG_VERSION.match(f["version"])):
            _fail(f"files[{i}].version must be an IMERG version (V07, V08, …), got {f['version']!r}")
    if not isinstance(m["changes"], list):
        _fail("changes must be a list")
    for i, c in enumerate(m["changes"]):
        _exact_keys(c, _CHANGE_KEYS, f"changes[{i}]")
        _int(c["revision"], f"changes[{i}].revision", 1)
        if not isinstance(c["days"], list) or len(c["days"]) != 2:
            _fail(f"changes[{i}].days must be [from, to]")
        for d in c["days"]:
            if d is None:
                _fail(f"changes[{i}].days holds dates, not null")
            _date_or_null(d, f"changes[{i}].days")
        _int(c["cellsChanged"], f"changes[{i}].cellsChanged")
        if not isinstance(c["maxAbsDiff"], (int, float)) or isinstance(c["maxAbsDiff"], bool) or c["maxAbsDiff"] < 0:
            _fail(f"changes[{i}].maxAbsDiff must be a number >= 0")
    step = product_step(m["product"])
    if step is not None and m["grid"]["step"] != step:
        _fail(f"grid.step must be {step} for {m['product']}, got {m['grid']['step']!r}")
    if m["product"] in _NO_PRELIM and m["prelimThrough"] is not None:
        _fail(f"{m['product']} has no preliminary days")
    if m["product"] == "imerg_late":
        for i, f in enumerate(m["files"]):
            if imerg_file_day(f["url"]) is None:
                _fail(f"files[{i}].url names no day (…3IMERG.YYYYMMDD-S000000-E235959.…), got {f['url']!r}")
        if m["finalThrough"] is not None:
            _fail("imerg_late holds no final days")
        days = imerg_coverage(m["files"])
        if m["prelimThrough"] is not None and (days is None or m["prelimThrough"] > days[1]):
            _fail(f"prelimThrough {m['prelimThrough']} runs past the newest day the files hold ({days[1] if days else 'none'})")
    else:
        for i, f in enumerate(m["files"]):
            if "version" in f:
                _fail(f"files[{i}] of {m['product']} carries a version: only imerg_late's do")
    if m["product"] == "era5l":
        for i, f in enumerate(m["files"]):
            if era5l_file_month(f["url"]) is None:
                _fail(f"files[{i}].url is not an era5l month request (cds://reanalysis-era5-land/total_precipitation/YYYY-MM), got {f['url']!r}")
            if f["etag"] is not None or f["lastModified"] is not None:
                _fail(f"files[{i}] of era5l has an etag or lastModified: the CDS gives neither")
        days = era5l_coverage(m["files"])
        if m["finalThrough"] is not None and (days is None or m["finalThrough"] > days[1]):
            _fail(f"finalThrough {m['finalThrough']} runs past the days the files hold contiguously (through {days[1] if days else 'none'})")
    if m["product"] in FINALS_PRODUCTS:
        for i, f in enumerate(m["files"]):
            if file_month(f["url"]) is None:
                _fail(f"files[{i}].url names no month (….YYYY.MM.days_p05.nc), got {f['url']!r}")
        coverage = finals_coverage(m["files"])
        if m["finalThrough"] is not None and (coverage is None or m["finalThrough"] > coverage[1]):
            _fail(f"finalThrough {m['finalThrough']} runs past the months the files hold contiguously (through {coverage[1] if coverage else 'none'})")
    return m


def _ordered(m: dict) -> dict:
    out = {k: m[k] for k in _KEYS}
    out["region"] = {k: m["region"][k] for k in ("w", "s", "e", "n")}
    out["grid"] = {"origin": {k: m["grid"]["origin"][k] for k in ("lat", "lon")}, "step": m["grid"]["step"]}
    out["years"] = {k: m["years"][k] for k in ("first", "last")}
    out["files"] = [{k: f[k] for k in [*_FILE_KEYS, *(["version"] if "version" in f else [])]} for f in m["files"]]
    out["changes"] = [{k: c[k] for k in _CHANGE_KEYS} for c in m["changes"]]
    return out


def dumps(m: dict) -> str:
    return json.dumps(_ordered(validate(m)), indent=2, allow_nan=False) + "\n"


def loads(text: str) -> dict:
    return validate(json.loads(text))


def key(product: str) -> str:
    return f"{product}/manifest.json"


def read(mirror, product: str) -> dict | None:
    """The product's manifest from a zarrstore.Mirror, or None if it has none."""
    doc = mirror.read_json(key(product))
    return None if doc is None else validate(doc)


def write(mirror, m: dict) -> None:
    mirror.write_json(key(m["product"]), json.loads(dumps(m)))


def file_entry(m: dict, url: str) -> dict | None:
    return next((f for f in m["files"] if f["url"] == url), None)


def upsert_file(m: dict, entry: dict) -> None:
    """Replace the entry for the same url, or add it; files stay sorted by url."""
    m["files"] = sorted([f for f in m["files"] if f["url"] != entry["url"]] + [entry], key=lambda f: f["url"])
