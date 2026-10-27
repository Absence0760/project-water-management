#!/usr/bin/env python3
"""Check the backfilled copy before the worker reads it (issue #604 R3-E).

Run by the operator after the backfill and before `chirps_source = "mirror"`
(docs/deployment.md § Backfill); never by Lambda. Three checks, each picked
with `--checks` (default: all three):

- **coverage**: each finals manifest (`rnl`, `sat`) holds every month from the
  product's first (rnl 1981-01, sat 2000-06, or `--first-month`) with no gap,
  `finalThrough` is the last day of that contiguous run (Round 1's rule), and
  today minus `finalThrough` is at most `--max-lag-days` (75, the lag alarm's
  default). Reads only the copy.
- **chc**: N random cell-days (default 200, seeded, stratified across both
  products and their years) read from the copy and from CHC's own daily
  GeoTIFFs (`final/{rnl,sat}/YYYY/chirps-v3.0.<product>.YYYY.MM.DD.tif`, the
  files the cache read before the copy existed), a pixel at a time through
  range requests (header, image directory, one strip: tiffread.py). Every
  request goes through polite.PoliteClient: one at a time, at most one a
  second, and an HTTP 403 stops the run with no retry. The values must be
  **bit-equal** (both no-data counts as equal); any other cell-day fails,
  listed with both values.
- **dynamical**: the whole region of `rnl` for one month per decade (seeded,
  or `--month YYYY-MM`, repeatable) against dynamical.org's public Icechunk
  copy of CHIRPS v3 final (anonymous, us-west-2). Its kg m-2 s-1 is
  multiplied by 86,400 and its north-up rows flipped. The land/sea mask must
  match exactly and the relative difference on wet cell-days (>= 1 mm) stay
  within `--tolerance` (0.2%: Round 0 measured median 0.067%, max 0.195%).
  dynamical.org rounds to 8 mantissa bits, so its values never bit-match.
  Needs `icechunk` and `xarray` from requirements-verify.txt
  (`ingest/dev.sh verify` makes that venv); the other checks don't.

`--no-network` runs only the coverage check (the committed fixture copy,
`backend/fixtures/mirror/`, works). The report is Markdown on stdout (or
`--out`); the exit status is 0 when every check run passed, 1 when any
failed or stopped, 2 for a usage error, so the runbook can gate the switch on it.

    MIRROR_URL=s3://<mirror bucket> ingest/dev.sh verify [--out report.md]
"""

from __future__ import annotations

import argparse
import calendar
import datetime as dt
import gzip
import json
import math
import os
import random
import struct
import sys
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

import numpy as np

import grid
import manifest
import polite
import tiffread

FINALS = ("rnl", "sat")
# The first byMonth file of each product (backfill_plan.FIRST_MONTH).
FIRST_MONTH = {"rnl": "1981-01", "sat": "2000-06"}
CHC_BASE = "https://data.chc.ucsb.edu/products"
DYNAMICAL = {
    "bucket": "dynamical-ucsb-chc-chirps",
    "prefix": "ucsb-chc-chirps-analysis-final/v0.1.0.icechunk",
    "region": "us-west-2",
    "variable": "precipitation_surface",
}
# dynamical.org's copy is CHIRPS v3 final; Round 0 compared it with `rnl` (docs/spikes/604-round0.md § 3).
DYNAMICAL_PRODUCT = "rnl"
SECONDS_PER_DAY = np.float32(86400)
DEFAULT_TOLERANCE = 0.002
WET_MM = 1.0
DEFAULT_MAX_LAG_DAYS = 75
CHUNK = (1, grid.DOYS, 20, 20)


class CopyFormatError(ValueError):
    """The copy's array metadata isn't the D2 finals layout."""


# --- the copy ---------------------------------------------------------------


class CopyStore:
    """Raw objects of the copy at MIRROR_URL (file:// or s3://); None when absent."""

    def __init__(self, url: str, s3_client=None):
        u = urlparse(url)
        if u.scheme == "file":
            if u.netloc not in ("", "localhost") or not u.path.startswith("/"):
                raise ValueError(f"MIRROR_URL {url!r} must be file:///absolute/path")
            self.root = Path(u.path)
            self.s3 = None
        elif u.scheme == "s3":
            if not u.netloc:
                raise ValueError(f"MIRROR_URL {url!r} names no bucket")
            if s3_client is None:
                import boto3

                s3_client = boto3.client("s3")
            self.s3 = s3_client
            self.bucket = u.netloc
            self.prefix = u.path.strip("/")
        else:
            raise ValueError(f"MIRROR_URL {url!r} must start with file:// or s3://")
        self.url = url

    def get(self, key: str) -> bytes | None:
        if self.s3 is None:
            p = self.root / key
            return p.read_bytes() if p.exists() else None
        k = f"{self.prefix}/{key}" if self.prefix else key
        try:
            return self.s3.get_object(Bucket=self.bucket, Key=k)["Body"].read()
        except self.s3.exceptions.NoSuchKey:
            return None

    def json(self, key: str) -> dict | None:
        body = self.get(key)
        return None if body is None else json.loads(body)


class FinalsArray:
    """One finals product of the copy: (year, doy, lat, lon), chunk (1, 366, 20, 20),
    float32 little-endian, gzip, NaN fill; a missing chunk reads as NaN."""

    def __init__(self, store: CopyStore, product: str):
        self.store = store
        self.product = product
        meta = store.json(f"{product}/zarr.json")
        if meta is None:
            raise CopyFormatError(f"the copy has no {product}/zarr.json")
        expect = {
            "zarr_format": 3,
            "node_type": "array",
            "data_type": "float32",
            "fill_value": "NaN",
            "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": list(CHUNK)}},
            "chunk_key_encoding": {"name": "default", "configuration": {"separator": "/"}},
            "dimension_names": ["year", "doy", "lat", "lon"],
        }
        for k, v in expect.items():
            if meta.get(k) != v:
                raise CopyFormatError(f"{product}/zarr.json {k} is {meta.get(k)!r}, not {v!r}")
        codecs = meta.get("codecs") or []
        if [c.get("name") for c in codecs] != ["bytes", "gzip"] or codecs[0].get("configuration", {}).get("endian") != "little":
            raise CopyFormatError(f"{product}/zarr.json codecs are {codecs!r}, not bytes (little) then gzip")
        shape = meta.get("shape") or []
        if len(shape) != 4 or shape[1:] != [grid.DOYS, grid.ROWS, grid.COLS]:
            raise CopyFormatError(f"{product}/zarr.json shape is {shape!r}")
        attrs = meta.get("attributes", {})
        if attrs.get("region") != grid.REGION or attrs.get("grid") != {"origin": grid.ORIGIN, "step": grid.STEP}:
            raise CopyFormatError(f"{product}/zarr.json region or grid is not D1's")
        self.first_year = attrs.get("firstYear")
        if not isinstance(self.first_year, int):
            raise CopyFormatError(f"{product}/zarr.json has no firstYear")
        self.years = shape[0]
        self._chunks: dict[tuple[int, int, int], np.ndarray] = {}

    def chunk(self, yi: int, cr: int, cc: int) -> np.ndarray:
        """Chunk (yi, 0, cr, cc) as (366, 20, 20); all NaN when not stored."""
        key = (yi, cr, cc)
        if key not in self._chunks:
            if len(self._chunks) > 4096:
                self._chunks.clear()
            body = self.store.get(f"{self.product}/c/{yi}/0/{cr}/{cc}") if 0 <= yi < self.years else None
            if body is None:
                a = np.full(CHUNK[1:], np.nan, dtype=np.float32)
            else:
                raw = gzip.decompress(body)
                n = CHUNK[1] * CHUNK[2] * CHUNK[3]
                if len(raw) != n * 4:
                    raise CopyFormatError(f"{self.product} chunk {key} decodes to {len(raw)} bytes, not {n * 4}")
                a = np.frombuffer(raw, dtype="<f4").reshape(CHUNK[1:])
            self._chunks[key] = a
        return self._chunks[key]

    def value(self, day: dt.date, row: int, col: int) -> np.float32:
        yi = day.year - self.first_year
        a = self.chunk(yi, row // CHUNK[2], col // CHUNK[3])
        return a[grid.doy_index(day), row % CHUNK[2], col % CHUNK[3]]

    def region(self, first: dt.date, days: int) -> np.ndarray:
        """(days, 550, 620) south-up, for days within one year."""
        last = first + dt.timedelta(days=days - 1)
        if last.year != first.year:
            raise ValueError("region() reads days of one year")
        yi = first.year - self.first_year
        d0 = grid.doy_index(first)
        out = np.full((days, grid.ROWS, grid.COLS), np.nan, dtype=np.float32)
        for cr in range(math.ceil(grid.ROWS / CHUNK[2])):
            for cc in range(math.ceil(grid.COLS / CHUNK[3])):
                r0, c0 = cr * CHUNK[2], cc * CHUNK[3]
                r1, c1 = min(r0 + CHUNK[2], grid.ROWS), min(c0 + CHUNK[3], grid.COLS)
                out[:, r0:r1, c0:c1] = self.chunk(yi, cr, cc)[d0 : d0 + days, : r1 - r0, : c1 - c0]
        return out


# --- coverage ---------------------------------------------------------------


def _ym(s: str) -> tuple[int, int]:
    y, m = s.split("-")
    return int(y), int(m)


def _months(first: tuple[int, int], last: tuple[int, int]):
    y, m = first
    while (y, m) <= last:
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


@dataclass
class Coverage:
    product: str
    ok: bool
    problems: list[str] = field(default_factory=list)
    first_day: dt.date | None = None
    final_through: dt.date | None = None
    months: int = 0
    lag_days: int | None = None


def check_coverage(doc: dict | None, product: str, today: dt.date, max_lag_days: int = DEFAULT_MAX_LAG_DAYS, first_month: str | None = None) -> Coverage:
    """A finals manifest against Round 1's contiguity rule and the lag."""
    cov = Coverage(product, ok=False)
    if doc is None:
        cov.problems.append(f"the copy has no {product}/manifest.json")
        return cov
    if doc.get("product") != product:
        cov.problems.append(f"{product}/manifest.json names product {doc.get('product')!r}")
    files = doc.get("files") or []
    unnamed = [f.get("url") for f in files if manifest.file_month(f.get("url", "")) is None]
    if unnamed:
        cov.problems.append(f"{len(unnamed)} file(s) name no month, e.g. {unnamed[0]!r}")
    held = sorted({ym for f in files if (ym := manifest.file_month(f.get("url", ""))) is not None})
    if not held:
        cov.problems.append("the manifest holds no month")
        return cov
    want_first = _ym(first_month or FIRST_MONTH[product])
    if held[0] != want_first:
        cov.problems.append(f"the first month held is {held[0][0]}-{held[0][1]:02d}, not {want_first[0]}-{want_first[1]:02d}")
    gaps = [f"{y}-{m:02d}" for y, m in _months(held[0], held[-1]) if (y, m) not in set(held)]
    if gaps:
        more = f" and {len(gaps) - 10} more" if len(gaps) > 10 else ""
        cov.problems.append(f"{len(gaps)} month(s) missing between the first and the last held: {', '.join(gaps[:10])}{more}")
    run = manifest.finals_coverage(files)
    cov.months = len(held)
    cov.first_day = dt.date.fromisoformat(run[0])
    ft = doc.get("finalThrough")
    if ft is None:
        cov.problems.append("finalThrough is null")
    else:
        cov.final_through = dt.date.fromisoformat(ft)
        if ft != run[1]:
            cov.problems.append(f"finalThrough {ft} is not the end of the contiguous months ({run[1]})")
        cov.lag_days = (today - cov.final_through).days
        if cov.lag_days > max_lag_days:
            cov.problems.append(f"finalThrough {ft} is {cov.lag_days} days behind {today}, over {max_lag_days}")
    cov.ok = not cov.problems
    return cov


# --- the CHC sample ---------------------------------------------------------


@dataclass(frozen=True)
class Sample:
    product: str
    day: dt.date
    row: int
    col: int

    @property
    def lat(self) -> float:
        return round(grid.ORIGIN["lat"] + self.row * grid.STEP, 3)

    @property
    def lon(self) -> float:
        return round(grid.ORIGIN["lon"] + self.col * grid.STEP, 3)


def plan_samples(n: int, seed: int, spans: dict[str, tuple[dt.date, dt.date]]) -> list[Sample]:
    """`n` cell-days, split evenly across the products (the remainder to the
    first ones), and within each product evenly across its years: year k of
    the product's n_p samples is the year at the centre of the k-th of n_p
    equal slices of its span, so every decade is drawn from, not only the
    years a uniform draw happened to land on. The day (within the span) and
    the cell are uniform. The same seed gives the same sample."""
    rng = random.Random(seed)
    products = [p for p in spans if spans[p][0] <= spans[p][1]]
    out: list[Sample] = []
    for i, p in enumerate(products):
        n_p = n // len(products) + (1 if i < n % len(products) else 0)
        first, last = spans[p]
        years = list(range(first.year, last.year + 1))
        for k in range(n_p):
            year = years[int((k + 0.5) * len(years) / n_p)]
            lo = max(first, dt.date(year, 1, 1))
            hi = min(last, dt.date(year, 12, 31))
            day = lo + dt.timedelta(days=rng.randrange((hi - lo).days + 1))
            out.append(Sample(p, day, rng.randrange(grid.ROWS), rng.randrange(grid.COLS)))
    return out


def chc_url(product: str, day: dt.date, base: str = CHC_BASE) -> str:
    return f"{base}/CHIRPS/v3.0/daily/final/{product}/{day.year}/chirps-v3.0.{product}.{day:%Y.%m.%d}.tif"


def http_range_reader(client: polite.PoliteClient, url: str):
    """tiffread's RangeRead over the polite client: None on 404."""

    def read(first: int, last: int) -> bytes | None:
        try:
            r = client.get(url, byte_range=(first, last))
        except polite.HttpError as e:
            if e.status == 404:
                return None
            if e.status == 416:  # the range starts past the end of the file
                return b""
            raise
        body = r.body or b""
        if r.status == 200 and len(body) > last - first + 1:  # Range ignored: the whole file
            body = body[first : last + 1]
        return body

    return read


def bits_of(v) -> int | None:
    """float32 bits, or None for NaN (the copy's no data)."""
    f = np.float32(v)
    return None if np.isnan(f) else struct.unpack("<I", struct.pack("<f", f))[0]


def float_of(bits: int | None) -> str:
    if bits is None:
        return "no data"
    return f"{struct.unpack('<f', struct.pack('<I', bits))[0]!r} (0x{bits:08x})"


@dataclass
class ChcResult:
    checked: int = 0
    equal: int = 0
    no_data: int = 0
    wet: int = 0
    mismatches: list[tuple[Sample, str, str]] = field(default_factory=list)
    errors: list[tuple[Sample, str]] = field(default_factory=list)
    stopped: str | None = None
    requests: int = 0

    @property
    def ok(self) -> bool:
        return self.stopped is None and not self.mismatches and not self.errors and self.checked > 0


def check_chc(samples: list[Sample], arrays: dict[str, FinalsArray], client: polite.PoliteClient, base: str = CHC_BASE, progress=None) -> ChcResult:
    """Each sample from the copy and from CHC's daily TIFF, bit for bit.
    A 403 (polite.StopRun) or a refusal to wait (RetryLater) stops the run."""
    res = ChcResult()
    for i, s in enumerate(samples):
        if progress and i and i % 20 == 0:
            progress(f"chc: {i}/{len(samples)} cell-days, {client.requests} requests")
        copy_bits = bits_of(arrays[s.product].value(s.day, s.row, s.col))
        read = http_range_reader(client, chc_url(s.product, s.day, base))
        try:
            g = tiffread.open_grid(read)
            if g is None:
                res.errors.append((s, "CHC has no daily file for the day (HTTP 404)"))
                continue
            chc_bits = tiffread.read_pixel_bits(read, g, s.lat, s.lon)
        except (polite.StopRun, polite.RetryLater) as e:
            res.stopped = str(e)
            break
        except (polite.HttpError, tiffread.TiffFormatError, OSError) as e:
            res.errors.append((s, str(e)))
            continue
        finally:
            res.requests = client.requests
        res.checked += 1
        if copy_bits == chc_bits:
            res.equal += 1
            if chc_bits is None:
                res.no_data += 1
            elif np.frombuffer(struct.pack("<I", chc_bits), "<f4")[0] >= WET_MM:
                res.wet += 1
        else:
            res.mismatches.append((s, float_of(copy_bits), float_of(chc_bits)))
    return res


# --- dynamical.org ----------------------------------------------------------


def pick_months(first: dt.date, last: dt.date, seed: int) -> list[tuple[int, int]]:
    """One whole month per decade within [first, last], seeded."""
    rng = random.Random(seed)
    whole = [
        (y, m)
        for y, m in _months((first.year, first.month), (last.year, last.month))
        if dt.date(y, m, 1) >= first and dt.date(y, m, calendar.monthrange(y, m)[1]) <= last
    ]
    out = []
    for decade in sorted({y // 10 for y, _ in whole}):
        out.append(rng.choice([ym for ym in whole if ym[0] // 10 == decade]))
    return out


def dynamical_to_copy(raw_north_up: np.ndarray) -> np.ndarray:
    """dynamical.org's kg m-2 s-1, north-up, to the copy's mm/day, south-up."""
    return (np.asarray(raw_north_up, dtype=np.float32)[:, ::-1, :] * SECONDS_PER_DAY).astype(np.float32)


@dataclass
class DynResult:
    month: str
    cell_days: int
    land: int
    mask_mismatch: int
    wet: int
    exact: int
    median: float | None
    p99: float | None
    max: float | None
    max_abs_mm: float | None
    problems: list[str]

    @property
    def ok(self) -> bool:
        return not self.problems


def compare_dynamical(month: str, copy: np.ndarray, dyn_mm: np.ndarray, tolerance: float = DEFAULT_TOLERANCE) -> DynResult:
    """The copy's region against dynamical.org's, both mm/day, south-up."""
    problems = []
    if copy.shape != dyn_mm.shape:
        problems.append(f"shapes differ: copy {copy.shape}, dynamical.org {dyn_mm.shape}")
        return DynResult(month, int(copy.size), 0, 0, 0, 0, None, None, None, None, problems)
    sea_c, sea_d = np.isnan(copy), np.isnan(dyn_mm)
    mismatch = int(np.count_nonzero(sea_c != sea_d))
    if mismatch:
        problems.append(f"the land/sea mask differs on {mismatch} cell-days")
    land = ~sea_c & ~sea_d
    a, b = copy[land], dyn_mm[land]
    wet = a >= WET_MM
    rel = np.abs(b[wet] - a[wet]) / a[wet]
    med = p99 = mx = None
    if rel.size:
        med, p99, mx = float(np.median(rel)), float(np.percentile(rel, 99)), float(rel.max())
        if mx > tolerance:
            problems.append(f"the relative difference on wet cell-days reaches {mx * 100:.3f}%, over {tolerance * 100:.3f}% ({int(np.count_nonzero(rel > tolerance))} cell-days)")
    else:
        problems.append("no wet cell-day (>= 1 mm) to compare")
    return DynResult(
        month,
        int(copy.size),
        int(land.sum()),
        mismatch,
        int(rel.size),
        int(np.count_nonzero(a == b)),
        med,
        p99,
        mx,
        float(np.abs(b - a).max()) if a.size else None,
        problems,
    )


class Dynamical:
    """dynamical.org's public Icechunk store (anonymous); needs requirements-verify.txt."""

    def __init__(self):
        try:
            import icechunk
            import xarray as xr
        except ImportError as e:
            raise SystemExit(f"verify_copy: the dynamical check needs icechunk and xarray ({e}); run it through `ingest/dev.sh verify`, which installs requirements-verify.txt") from None
        storage = icechunk.s3_storage(bucket=DYNAMICAL["bucket"], prefix=DYNAMICAL["prefix"], region=DYNAMICAL["region"], anonymous=True)
        session = icechunk.Repository.open(storage).readonly_session("main")
        self.da = xr.open_zarr(session.store, chunks=None)[DYNAMICAL["variable"]]

    def last_day(self) -> dt.date:
        return dt.date.fromisoformat(str(self.da.time.values[-1])[:10])

    def first_day(self) -> dt.date:
        return dt.date.fromisoformat(str(self.da.time.values[0])[:10])

    def month(self, year: int, month: int) -> np.ndarray:
        """The region for a month, north-up, in dynamical.org's units, its
        coordinates checked against D1's cell centres."""
        days = calendar.monthrange(year, month)[1]
        top = grid.ORIGIN["lat"] + (grid.ROWS - 1) * grid.STEP
        right = grid.ORIGIN["lon"] + (grid.COLS - 1) * grid.STEP
        sub = self.da.sel(
            time=slice(f"{year}-{month:02d}-01", f"{year}-{month:02d}-{days:02d}"),
            latitude=slice(top + 1e-3, grid.ORIGIN["lat"] - 1e-3),
            longitude=slice(grid.ORIGIN["lon"] - 1e-3, right + 1e-3),
        )
        if sub.shape != (days, grid.ROWS, grid.COLS):
            raise ValueError(f"dynamical.org's {year}-{month:02d} is {sub.shape}, not {(days, grid.ROWS, grid.COLS)}")
        lat = np.asarray(sub.latitude.values, dtype=np.float64)[::-1]
        lon = np.asarray(sub.longitude.values, dtype=np.float64)
        if np.abs(lat - (grid.ORIGIN["lat"] + np.arange(grid.ROWS) * grid.STEP)).max() > 1e-3 or np.abs(lon - (grid.ORIGIN["lon"] + np.arange(grid.COLS) * grid.STEP)).max() > 1e-3:
            raise ValueError(f"dynamical.org's {year}-{month:02d} cells are not D1's cell centres")
        return np.asarray(sub.values)


# --- the report -------------------------------------------------------------


def _pct(v: float | None) -> str:
    return "n/a" if v is None else f"{v * 100:.3f}%"


def report(mirror_url: str, today: dt.date, coverage: list[Coverage] | None, chc: ChcResult | None, chc_n: int, seed: int, dyn: list[DynResult] | None, dyn_errors: list[str], tolerance: float) -> tuple[str, bool]:
    ok = True
    lines = [f"# Copy verification: {mirror_url}", "", f"Run {today.isoformat()} (issue #604 R3-E, `ingest/verify_copy.py`).", ""]
    summary = []
    if coverage is not None:
        c_ok = all(c.ok for c in coverage)
        ok &= c_ok
        summary.append(("Coverage", c_ok))
        lines += ["## Coverage", "", "| Product | Months | From | finalThrough | Lag (days) | Result |", "| --- | --- | --- | --- | --- | --- |"]
        for c in coverage:
            lines.append(f"| {c.product} | {c.months} | {c.first_day or '-'} | {c.final_through or '-'} | {'-' if c.lag_days is None else c.lag_days} | {'pass' if c.ok else 'FAIL'} |")
        lines.append("")
        for c in coverage:
            for p in c.problems:
                lines.append(f"- **{c.product}:** {p}")
        lines.append("")
    if chc is not None:
        ok &= chc.ok
        summary.append(("CHC daily files (bit-equal)", chc.ok))
        lines += [
            "## Against CHC's daily files",
            "",
            f"{chc_n} cell-days planned (seed {seed}), {chc.checked} checked with {chc.requests} requests: "
            f"**{chc.equal} bit-equal** ({chc.no_data} no data on both sides, {chc.wet} wet >= 1 mm), "
            f"{len(chc.mismatches)} different, {len(chc.errors)} unreadable.",
            "",
        ]
        if chc.stopped:
            lines += [f"**Stopped:** {chc.stopped}", ""]
        if chc.mismatches:
            lines += ["| Product | Day | Lat | Lon | Copy | CHC |", "| --- | --- | --- | --- | --- | --- |"]
            lines += [f"| {s.product} | {s.day} | {s.lat} | {s.lon} | {a} | {b} |" for s, a, b in chc.mismatches]
            lines.append("")
        for s, e in chc.errors:
            lines.append(f"- {s.product} {s.day} ({s.lat}, {s.lon}): {e}")
        if chc.errors:
            lines.append("")
    if dyn is not None:
        d_ok = not dyn_errors and bool(dyn) and all(r.ok for r in dyn)
        ok &= d_ok
        summary.append(("dynamical.org (whole region)", d_ok))
        lines += [
            f"## Against dynamical.org ({DYNAMICAL_PRODUCT}, whole region)",
            "",
            f"Tolerance {_pct(tolerance)} on wet cell-days (>= {WET_MM:g} mm); the land/sea mask must match exactly.",
            "",
            "| Month | Land cell-days | Mask differs | Wet | Exact | Median | p99 | Max | Max abs (mm) | Result |",
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ]
        for r in dyn:
            mabs = "n/a" if r.max_abs_mm is None else f"{r.max_abs_mm:.3f}"
            lines.append(f"| {r.month} | {r.land} | {r.mask_mismatch} | {r.wet} | {r.exact} | {_pct(r.median)} | {_pct(r.p99)} | {_pct(r.max)} | {mabs} | {'pass' if r.ok else 'FAIL'} |")
        lines.append("")
        for r in dyn:
            for p in r.problems:
                lines.append(f"- **{r.month}:** {p}")
        for e in dyn_errors:
            lines.append(f"- {e}")
        if not dyn and not dyn_errors:
            lines.append("- no month to compare")
        lines.append("")
    head = ["## Result", "", f"**{'PASS' if ok else 'FAIL'}**", ""] + [f"- {name}: {'pass' if good else 'FAIL'}" for name, good in summary] + [""]
    return "\n".join(lines[:4] + head + lines[4:]), ok


# --- main -------------------------------------------------------------------


def main(argv: list[str] | None = None, client: polite.PoliteClient | None = None, s3_client=None, dynamical=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mirror", default=os.environ.get("MIRROR_URL"), help="the copy (default: $MIRROR_URL)")
    ap.add_argument("--checks", default="coverage,chc,dynamical", help="comma-separated: coverage, chc, dynamical (default: all)")
    ap.add_argument("--no-network", action="store_true", help="only the coverage check")
    ap.add_argument("--samples", type=int, default=200, help="cell-days for the CHC check (default 200)")
    ap.add_argument("--seed", type=int, default=604)
    ap.add_argument("--month", action="append", default=[], help="YYYY-MM for the dynamical check (repeatable; default: one a decade)")
    ap.add_argument("--tolerance", type=float, default=DEFAULT_TOLERANCE, help="relative, on wet cell-days (default 0.002)")
    ap.add_argument("--max-lag-days", type=int, default=DEFAULT_MAX_LAG_DAYS)
    ap.add_argument("--first-month", help="YYYY-MM every product must start at (default: rnl 1981-01, sat 2000-06)")
    ap.add_argument("--today", help="YYYY-MM-DD (default: today, UTC)")
    ap.add_argument("--chc-base", default=CHC_BASE)
    ap.add_argument("--contact", default=os.environ.get("INGEST_CONTACT"), help="the User-Agent's contact (default: $INGEST_CONTACT)")
    ap.add_argument("--out", help="write the report here instead of stdout")
    a = ap.parse_args(argv)

    checks = {"coverage"} if a.no_network else {c.strip() for c in a.checks.split(",") if c.strip()}
    unknown = checks - {"coverage", "chc", "dynamical"}
    if unknown or not checks:
        ap.error(f"unknown check(s): {', '.join(sorted(unknown)) or '(none)'}")
    if not a.mirror:
        ap.error("no copy: pass --mirror or set MIRROR_URL")
    if a.samples < 1:
        ap.error("--samples must be at least 1")
    today = dt.date.fromisoformat(a.today) if a.today else dt.datetime.now(dt.UTC).date()
    log = lambda msg: print(f"verify_copy: {msg}", file=sys.stderr)  # noqa: E731

    store = CopyStore(a.mirror, s3_client=s3_client)
    # Coverage always runs: the other checks sample within the spans it finds.
    coverage = [check_coverage(store.json(manifest.key(p)), p, today, a.max_lag_days, a.first_month) for p in FINALS]
    spans = {c.product: (c.first_day, c.final_through) for c in coverage if c.first_day and c.final_through}

    chc = None
    if "chc" in checks:
        try:
            arrays = {p: FinalsArray(store, p) for p in spans}
        except CopyFormatError as e:
            chc = ChcResult(stopped=f"the copy can't be read: {e}")
        else:
            samples = plan_samples(a.samples, a.seed, spans)
            client = client or polite.PoliteClient(contact=a.contact, min_interval=1.0)
            log(f"chc: {len(samples)} cell-days, about {3 * len(samples)} requests at one a second")
            chc = check_chc(samples, arrays, client, a.chc_base, progress=log)

    dyn = dyn_errors = None
    if "dynamical" in checks:
        dyn, dyn_errors = [], []
        if DYNAMICAL_PRODUCT not in spans:
            dyn_errors.append(f"the copy holds no {DYNAMICAL_PRODUCT} to compare")
        else:
            try:
                d = dynamical or Dynamical()
                first, last = spans[DYNAMICAL_PRODUCT]
                first, last = max(first, d.first_day()), min(last, d.last_day())
                months = [_ym(m) for m in a.month] if a.month else pick_months(first, last, a.seed)
                arr = FinalsArray(store, DYNAMICAL_PRODUCT)
                for y, m in months:
                    log(f"dynamical: {y}-{m:02d}")
                    days = calendar.monthrange(y, m)[1]
                    copy = arr.region(dt.date(y, m, 1), days)
                    dyn.append(compare_dynamical(f"{y}-{m:02d}", copy, dynamical_to_copy(d.month(y, m)), a.tolerance))
            except (ValueError, OSError, CopyFormatError) as e:
                dyn_errors.append(f"dynamical.org: {e}")

    text, ok = report(a.mirror, today, coverage if "coverage" in checks else None, chc, a.samples, a.seed, dyn, dyn_errors or [], a.tolerance)
    if "coverage" not in checks and not all(c.ok for c in coverage):
        # The other checks lean on the manifests; a broken one is still a failure.
        text += "\n" + "\n".join(f"- **{c.product} coverage:** {p}" for c in coverage for p in c.problems) + "\n"
        ok = False
    if a.out:
        Path(a.out).write_text(text)
        log(f"report written to {a.out}")
    else:
        sys.stdout.write(text)
    log("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
