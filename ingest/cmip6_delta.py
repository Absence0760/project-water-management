"""NEX-GDDP-CMIP6's monthly aggregates for region D1, copied once (issue #621
slice 2): products `cmip6/<model>/<scenario>`, which the future yield's change
factors are computed from (slices 3-4; nothing reads the copy yet).

    python3 ingest/cmip6_delta.py plan --mirror <MIRROR_URL> [--source s3|fixtures|<dir>] [--models A,B] [--scenarios …]
    python3 ingest/cmip6_delta.py copy --mirror <MIRROR_URL> [--source …] [--models …] [--scenarios …] [--recheck]

(`ingest/dev.sh cmip6 …` runs it with ingest/.venv.) **Operator-run, once**:
not in the ingest image, never scheduled, never run by the app. The archive
is static (no further updates are planned), so there is nothing to keep
fresh. The recommended run is in us-west-2, next to the bucket (CloudShell or
a temporary instance), writing only the regional monthly aggregates to the
copy in af-south-1: docs/deployment.md § NEX-GDDP-CMIP6 (one-off).

**Source.** `s3://nex-gddp-cmip6/NEX-GDDP-CMIP6/` (us-west-2, anonymous,
read unsigned): NASA NEX's BCSD downscaling of CMIP6 against GMFD, daily, on
a global 0.25 deg grid, one file a variable, model, scenario and year:

    NEX-GDDP-CMIP6/<model>/<scenario>/<variant>/<var>/<var>_day_<model>_<scenario>_<variant>_<grid>_<YYYY>[_v<N.N>].nc

A re-released file carries a version suffix (`_v1.1`, `_v2.0`, …); a name
with none is the first release, recorded as `v1.0`. For each variable and
year the highest version listed is read. A model with more than one variant
directory must have its variant pinned in `MODELS`. `plan` lists exactly
what `copy` would read (and what is missing) without reading a byte of data:
run it first, since the bucket's layout is **unverified until the first live
run** (no session has listed it; the layout here is the registry's and the
Scientific Data paper's).

**Licence.** The AWS Open Data registry's NEX-GDDP-CMIP6 page (read
2026-10-27) says every output is under CC0 since September 2022; the archive
was first released under CC BY-SA 4.0, and some files may still say so. So
each file's own global `license` attribute is recorded **verbatim** in the
manifest (null when it has none), and `copy` prints every distinct value it
met. NASA NEX and the CMIP6 modelling groups are credited anyway (`CREDIT`,
`CITATION`); the register row is docs/data-sources.md § nex-gddp-cmip6.

**What is read.** `pr`, `tasmax` and `tasmin` for `MODELS` x `SCENARIOS`
(`historical`, `ssp245`, `ssp585`) over `YEARS` (the baseline window
1985-2014 for historical; 2036-2095 for the SSPs, both future windows). The
file is opened through ranged reads (`S3RangeFile`, a block cache), and only
D1's cells are asked of HDF5, so a file chunked by region costs a fraction of
its size; a file chunked by whole days costs its compressed size, in-region.
Each file must be the layout below, or the run stops before writing it:

- `<var>(time, lat, lon)`, floating point, unpacked (no `scale_factor` or
  `add_offset`), `_FillValue`/`missing_value` as no data;
- `lat` and `lon` in 0.25 deg steps (either direction) whose cells include
  every D1 cell centre (x.125, x.375, …): cells are **placed by coordinate**,
  never by position, and anything outside D1 is dropped;
- `time` in "days since" or "hours since" an epoch, in its `calendar`
  (`standard`/`gregorian`/`proleptic_gregorian`, `noleap`/`365_day`,
  `all_leap`/`366_day` or `360_day`), exactly the file's year, every day once
  in order (a 360-day model's months are 30 days);
- pr in kg m-2 s-1 (x 86400 = mm/day; a day below -`NEGATIVE_MM` or above
  `MAX_DAILY_MM` fails the run, down to that clamped to 0); tasmax and tasmin
  in K, within `MIN_K`-`MAX_K`.

**What is stored** (monthly aggregates only, never a day). Per product a Zarr
group `cmip6/<model>/<scenario>` with three float32 arrays, NaN fill,
[bytes little-endian, gzip 6], dims (year, month, lat, lon), shape (years of
the scenario's record, 12, 110, 124) on `grid.CMIP6` (0.25 deg cells tiling
D1, [0, 0] centred at 35.375 S, 10.125 E, rows northwards), chunk `CHUNKS`
(one year, 22 x 31 cells), year index = year - `firstYear` (1950 for
historical, 2015 for the SSPs; the years not copied stay unwritten):

- `pr_mm`: the month's total (mm), the sum of its days' mm;
- `tasmax_c`, `tasmin_c`: the mean of its days (deg C, K - 273.15).

A cell with any day missing in a month is NaN for that month. The group's
attributes: `model`, `scenario`, `variant`, `gridLabel`, `calendar` (the
same for every file of the product, or the run stops), `firstYear`,
`source`, `licence`, `credit`, `citation`, `region`, `grid`. A year is
written once its three files are read and checked (tasmin's monthly mean no
warmer than tasmax's, by `TMIN_OVER_TMAX_C` at most), then the manifest:
one file per NEX file read, `version` and `license` beside the usual fields,
`valuesSha256` the hash of the file's (month, lat, lon) aggregates
(manifest.values_sha256), `years` the first and last year held. Then
`cmip6/index.json`: `{"products": {model: {scenario: [years held]}}}`.

**Resuming.** A year whose three files the manifest already lists (same
URLs, so the same versions) is skipped without a read, so a run cut short
(a CloudShell session ending) resumes where it stopped. `--recheck` re-reads
them. A newer version of a held year's file is read and replaces the old
entry: with the same aggregates the revision stays; with others it rises by
one, with one `changes` entry for the year (the cells where any of its
variables changed, and the largest absolute change in that variable's own
units). If the copy no longer holds the old aggregates (a run died between
the chunks and the manifest), the change claims every cell and
`UNKNOWN_MAX_ABS_DIFF`, never 0.

**Fixtures mode** (`--source fixtures`, the default of `ingest/dev.sh cmip6`)
reads fixtures/cmip6/make_cmip6_fixture.py's synthetic tree (models SYN-A..C,
two years a scenario), written into a temporary directory; `--source <dir>`
reads a local tree in the bucket's layout. No network either way.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import io
import json
import re
import sys
import tempfile
from collections import OrderedDict
from pathlib import Path
from typing import Callable, Iterable, Sequence

import numpy as np

import grid
import manifest
import zarrstore

GRID = grid.CMIP6
BUCKET = "nex-gddp-cmip6"
BUCKET_REGION = "us-west-2"
ROOT = "NEX-GDDP-CMIP6"
PRODUCT = "cmip6"
INDEX_KEY = f"{PRODUCT}/index.json"
SCENARIOS = ("historical", "ssp245", "ssp585")
VARIABLES = ("pr", "tasmax", "tasmin")
ARRAYS = {"pr": "pr_mm", "tasmax": "tasmax_c", "tasmin": "tasmin_c"}
#: The scenario's record (NEX's): the year axis runs from its first year through its last.
RECORD = {"historical": (1950, 2014), "ssp245": (2015, 2100), "ssp585": (2015, 2100)}
#: The years copied: the baseline window, and both future windows (2036-2065, 2066-2095) in one span.
YEARS = {"historical": tuple(range(1985, 2015)), "ssp245": tuple(range(2036, 2096)), "ssp585": tuple(range(2036, 2096))}
#: The models copied, each with its pinned variant (None: the one variant directory the bucket lists).
#: Frozen in docs/data-sources.md § nex-gddp-cmip6 with the reason for each; keep the two the same.
MODELS: dict[str, str | None] = {
    "ACCESS-CM2": None,
    "CNRM-CM6-1": None,
    "EC-Earth3": None,
    "GFDL-ESM4": None,
    "INM-CM5-0": None,
    "IPSL-CM6A-LR": None,
    "MIROC6": None,
    "MPI-ESM1-2-HR": None,
    "MRI-ESM2-0": None,
    "NorESM2-MM": None,
}
#: One year of one variable on the whole region, 22 x 31 cells a chunk (20 chunks a year).
CHUNKS = (1, 12, 22, 31)
DIMS = ("year", "month", "lat", "lon")

#: A day's rain below zero down to this (mm) is round-off, clamped to 0; further below fails.
NEGATIVE_MM = 0.01
MAX_DAILY_MM = 2000.0
MIN_K = 170.0
MAX_K = 340.0
#: Tolerance (deg C) for a month whose mean tasmin is above its mean tasmax.
TMIN_OVER_TMAX_C = 0.05
#: A change whose old values the copy no longer holds: the widest a monthly total can move (31 days x 2000 mm).
UNKNOWN_MAX_ABS_DIFF = 31 * MAX_DAILY_MM

SOURCE = "NASA Earth Exchange Global Daily Downscaled Projections, CMIP6 (NEX-GDDP-CMIP6), s3://nex-gddp-cmip6"
LICENCE = (
    "CC0 1.0 (Registry of Open Data on AWS, NEX-GDDP-CMIP6, read 2026-10-27: every output under CC0 since September 2022; "
    "first released under CC BY-SA 4.0). Each file's own license attribute is in the manifest."
)
CREDIT = "NEX-GDDP-CMIP6 was prepared by the Climate Analytics Group and NASA Ames Research Center using the NASA Earth Exchange, from the CMIP6 models of the modelling groups listed by model."
CITATION = "Thrasher, B., Wang, W., Michaelis, A. et al. NASA Global Daily Downscaled Projections, CMIP6. Scientific Data 9, 262 (2022). https://doi.org/10.1038/s41597-022-01393-4"
METHOD = "Monthly aggregates of NEX-GDDP-CMIP6's daily values on its 0.25 deg cells inside D1: pr the month's total (mm), tasmax and tasmin the month's mean (deg C); a cell with any day missing is NaN for the month."

_UNITS = re.compile(r"^\s*(days|hours) since (\d{1,4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.\d+)?)?)?\s*(?:UTC|Z)?\s*$")
_PR_UNITS = {"kg m-2 s-1", "kg m^-2 s^-1", "kg/m2/s"}
_GREGORIAN = {"standard", "gregorian", "proleptic_gregorian"}
_MONTH_DAYS = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


class Cmip6FormatError(ValueError):
    """A file that isn't the layout this reader holds to: the run stops before writing its year."""


class ImplausibleValueError(Cmip6FormatError):
    """A value outside the bounds for its variable."""


class MissingFilesError(RuntimeError):
    """The listing lacks files the plan needs: nothing is read."""


def product_of(model: str, scenario: str) -> str:
    return f"{PRODUCT}/{model}/{scenario}"


def file_url(key: str) -> str:
    return f"s3://{BUCKET}/{key}"


# --- calendars --------------------------------------------------------------------------------


def _leap(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def _calendar(name: str) -> str:
    c = (name or "standard").strip().lower()
    if c in _GREGORIAN:
        return "gregorian"
    if c in ("noleap", "365_day"):
        return "noleap"
    if c in ("all_leap", "366_day"):
        return "all_leap"
    if c == "360_day":
        return "360_day"
    raise Cmip6FormatError(f"calendar {name!r} is not one this reader knows")


def month_days(calendar: str, year: int) -> list[int]:
    """The length of each month of `year` in the calendar."""
    c = _calendar(calendar)
    if c == "360_day":
        return [30] * 12
    leap = c == "all_leap" or (c == "gregorian" and _leap(year))
    return [n + (1 if leap and i == 1 else 0) for i, n in enumerate(_MONTH_DAYS)]


def _ordinal(c: str, y: int, m: int, d: int) -> int:
    if c == "gregorian":
        return dt.date(y, m, d).toordinal()
    if c == "360_day":
        return y * 360 + (m - 1) * 30 + d - 1
    per = 366 if c == "all_leap" else 365
    return y * per + sum(month_days(c, y)[: m - 1]) + d - 1


def _from_ordinal(c: str, n: int) -> tuple[int, int, int]:
    if c == "gregorian":
        x = dt.date.fromordinal(n)
        return x.year, x.month, x.day
    per = 360 if c == "360_day" else 366 if c == "all_leap" else 365
    y, r = divmod(n, per)
    for m, length in enumerate(month_days(c, y), start=1):
        if r < length:
            return y, m, r + 1
        r -= length
    raise AssertionError("unreachable")


def decode_time(values: np.ndarray, units: str, calendar: str) -> list[tuple[int, int, int]]:
    """Each time step's (year, month, day) in the calendar; a step is the day it falls in."""
    m = _UNITS.match(units or "")
    if not m:
        raise Cmip6FormatError(f'time units "{units}" are not "days since …" or "hours since …"')
    c = _calendar(calendar)
    ey, emo, ed = int(m[2]), int(m[3]), int(m[4])
    if c == "gregorian" and ey < 1583:
        raise Cmip6FormatError(f"a {calendar} epoch before 1583 ({units}) would need the Julian calendar")
    epoch_frac = (int(m[5] or 0) + int(m[6] or 0) / 60 + int(m[7] or 0) / 3600) / 24
    days = np.asarray(values, dtype=np.float64) / (24.0 if m[1] == "hours" else 1.0) + epoch_frac
    base = _ordinal(c, ey, emo, ed)
    return [_from_ordinal(c, base + int(np.floor(t + 1e-9))) for t in days]


# --- the source -------------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class SourceObject:
    key: str
    size: int | None
    etag: str | None
    last_modified: str | None


class LocalSource:
    """A local tree in the bucket's layout (`<root>/NEX-GDDP-CMIP6/…`): fixtures mode, or files already downloaded."""

    def __init__(self, root: Path):
        self.root = Path(root)

    def list(self, prefix: str) -> list[SourceObject]:
        base = self.root / prefix
        if not base.exists():
            return []
        out = []
        for p in sorted(base.rglob("*")):
            if p.is_file():
                st = p.stat()
                out.append(SourceObject(p.relative_to(self.root).as_posix(), st.st_size, None, None))
        return out

    def open(self, obj: SourceObject):
        return open(self.root / obj.key, "rb")


class S3RangeFile(io.RawIOBase):
    """A read-only file over one S3 object through ranged GETs, with a small block cache (h5py reads it)."""

    def __init__(self, client, bucket: str, key: str, size: int, block: int = 4 << 20, blocks: int = 16):
        self.client, self.bucket, self.key, self.size = client, bucket, key, size
        self.block, self.blocks = block, blocks
        self.pos = 0
        self.cache: OrderedDict[int, bytes] = OrderedDict()
        self.requests = 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=io.SEEK_SET):
        self.pos = offset if whence == io.SEEK_SET else self.pos + offset if whence == io.SEEK_CUR else self.size + offset
        return self.pos

    def _block(self, i: int) -> bytes:
        if i in self.cache:
            self.cache.move_to_end(i)
            return self.cache[i]
        lo = i * self.block
        hi = min(lo + self.block, self.size) - 1
        body = self.client.get_object(Bucket=self.bucket, Key=self.key, Range=f"bytes={lo}-{hi}")["Body"].read()
        self.requests += 1
        self.cache[i] = body
        while len(self.cache) > self.blocks:
            self.cache.popitem(last=False)
        return body

    def readinto(self, b) -> int:
        n = max(0, min(len(b), self.size - self.pos))
        done = 0
        while done < n:
            i, off = divmod(self.pos + done, self.block)
            chunk = self._block(i)[off : off + n - done]
            b[done : done + len(chunk)] = chunk
            done += len(chunk)
        self.pos += n
        return n


class S3Source:
    """The bucket itself, read unsigned (it is anonymous)."""

    def __init__(self, client=None):
        if client is None:
            import boto3
            from botocore import UNSIGNED
            from botocore.config import Config

            client = boto3.client("s3", region_name=BUCKET_REGION, config=Config(signature_version=UNSIGNED, retries={"max_attempts": 10, "mode": "adaptive"}))
        self.client = client

    def list(self, prefix: str) -> list[SourceObject]:
        out = []
        for page in self.client.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=prefix):
            for o in page.get("Contents", []):
                lm = o.get("LastModified")
                out.append(SourceObject(o["Key"], o.get("Size"), o.get("ETag"), lm.strftime("%a, %d %b %Y %H:%M:%S GMT") if lm else None))
        return out

    def open(self, obj: SourceObject):
        return io.BufferedReader(S3RangeFile(self.client, BUCKET, obj.key, obj.size), buffer_size=1 << 16)


# --- the plan ---------------------------------------------------------------------------------


@dataclasses.dataclass
class Planned:
    model: str
    scenario: str
    variant: str | None
    grid_label: str | None
    #: (var, year) -> the object to read (its highest version).
    files: dict[tuple[str, int], SourceObject]
    missing: list[tuple[str, int]]
    problems: list[str]


def _version_key(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in v[1:].split("."))


def plan_product(source, model: str, scenario: str, years: Iterable[int], variant: str | None = None) -> Planned:
    """What `copy` reads for one product: each (var, year)'s highest version, and what the listing lacks."""
    years = sorted(set(years))
    found: dict[str, dict[tuple[str, int], tuple[str, SourceObject, str]]] = {}
    for obj in source.list(f"{ROOT}/{model}/{scenario}/"):
        k = manifest.cmip6_file_key(file_url(obj.key))
        if k is None or k["model"] != model or k["scenario"] != scenario:
            continue
        if k["year"] not in years:
            continue
        slot = found.setdefault(k["variant"], {})
        prev = slot.get((k["var"], k["year"]))
        if prev is None or _version_key(k["version"]) > _version_key(prev[0]):
            slot[(k["var"], k["year"])] = (k["version"], obj, k["gridLabel"])
    problems = []
    if variant is None:
        if len(found) > 1:
            problems.append(f"{model}/{scenario} lists the variants {sorted(found)}: pin one in MODELS")
            variant = None
        else:
            variant = next(iter(found), None)
    chosen = found.get(variant, {}) if variant else {}
    labels = sorted({g for _, _, g in chosen.values()})
    if len(labels) > 1:
        problems.append(f"{model}/{scenario} mixes grid labels {labels}")
    files = {vy: obj for vy, (_, obj, _) in chosen.items()}
    missing = [(v, y) for y in years for v in VARIABLES if (v, y) not in files]
    return Planned(model, scenario, variant, labels[0] if labels else None, files, missing, problems)


def make_plan(source, models: dict[str, str | None], scenarios: Sequence[str], years: dict[str, Iterable[int]]) -> list[Planned]:
    return [plan_product(source, m, s, years[s], v) for m, v in models.items() for s in scenarios]


def plan_text(plans: Sequence[Planned], mirror=None) -> str:
    lines = []
    for p in plans:
        held = _held_urls(mirror, product_of(p.model, p.scenario)) if mirror is not None else set()
        todo = [o for o in p.files.values() if file_url(o.key) not in held]
        size = sum(o.size or 0 for o in todo)
        versions = sorted({manifest.cmip6_file_key(file_url(o.key))["version"] for o in p.files.values()}, key=_version_key)
        lines.append(
            f"{product_of(p.model, p.scenario)}: variant {p.variant}, grid {p.grid_label}, {len(p.files)} files ({', '.join(versions) or 'none'}), "
            f"{len(todo)} to read ({size / 1e9:.1f} GB), {len(p.missing)} missing"
        )
        for v, y in p.missing[:10]:
            lines.append(f"  missing {v} {y}")
        if len(p.missing) > 10:
            lines.append(f"  … and {len(p.missing) - 10} more")
        lines += [f"  problem: {x}" for x in p.problems]
    return "\n".join(lines) + "\n"


# --- reading one file -------------------------------------------------------------------------


def _attr_str(v) -> str | None:
    if v is None:
        return None
    if isinstance(v, bytes):
        return v.decode("utf-8", "replace")
    if isinstance(v, np.ndarray):
        return " ".join(_attr_str(x) or "" for x in v.tolist())
    return str(v)


def _axis(values, origin: float, n: int, name: str) -> np.ndarray:
    """The file index of each region cell's centre along an axis (placed by coordinate)."""
    c = np.asarray(values, dtype=np.float64)
    if c.ndim != 1 or c.size < 2:
        raise Cmip6FormatError(f"{name} has fewer than two values")
    d = np.diff(c)
    if not (np.allclose(d, d[0], atol=1e-4) and abs(abs(d[0]) - GRID.step) < 1e-4):
        raise Cmip6FormatError(f"{name} is not in {GRID.step} deg steps")
    want = origin + np.arange(n) * GRID.step
    idx = np.rint((want - c[0]) / d[0]).astype(np.int64)
    if idx.min() < 0 or idx.max() >= c.size:
        raise Cmip6FormatError(f"{name} ({c.min():.3f}..{c.max():.3f}) does not cover the region")
    if np.max(np.abs(c[idx] - want)) > GRID.step / 4:
        raise Cmip6FormatError(f"{name} cell centres are off the 0.25 deg grid (found {c[idx[0]]}, expected {want[0]})")
    return idx


@dataclasses.dataclass
class FileMonths:
    """One file's monthly aggregates on the region: values[month, row, col] (mm or deg C), and what it said of itself."""

    values: np.ndarray
    calendar: str
    license: str | None


def read_file(fileobj, var: str, year: int, where: str = "the file") -> FileMonths:
    """The region's monthly aggregates from one NEX daily file, refusing any other layout."""
    import h5netcdf

    with h5netcdf.File(fileobj, "r") as f:
        if var not in f.variables:
            raise Cmip6FormatError(f"{where} has no variable {var}")
        x = f.variables[var]
        if tuple(x.dimensions) != ("time", "lat", "lon"):
            raise Cmip6FormatError(f"{where}: {var} dims are {tuple(x.dimensions)}, expected (time, lat, lon)")
        if x.dtype.kind != "f":
            raise Cmip6FormatError(f"{where}: {var} is {x.dtype}, expected floating point")
        for packed in ("scale_factor", "add_offset"):
            if packed in x.attrs:
                raise Cmip6FormatError(f"{where}: {var} carries {packed}; the copy expects unpacked values")
        units = (_attr_str(x.attrs.get("units")) or "").strip()
        if var == "pr" and units not in _PR_UNITS:
            raise Cmip6FormatError(f"{where}: pr is in {units!r}, expected kg m-2 s-1")
        if var != "pr" and units != "K":
            raise Cmip6FormatError(f"{where}: {var} is in {units!r}, expected K")
        fills = {float(np.asarray(x.attrs[k]).ravel()[0]) for k in ("_FillValue", "missing_value") if k in x.attrs}
        t = f.variables["time"]
        calendar = _attr_str(t.attrs.get("calendar")) or "standard"
        ymd = decode_time(t[:], _attr_str(t.attrs.get("units")) or "", calendar)
        lengths = month_days(calendar, year)
        if len(ymd) != sum(lengths) or len(ymd) != x.shape[0]:
            raise Cmip6FormatError(f"{where} holds {len(ymd)} days, not the {sum(lengths)} of {year} in its {calendar} calendar")
        c = _calendar(calendar)
        ords = [_ordinal(c, *d) for d in ymd]
        if ymd[0] != (year, 1, 1) or any(b - a != 1 for a, b in zip(ords, ords[1:])):
            raise Cmip6FormatError(f"{where}: time is not every day of {year} once, in order (first {ymd[0]})")
        rows = _axis(f.variables["lat"][:], GRID.origin["lat"], GRID.rows, "lat")
        cols = _axis(f.variables["lon"][:], GRID.origin["lon"], GRID.cols, "lon")
        block = np.asarray(x[:, rows.min() : rows.max() + 1, cols.min() : cols.max() + 1], dtype=np.float64)
        license_ = _attr_str(f.attrs.get("license"))
    days = block[:, rows - rows.min()][:, :, cols - cols.min()]
    for fill in {v for f in fills for v in (f, float(np.float32(f)))}:
        days[days == fill] = np.nan
    if var == "pr":
        days = days * 86400.0
        _check(days, -NEGATIVE_MM, MAX_DAILY_MM, "mm/day", where, ymd)
        days[days < 0] = 0.0
    else:
        _check(days, MIN_K, MAX_K, "K", where, ymd)
        days = days - 273.15
    # The days run in order through the year (checked above), so each month is one run of them; a NaN day makes its month NaN.
    starts = np.cumsum([0, *lengths[:-1]])
    totals = np.add.reduceat(days, starts, axis=0)
    if var != "pr":
        totals /= np.asarray(lengths, dtype=np.float64)[:, None, None]
    return FileMonths(totals.astype(np.float32), calendar, license_)


def _check(days: np.ndarray, lo: float, hi: float, unit: str, where: str, ymd) -> None:
    bad = ~np.isnan(days) & ((days < lo) | (days > hi))
    if bad.any():
        d, r, c = (int(i) for i in np.argwhere(bad)[0])
        lat = GRID.origin["lat"] + r * GRID.step
        lon = GRID.origin["lon"] + c * GRID.step
        raise ImplausibleValueError(
            f"{where} has {int(bad.sum())} value(s) outside {lo:g}-{hi:g} {unit}, the first {days[d, r, c]:.3f} on {ymd[d]} at {lat:.3f}, {lon:.3f}"
        )


# --- writing ----------------------------------------------------------------------------------


def _ensure_groups(store, path: str):
    import zarr

    zarr.open_group(store=store, mode="a", zarr_format=3)
    parts = path.split("/")
    g = None
    for i in range(1, len(parts) + 1):
        g = zarr.open_group(store=store, path="/".join(parts[:i]), mode="a", zarr_format=3)
    return g


def _array(store, root: Path, product: str, var: str, scenario: str):
    import zarr
    from zarr.codecs import BytesCodec, GzipCodec

    path = f"{product}/{ARRAYS[var]}"
    first, last = RECORD[scenario]
    attrs = {
        "units": "mm" if var == "pr" else "degC",
        "aggregation": "monthly total" if var == "pr" else "monthly mean",
        "long_name": {"pr": "monthly precipitation total", "tasmax": "monthly mean of daily maximum near-surface air temperature", "tasmin": "monthly mean of daily minimum near-surface air temperature"}[var],
        "firstYear": first,
        **GRID.attrs,
    }
    if (root / path / "zarr.json").exists():
        arr = zarr.open_array(store=store, path=path, mode="r+", zarr_format=3)
        if arr.chunks != CHUNKS or arr.dtype != np.float32 or tuple(arr.metadata.dimension_names) != DIMS or arr.attrs.get("firstYear") != first:
            raise ValueError(f"{path}/zarr.json does not hold the layout this writer expects")
        return arr
    return zarr.create_array(
        store=store,
        name=path,
        shape=(last - first + 1, 12, GRID.rows, GRID.cols),
        chunks=CHUNKS,
        dtype="float32",
        fill_value=np.nan,
        serializer=BytesCodec(endian="little"),
        compressors=[GzipCodec(level=zarrstore.GZIP_LEVEL)],
        filters=None,
        dimension_names=DIMS,
        attributes=attrs,
    )


def group_attrs(model: str, scenario: str, variant: str, grid_label: str, calendar: str) -> dict:
    return {
        "model": model,
        "scenario": scenario,
        "variant": variant,
        "gridLabel": grid_label,
        "calendar": calendar,
        "firstYear": RECORD[scenario][0],
        "variables": dict(ARRAYS),
        "source": SOURCE,
        "licence": LICENCE,
        "credit": CREDIT,
        "citation": CITATION,
        "method": METHOD,
        **GRID.attrs,
    }


def write_year(mirror, model: str, scenario: str, year: int, months: dict[str, np.ndarray], attrs: dict) -> dict[str, np.ndarray]:
    """Write one year of the three arrays; return what they held for that year before (NaN where unwritten)."""
    import zarr

    product = product_of(model, scenario)
    yi = year - RECORD[scenario][0]
    if not 0 <= yi <= RECORD[scenario][1] - RECORD[scenario][0]:
        raise ValueError(f"{year} is outside {scenario}'s record {RECORD[scenario]}")
    prefixes = [f"{PRODUCT}/zarr.json", f"{PRODUCT}/{model}/zarr.json", f"{product}/zarr.json"]
    for var in VARIABLES:
        prefixes += [f"{product}/{ARRAYS[var]}/zarr.json", f"{product}/{ARRAYS[var]}/c/{yi}/"]
    old = {}
    with mirror.stage(prefixes) as root:
        store = zarr.storage.LocalStore(root)
        g = _ensure_groups(store, product)
        for k in ("variant", "gridLabel", "calendar"):
            if k in g.attrs and g.attrs[k] != attrs[k]:
                raise ValueError(f"{product} holds {k} {g.attrs[k]!r}; this file says {attrs[k]!r}")
        for var in VARIABLES:
            arr = _array(store, root, product, var, scenario)
            old[var] = np.array(arr[yi])
            arr[yi] = months[var]
        g.attrs.update(attrs)
    return old


def _held_urls(mirror, product: str) -> set[str]:
    m = manifest.read(mirror, product)
    return {f["url"] for f in m["files"]} if m else set()


def held_years(m: dict) -> list[int]:
    """The years whose three variables the manifest lists."""
    by_year: dict[int, set[str]] = {}
    for f in m["files"]:
        k = manifest.cmip6_file_key(f["url"])
        if k:
            by_year.setdefault(k["year"], set()).add(k["var"])
    return sorted(y for y, vs in by_year.items() if vs >= set(VARIABLES))


def _write_index(mirror, product: str, years: list[int]) -> None:
    doc = mirror.read_json(INDEX_KEY) or {"products": {}}
    _, model, scenario = product.split("/")
    doc["products"].setdefault(model, {})[scenario] = years
    mirror.write_json(INDEX_KEY, {"products": {m: {s: doc["products"][m][s] for s in sorted(doc["products"][m], key=SCENARIOS.index)} for m in sorted(doc["products"])}})


def _diff(old: np.ndarray, new: np.ndarray) -> tuple[np.ndarray, float]:
    """The (lat, lon) cells where any month differs (NaN-aware), and the largest absolute difference."""
    differs = ~((old == new) | (np.isnan(old) & np.isnan(new)))
    both = ~np.isnan(old) & ~np.isnan(new)
    mad = float(np.max(np.abs(old[both] - new[both]))) if both.any() else 0.0
    return differs.any(axis=0), mad


def copy_year(mirror, source, p: Planned, year: int, m: dict, now: Callable[[], str] = manifest.utc_now, log: Callable[[str], None] = print) -> str:
    """Read one year's three files, check them, write them, and update the manifest `m` (written by the caller)."""
    product = product_of(p.model, p.scenario)
    read: dict[str, tuple[SourceObject, FileMonths]] = {}
    for var in VARIABLES:
        obj = p.files[(var, year)]
        with source.open(obj) as fh:
            read[var] = (obj, read_file(fh, var, year, file_url(obj.key)))
    calendars = {fm.calendar for _, fm in read.values()}
    if len(calendars) != 1:
        raise Cmip6FormatError(f"{product} {year}: the three files disagree on the calendar ({sorted(calendars)})")
    over = read["tasmin"][1].values - read["tasmax"][1].values
    if np.nanmax(over, initial=-np.inf) > TMIN_OVER_TMAX_C:
        raise ImplausibleValueError(f"{product} {year}: a month's mean tasmin is {np.nanmax(over):.2f} deg C above its mean tasmax")
    months = {var: fm.values for var, (_, fm) in read.items()}
    attrs = group_attrs(p.model, p.scenario, p.variant, p.grid_label, calendars.pop())
    previous = {}
    for f in m["files"]:
        k = manifest.cmip6_file_key(f["url"])
        if k and k["year"] == year:
            previous[k["var"]] = f
    old = write_year(mirror, p.model, p.scenario, year, months, attrs)
    changed_cells = np.zeros((GRID.rows, GRID.cols), dtype=bool)
    mad = 0.0
    unknown = False
    hashes = {var: manifest.values_sha256(months[var]) for var in VARIABLES}
    changed = [var for var in VARIABLES if var in previous and previous[var]["valuesSha256"] != hashes[var]]
    for var in changed:
        if manifest.values_sha256(old[var]) != previous[var]["valuesSha256"]:
            unknown = True
        cells, d = _diff(old[var], months[var])
        changed_cells |= cells
        mad = max(mad, d)
    if changed:
        m["revision"] += 1
        m["changes"].append(
            {
                "revision": m["revision"],
                "days": [f"{year}-01-01", f"{year}-12-31"],
                "cellsChanged": GRID.rows * GRID.cols if unknown else int(changed_cells.sum()),
                "maxAbsDiff": UNKNOWN_MAX_ABS_DIFF if unknown else round(mad, 6),
            }
        )
    for var in VARIABLES:
        obj, fm = read[var]
        url = file_url(obj.key)
        if var in previous and previous[var]["url"] != url:
            m["files"] = [f for f in m["files"] if f["url"] != previous[var]["url"]]
        rev = m["revision"] if var in changed or var not in previous else previous[var]["revision"]
        manifest.upsert_file(
            m,
            {
                "url": url,
                "etag": obj.etag,
                "lastModified": obj.last_modified,
                "size": obj.size,
                "valuesSha256": hashes[var],
                "revision": rev,
                "fetchedAt": now(),
                "version": manifest.cmip6_file_key(url)["version"],
                "license": fm.license,
            },
        )
    outcome = "changed" if changed else "replaced" if previous else "added"
    log(f"{product} {year}: {outcome}")
    return outcome


def copy(mirror, source, plans: Sequence[Planned], recheck: bool = False, now: Callable[[], str] = manifest.utc_now, log: Callable[[str], None] = print) -> dict:
    """Copy every planned year not yet held; refuse to start while any plan lacks a file or has a problem."""
    bad = [p for p in plans if p.missing or p.problems or not p.variant]
    if bad:
        raise MissingFilesError("the listing lacks what the plan needs (run plan):\n" + plan_text(bad))
    summary = {"products": {}, "licenses": {}}
    for p in plans:
        product = product_of(p.model, p.scenario)
        m = manifest.read(mirror, product) or manifest.new(product)
        held = {f["url"] for f in m["files"]}
        outcomes = {"added": 0, "replaced": 0, "changed": 0, "skipped": 0}
        for year in sorted({y for _, y in p.files}):
            urls = {file_url(p.files[(v, year)].key) for v in VARIABLES}
            if urls <= held and not recheck:
                outcomes["skipped"] += 1
                continue
            outcomes[copy_year(mirror, source, p, year, m, now, log)] += 1
            years = held_years(m)
            m["years"] = {"first": years[0], "last": years[-1]} if years else {"first": None, "last": None}
            manifest.write(mirror, m)
            _write_index(mirror, product, years)
        for f in m["files"]:
            lic = "(no license attribute)" if f["license"] is None else f["license"]
            summary["licenses"][lic] = summary["licenses"].get(lic, 0) + 1
        summary["products"][product] = {**outcomes, "revision": m["revision"], "years": m["years"]}
    return summary


# --- the command ------------------------------------------------------------------------------


def _fixture_module():
    sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures" / "cmip6"))
    import make_cmip6_fixture

    return make_cmip6_fixture


def fixture_setup(directory: Path):
    """Fixtures mode: the synthetic tree written into `directory`, its models and years."""
    fx = _fixture_module()
    fx.write_tree(directory)
    return LocalSource(directory), {m: None for m in fx.MODELS}, {s: tuple(fx.YEARS[s]) for s in SCENARIOS}


def _list(text: str) -> list[str]:
    return [x for x in (s.strip() for s in text.split(",")) if x]


def main(argv: Sequence[str] | None = None, s3_client=None, source_client=None, log: Callable[[str], None] = print) -> int:
    ap = argparse.ArgumentParser(description="Copy NEX-GDDP-CMIP6's monthly aggregates for region D1 into the copy, once (issue #621).")
    ap.add_argument("command", choices=("plan", "copy"))
    ap.add_argument("--mirror", required=True, help="MIRROR_URL: file:///abs/path or s3://bucket[/prefix]")
    ap.add_argument("--source", default="s3", help="s3 (the bucket, unsigned), fixtures (the synthetic tree) or a local directory in the bucket's layout")
    ap.add_argument("--models", type=_list, help="a comma-separated subset of the models (default: MODELS, or the fixture's)")
    ap.add_argument("--scenarios", type=_list, default=list(SCENARIOS))
    ap.add_argument("--recheck", action="store_true", help="re-read years the manifest already holds")
    a = ap.parse_args(argv)
    for s in a.scenarios:
        if s not in SCENARIOS:
            ap.error(f"--scenarios takes {', '.join(SCENARIOS)}, not {s}")
    mirror = zarrstore.Mirror.from_url(a.mirror, s3_client)
    with tempfile.TemporaryDirectory(prefix="cmip6-fixture-") as tmp:
        if a.source == "fixtures":
            source, models, years = fixture_setup(Path(tmp))
        else:
            source = S3Source(source_client) if a.source == "s3" else LocalSource(Path(a.source))
            models, years = dict(MODELS), dict(YEARS)
        if a.models:
            unknown = [x for x in a.models if x not in models]
            if unknown:
                ap.error(f"--models: {', '.join(unknown)} not in the model list ({', '.join(models)})")
            models = {k: models[k] for k in a.models}
        plans = make_plan(source, models, a.scenarios, years)
        if a.command == "plan":
            log(plan_text(plans, mirror).rstrip("\n"))
            return 1 if any(p.missing or p.problems or not p.variant for p in plans) else 0
        summary = copy(mirror, source, plans, recheck=a.recheck, log=log)
    log(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
