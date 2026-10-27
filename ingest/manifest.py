"""The manifest written next to each product as `<product>/manifest.json`
(issue #604, "Manifest spec").

    { product, revision, region: {w, s, e, n}, grid: {origin: {lat, lon}, step},
      years: {first, last}, finalThrough, prelimThrough,
      files: [{ url, etag, lastModified, size, valuesSha256, revision, fetchedAt }],
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

FINALS_PRODUCTS = ("rnl", "sat")


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


def values_sha256(values: np.ndarray) -> str:
    """The manifest's hash of a region subset (days, lat, lon)."""
    a = np.ascontiguousarray(values, dtype="<f4")
    bits = a.view("<u4").copy()
    bits[np.isnan(a)] = CANONICAL_NAN
    return hashlib.sha256(bits.tobytes(order="C")).hexdigest()


def utc_now() -> str:
    return dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def new(product: str) -> dict:
    """An empty manifest for a product: revision 1, nothing copied yet."""
    return {
        "product": product,
        "revision": 1,
        "region": dict(grid.REGION),
        "grid": {"origin": dict(grid.ORIGIN), "step": grid.STEP},
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
        _exact_keys(f, _FILE_KEYS, f"files[{i}]")
        if not isinstance(f["url"], str) or not f["url"]:
            _fail(f"files[{i}].url must be a non-empty string")
        for k in ("etag", "lastModified"):
            if f[k] is not None and not isinstance(f[k], str):
                _fail(f"files[{i}].{k} must be a string or null")
        _int(f["size"], f"files[{i}].size")
        if not isinstance(f["valuesSha256"], str) or not _SHA.match(f["valuesSha256"]):
            _fail(f"files[{i}].valuesSha256 must be 64 lowercase hex digits")
        _int(f["revision"], f"files[{i}].revision", 1)
        if not isinstance(f["fetchedAt"], str) or not _UTC.match(f["fetchedAt"]):
            _fail(f"files[{i}].fetchedAt must be ISO UTC (…Z)")
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
    out["files"] = [{k: f[k] for k in _FILE_KEYS} for f in m["files"]]
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
