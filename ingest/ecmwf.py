"""The ECMWF ENS forecast into our copy (issue #604 D17, R4-C).

Event: {"product": "ecmwf", "mode": "daily"}

ECMWF's open data (CC BY 4.0) publishes each ENS run as one GRIB2 file per
forecast step, mirrored without sign-in in AWS eu-central-1 (the bulk path
ECMWF documents beside data.ecmwf.int):

    https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com/
      <YYYYMMDD>/00z/ifs/0p1/enfo/<YYYYMMDD>000000-<step>h-enfo-ef-sfc.grib2
      … and the same name with `.index`

From 2026-10-20 the IFS data is published at 0.1 deg as well as 0.25 deg,
about two hours after the 0.25 deg files (the 00 UTC run's 0.1 deg files
appeared at 09:40 UTC on 2026-10-26), with surface (`-sfc`) and
pressure-level (`-pl`) fields in separate files. Each `-sfc` file is ~4.3 GB
for one step and all 50 perturbed members (`type: pf`); the control member
is not in the `ef` files at 0.1 deg. The `.index` beside it is JSON lines,
one per field, with the MARS keys and `_offset`/`_length` of the field's
bytes. ECMWF keeps only the last ~12 runs (2–3 days), so what we want to
keep, we copy.

**What a run reads (only what we need).** Total precipitation `tp`, the 00
UTC run, steps 24, 48, … 360 h (one a day, 15 days). For each step: the
index (~560 KB), then one range request per member for that member's `tp`
field (~1.4 MB each at 0.1 deg): 1 + 50 requests a step, 765 for an issue,
about 1.1 GB. Every request starts at least a second after the one before
(polite.PoliteClient); a 403 stops the run at once, is never retried, and
leaves a marker (`ecmwf/refused.json`) so the day's later runs ask nothing.
At one a second an issue takes ~13 minutes, about a Lambda's maximum, so a
run stops starting steps when its time is short and the work goes on in the
next run (the rule runs every 20 minutes through the late morning,
infra/ecmwf.tf): each finished step is saved under
`ingest-state/ecmwf/work/<issue>/step-<h>.npy`, the members' accumulations
on our grid, and a later run picks up from the steps held. One run at a time
(lease.py, product `ecmwf`).

AIFS-ENS is left out: its open data is 0.25 deg only, and adding it would
double the requests for a second model on a coarser grid.

**Decoding (eccodes).** Each field is a global regular lat/lon grid (0.1
deg, 3600 x 1801 points from 90 N, 0 E). Its points sit on multiples of 0.1
deg, which are our 0.1 deg grid's cell **corners** (the copy's 0.1 deg cells
are centred on .05, origin lat -35.45, lon 10.05, 275 rows x 310 columns,
row 0 the south-west, rows growing northwards). So a cell takes the mean of
the four points at its corners, which is the bilinear value at its centre.
`tp` is accumulated from the run's start, in metres, so day d (0-14) is

    1000 * (tp[24 (d + 1) h] - tp[24 d h])      mm, tp[0 h] = 0,

which is the UTC day issue + d, 00 to 24 UTC. A packing round-off below
zero (down to -NEGATIVE_TOLERANCE_MM) is 0; anything further below, above
MAX_DAILY_MM, or missing, fails the run. CHIRPS-GEFS's forecast days line up
the same way: an issue's day 0 is its issue date (the GEFS 00 UTC run), so
both forecasts write from the same day and the feed's dates mean the same
thing; ECMWF's has 15 days, CHIRPS-GEFS's 16.

**What is stored, and why.** Not the 50 members: a feed writes one value a
day, and the spread is what a farmer-facing view would show beside it. Per
cell and day, four statistics across the members: the ensemble **mean**
(what a feed writes: rain is summed into the water balance, and the mean
keeps the volume where the median of a skewed daily total would drop most
showers) and the **p10, p50 and p90** quantiles (linear interpolation
between members). As Zarr array `ecmwf/<issue>`: the daily layout with a
leading `stat` dimension, shape (4, 15, 275, 310), dims (stat, day, lat,
lon), chunk (1, 1, 55, 62) (25 chunks a day and statistic), attributes
`firstDay` (the issue date), `stats` (["mean", "p10", "p50", "p90"]),
`members`, `region` and `grid` ({origin: {lat: -35.45, lon: 10.05}, step:
0.1}). About 4 MB an issue. Its manifest (`ecmwf/<issue>/manifest.json`)
lists the 15 step files in day order, each file's `valuesSha256` the hash
of that day's mean.

**Keeping.** `ecmwf/index.json` is `{"issues": [...], "archived": [...]}`,
newest first. `issues` are the newest KEEP_ISSUES (7) complete issues, held
whole; a reader uses only these. An issue that drops off is **archived**: its
p10/p50/p90 chunks are deleted and its mean kept, because ECMWF keeps no
history to speak of and the quantile-mapping fit (ecmwf_qm_fit.py) needs
months of forecasts against our rain (D17). About 1.4 GB a year.

**MirrorLagDays{Product=ecmwf}** (cloudwatch.py) on every exit once the copy
is reachable: today minus the newest issue held. With none held there is no
value to give, and the alarm's missing-data rule (infra/ecmwf.tf) treats
that as breaching, as the GEFS pass does.
"""

from __future__ import annotations

import datetime as dt
import io
import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

import lease
import manifest
import polite
import zarrstore

PRODUCT = "ecmwf"
BASE_URL = "https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com"
RESOLUTION = "0p1"
DAYS = 15
STEPS = tuple(24 * (d + 1) for d in range(DAYS))
STATS = ("mean", "p10", "p50", "p90")
QUANTILES = {"p10": 0.10, "p50": 0.50, "p90": 0.90}
KEEP_ISSUES = 7
SWEEP_DAYS = 14

# The copy's 0.1 deg grid on region D1 (issue #604 Round 4 brief).
REGION = {"w": 10.0, "s": -35.5, "e": 41.0, "n": -8.0}
STEP_DEG = 0.1
ORIGIN = {"lat": -35.45, "lon": 10.05}
ROWS = 275
COLS = 310
CHUNKS = (1, 1, 55, 62)

MAX_DAILY_MM = 2000.0
NEGATIVE_TOLERANCE_MM = 0.1
# A run starts a step only with this much of the Lambda's time left (51
# requests at one a second, plus decoding), and finishes an issue (the
# statistics and ~1,500 chunk writes) only with FINISH_RESERVE_S left.
STEP_RESERVE_S = 120.0
FINISH_RESERVE_S = 300.0
# The members a live issue must have in every step; fixtures have fewer.
LIVE_MEMBERS = 50

INDEX_KEY = "ecmwf/index.json"
REFUSED_KEY = "ecmwf/refused.json"
QM_KEY = "ecmwf/qm.json"

log = logging.getLogger("ingest")


class EcmwfFormatError(ValueError):
    """A file or field that isn't what the job expects: the run fails."""


class BadEvent(ValueError):
    pass


def validate_event(event) -> dict:
    if not isinstance(event, dict) or set(event) != {"product", "mode"} or event.get("product") != PRODUCT or event.get("mode") != "daily":
        raise BadEvent('the ECMWF job takes exactly {"product": "ecmwf", "mode": "daily"}')
    return {"product": PRODUCT, "mode": "daily"}


# --- Names ----------------------------------------------------------------------------


def file_url(issue: dt.date, step: int, ext: str, base: str = BASE_URL) -> str:
    d = issue.strftime("%Y%m%d")
    return f"{base}/{d}/00z/ifs/{RESOLUTION}/enfo/{d}000000-{step}h-enfo-ef-sfc.{ext}"


def issue_product(issue: dt.date | str) -> str:
    return f"{PRODUCT}/{issue if isinstance(issue, str) else issue.isoformat()}"


def work_prefix(issue: dt.date) -> str:
    return f"ingest-state/{PRODUCT}/work/{issue.isoformat()}/"


def work_key(issue: dt.date, step: int) -> str:
    return f"{work_prefix(issue)}step-{step}.npy"


# --- The index ------------------------------------------------------------------------


@dataclass(frozen=True)
class Field:
    member: int
    offset: int
    length: int


def tp_fields(index_text: str, issue: dt.date, step: int) -> list[Field]:
    """The `tp` fields of the perturbed members in one step file's index, by
    member. Every other field (other parameters, other levels) is left out;
    a `tp` record for another date, time or step, a member twice, or a
    non-positive length fails."""
    date = issue.strftime("%Y%m%d")
    out: dict[int, Field] = {}
    for n, line in enumerate(index_text.splitlines(), 1):
        if not line.strip():
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError as e:
            raise EcmwfFormatError(f"index line {n} is not JSON") from e
        if r.get("param") != "tp" or r.get("type") != "pf":
            continue
        if r.get("stream") != "enfo" or r.get("levtype") != "sfc" or r.get("date") != date or r.get("time") != "0000" or str(r.get("step")) != str(step):
            raise EcmwfFormatError(f"index line {n}: a tp field for another run or step ({r.get('date')} {r.get('time')} step {r.get('step')})")
        try:
            member, offset, length = int(r["number"]), int(r["_offset"]), int(r["_length"])
        except (KeyError, TypeError, ValueError) as e:
            raise EcmwfFormatError(f"index line {n}: no member, offset or length") from e
        if member < 1 or offset < 0 or length <= 0:
            raise EcmwfFormatError(f"index line {n}: member {member}, offset {offset}, length {length}")
        if member in out:
            raise EcmwfFormatError(f"index: member {member} has two tp fields in step {step}")
        out[member] = Field(member, offset, length)
    return [out[m] for m in sorted(out)]


# --- Decoding ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LatLonGrid:
    ni: int
    nj: int
    lat1: float
    lon1: float
    di: float
    dj: float
    j_south: bool  # rows run south to north (jScansPositively)

    def row(self, lat: float) -> int:
        k = (lat - self.lat1) / self.dj if self.j_south else (self.lat1 - lat) / self.dj
        return _whole(k, f"latitude {lat}", self.nj)

    def col(self, lon: float) -> int:
        k = ((lon - self.lon1) % 360.0) / self.di
        if abs(k - round(k)) < 1e-6 and round(k) == round(360.0 / self.di):
            k = 0.0
        return _whole(k, f"longitude {lon}", self.ni)


def _whole(k: float, what: str, n: int) -> int:
    i = round(k)
    if abs(k - i) > 1e-6:
        raise EcmwfFormatError(f"{what} is not a point of the field's grid")
    if not 0 <= i < n:
        raise EcmwfFormatError(f"{what} is outside the field's grid")
    return i


def decode_field(message: bytes, issue: dt.date, step: int, member: int) -> tuple[np.ndarray, LatLonGrid]:
    """One GRIB2 message: its values as (nj, ni) in the file's row order, and
    its grid. Refuses anything but this run's `tp` (m, accumulated from 0 h)
    for this member and step on a regular lat/lon grid."""
    import eccodes

    h = eccodes.codes_new_from_message(message)
    try:
        get = lambda k: eccodes.codes_get(h, k)  # noqa: E731
        what = f"the tp field of member {member}, step {step} h"
        if get("shortName") != "tp" or get("units") != "m":
            raise EcmwfFormatError(f"{what} holds {get('shortName')} in {get('units')}")
        if get("dataDate") != int(issue.strftime("%Y%m%d")) or get("dataTime") != 0:
            raise EcmwfFormatError(f"{what} is from the {get('dataDate')} {get('dataTime'):04d} run")
        if get("stepType") != "accum" or get("startStep") != 0 or get("endStep") != step:
            raise EcmwfFormatError(f"{what} is accumulated over {get('stepRange')}")
        if get("number") != member:
            raise EcmwfFormatError(f"{what} is member {get('number')}")
        if get("gridType") != "regular_ll" or get("iScansNegatively") != 0:
            raise EcmwfFormatError(f"{what} is on a {get('gridType')} grid")
        g = LatLonGrid(
            ni=get("Ni"),
            nj=get("Nj"),
            lat1=float(get("latitudeOfFirstGridPointInDegrees")),
            lon1=float(get("longitudeOfFirstGridPointInDegrees")),
            di=float(get("iDirectionIncrementInDegrees")),
            dj=float(get("jDirectionIncrementInDegrees")),
            j_south=get("jScansPositively") == 1,
        )
        values = eccodes.codes_get_values(h)
        if values.size != g.ni * g.nj:
            raise EcmwfFormatError(f"{what} has {values.size} values for a {g.nj} x {g.ni} grid")
        missing = get("missingValue") if get("bitmapPresent") else None
        values = values.reshape(g.nj, g.ni)
        if missing is not None:
            values = np.where(values == missing, np.nan, values)
        return values, g
    finally:
        eccodes.codes_release(h)


def region_cells(values: np.ndarray, g: LatLonGrid) -> np.ndarray:
    """The field on our 0.1 deg cells (ROWS x COLS, row 0 the south): the mean
    of each cell's four corner points, which are the field's points on
    multiples of 0.1 deg. The field's grid must hold every corner."""
    lats = [REGION["s"] + i * STEP_DEG for i in range(ROWS + 1)]
    lons = [REGION["w"] + j * STEP_DEG for j in range(COLS + 1)]
    rows = np.array([g.row(round(x, 6)) for x in lats])
    cols = np.array([g.col(round(x, 6)) for x in lons])
    pts = values[np.ix_(rows, cols)].astype(np.float64)  # (ROWS + 1, COLS + 1), south first
    return ((pts[:-1, :-1] + pts[:-1, 1:] + pts[1:, :-1] + pts[1:, 1:]) / 4.0).astype(np.float32)


# --- Daily totals and statistics --------------------------------------------------------


def daily_mm(prev_cum_m: np.ndarray | None, cum_m: np.ndarray, day: int) -> np.ndarray:
    """One day's totals in mm from two accumulations in metres (members, rows,
    cols); `prev_cum_m` None is the run's start (0). A round-off below zero
    becomes 0; a larger drop, a missing value or more than MAX_DAILY_MM fails."""
    prev = 0.0 if prev_cum_m is None else prev_cum_m.astype(np.float64)
    d = (cum_m.astype(np.float64) - prev) * 1000.0
    if not np.isfinite(d).all():
        raise EcmwfFormatError(f"day {day} has missing values")
    lo, hi = float(d.min()), float(d.max())
    if lo < -NEGATIVE_TOLERANCE_MM:
        raise EcmwfFormatError(f"day {day} falls by {-lo:.3f} mm: tp is not accumulating")
    if hi > MAX_DAILY_MM:
        raise EcmwfFormatError(f"day {day} has {hi:.1f} mm, over {MAX_DAILY_MM:.0f} mm")
    return np.maximum(d, 0.0)


def stats(members_mm: np.ndarray) -> np.ndarray:
    """(len(STATS), rows, cols) float32 from (members, rows, cols)."""
    out = np.empty((len(STATS),) + members_mm.shape[1:], dtype=np.float32)
    for i, s in enumerate(STATS):
        out[i] = members_mm.mean(axis=0) if s == "mean" else np.quantile(members_mm, QUANTILES[s], axis=0)
    return out


# --- Raw objects in the copy (work files, deletes) ---------------------------------------


def _put(mirror, key: str, data: bytes) -> None:
    if isinstance(mirror, zarrstore.S3Mirror):
        mirror.client.put_object(Bucket=mirror.bucket, Key=mirror._key(key), Body=data)
    else:
        p = mirror.root / key
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(p)


def _get(mirror, key: str) -> bytes | None:
    if isinstance(mirror, zarrstore.S3Mirror):
        try:
            return mirror.client.get_object(Bucket=mirror.bucket, Key=mirror._key(key))["Body"].read()
        except mirror.client.exceptions.NoSuchKey:
            return None
    p = mirror.root / key
    return p.read_bytes() if p.is_file() else None


def _list(mirror, prefix: str) -> list[str]:
    if isinstance(mirror, zarrstore.S3Mirror):
        return mirror._list(prefix)
    base = mirror.root / prefix
    if not base.exists():
        return []
    return sorted(p.relative_to(mirror.root).as_posix() for p in base.rglob("*") if p.is_file())


def _delete_prefix(mirror, prefix: str) -> int:
    keys = _list(mirror, prefix)
    for k in keys:
        if isinstance(mirror, zarrstore.S3Mirror):
            mirror.client.delete_object(Bucket=mirror.bucket, Key=mirror._key(k))
        else:
            (mirror.root / k).unlink(missing_ok=True)
    if not isinstance(mirror, zarrstore.S3Mirror):
        # A local copy has directories S3 doesn't: remove the ones the deletes emptied.
        base = mirror.root / prefix
        if base.is_dir():
            for d in sorted((p for p in base.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
                if not any(d.iterdir()):
                    d.rmdir()
            if not any(base.iterdir()):
                base.rmdir()
    return len(keys)


def _save_step(mirror, issue: dt.date, step: int, cum: np.ndarray) -> None:
    buf = io.BytesIO()
    np.save(buf, cum.astype(np.float32), allow_pickle=False)
    _put(mirror, work_key(issue, step), buf.getvalue())


def _load_step(mirror, issue: dt.date, step: int) -> np.ndarray | None:
    raw = _get(mirror, work_key(issue, step))
    return None if raw is None else np.load(io.BytesIO(raw), allow_pickle=False)


_STEP_FILE = re.compile(r"step-(\d+)\.npy")


def _steps_held(mirror, issue: dt.date) -> set[int]:
    held = set()
    for k in _list(mirror, work_prefix(issue)):
        m = _STEP_FILE.fullmatch(k.rsplit("/", 1)[-1])
        if m:  # anything else under the prefix isn't a step this job wrote
            held.add(int(m[1]))
    return held & set(STEPS)


# --- The index and the refusal marker ----------------------------------------------------


def read_index(mirror) -> dict:
    doc = mirror.read_json(INDEX_KEY) or {"issues": [], "archived": []}
    issues, archived = doc.get("issues", []), doc.get("archived", [])
    for lst in (issues, archived):
        if not isinstance(lst, list) or any(not isinstance(d, str) for d in lst) or lst != sorted(set(lst), reverse=True):
            raise EcmwfFormatError("ecmwf/index.json: issues and archived must each be ISO dates, newest first, once")
        for d in lst:
            dt.date.fromisoformat(d)
    if set(issues) & set(archived):
        raise EcmwfFormatError("ecmwf/index.json: an issue is both held and archived")
    return {"issues": list(issues), "archived": list(archived)}


def write_index(mirror, issues: list[str], archived: list[str]) -> None:
    mirror.write_json(INDEX_KEY, {"issues": sorted(set(issues), reverse=True), "archived": sorted(set(archived) - set(issues), reverse=True)})


def read_refused(mirror) -> str | None:
    try:
        doc = mirror.read_json(REFUSED_KEY)
    except (ValueError, OSError):
        return None
    if not isinstance(doc, dict) or doc.get("v") != 1 or not isinstance(doc.get("at"), str):
        return None
    return doc["at"]


# --- Writing an issue ----------------------------------------------------------------------


def _attributes(issue: dt.date, members: int) -> dict:
    return {
        "firstDay": issue.isoformat(),
        "stats": list(STATS),
        "members": members,
        "region": dict(REGION),
        "grid": {"origin": dict(ORIGIN), "step": STEP_DEG},
    }


def write_issue(mirror, issue: dt.date, values: np.ndarray, members: int) -> None:
    """The issue's array, (len(STATS), DAYS, ROWS, COLS), written whole."""
    import zarr
    from zarr.codecs import BytesCodec, GzipCodec

    if values.shape != (len(STATS), DAYS, ROWS, COLS):
        raise ValueError(f"values must be {(len(STATS), DAYS, ROWS, COLS)}, got {values.shape}")
    product = issue_product(issue)
    with mirror.stage([f"{PRODUCT}/zarr.json", f"{product}/"]) as root:
        store = zarr.storage.LocalStore(root)
        zarr.open_group(store=store, mode="a", zarr_format=3)
        if not (root / PRODUCT / "zarr.json").exists():
            zarr.open_group(store=store, path=PRODUCT, mode="a", zarr_format=3)
        arr = zarr.create_array(
            store=store,
            name=product,
            shape=values.shape,
            chunks=CHUNKS,
            dtype="float32",
            fill_value=np.nan,
            serializer=BytesCodec(endian="little"),
            compressors=[GzipCodec(level=zarrstore.GZIP_LEVEL)],
            filters=None,
            dimension_names=("stat", "day", "lat", "lon"),
            attributes=_attributes(issue, members),
            overwrite=True,
        )
        arr[:] = values.astype(np.float32)


def read_issue(root, issue: str | dt.date, stat: str = "mean") -> np.ndarray:
    """One statistic of a held or archived issue from a local copy: (DAYS, ROWS, COLS)."""
    import zarr

    arr = zarr.open_array(store=zarr.storage.LocalStore(root), path=issue_product(issue), mode="r", zarr_format=3)
    return np.asarray(arr[STATS.index(stat)])


# --- The run -------------------------------------------------------------------------------


@dataclass
class Outcome:
    stopped: str = "not_published"
    copied: str | None = None
    working: str | None = None
    steps_done: int = 0
    held: list[str] = field(default_factory=list)
    archived: list[str] = field(default_factory=list)
    swept: list[str] = field(default_factory=list)
    refused_at: str | None = None
    lag_days: int | None = None
    requests: int = 0


class _Budget:
    def __init__(self, context):
        self.context = context

    def left(self) -> float | None:
        return None if self.context is None else self.context.get_remaining_time_in_millis() / 1000.0

    def allows(self, reserve: float) -> bool:
        left = self.left()
        return left is None or left >= reserve


def _published(client: polite.PoliteClient, issue: dt.date) -> bool:
    """Whether the issue's last step is out (ECMWF writes a run's steps in
    order, so without the last the issue isn't complete)."""
    try:
        client.get(file_url(issue, STEPS[-1], "index"))
    except polite.HttpError as e:
        if e.status == 404:
            return False
        raise
    return True


def _copy_step(mirror, client: polite.PoliteClient, issue: dt.date, step: int, expect_members: int | None) -> tuple[np.ndarray, dict]:
    """One step: its index, then each member's tp field by range, onto our
    cells. Returns the accumulations (members, ROWS, COLS) in metres and the
    file's validators for the manifest."""
    idx = client.get(file_url(issue, step, "index"))
    fields = tp_fields((idx.body or b"").decode(), issue, step)
    if not fields:
        raise EcmwfFormatError(f"step {step} h of {issue} lists no tp fields")
    if expect_members is not None and len(fields) != expect_members:
        raise EcmwfFormatError(f"step {step} h of {issue} lists {len(fields)} members, not {expect_members}")
    url = file_url(issue, step, "grib2")
    out = np.empty((len(fields), ROWS, COLS), dtype=np.float32)
    etag = last_modified = None
    for i, f in enumerate(fields):
        res = client.get(url, byte_range=(f.offset, f.offset + f.length - 1))
        body = res.body or b""
        if res.status == 200 and len(body) > f.length:
            body = body[f.offset : f.offset + f.length]
        if len(body) != f.length:
            raise EcmwfFormatError(f"{url} answered {len(body)} bytes for a {f.length}-byte field")
        values, g = decode_field(body, issue, step, f.member)
        out[i] = region_cells(values, g)
        etag, last_modified = res.etag, res.last_modified
    return out, {"url": url, "etag": etag, "lastModified": last_modified, "members": len(fields)}


def _finish(mirror, issue: dt.date, files: list[dict], now: Callable[[], str]) -> int:
    """Daily totals, statistics and the array from the saved steps; then the manifest."""
    values = np.empty((len(STATS), DAYS, ROWS, COLS), dtype=np.float32)
    prev = None
    members = None
    entries = []
    for d, step in enumerate(STEPS):
        cum = _load_step(mirror, issue, step)
        if cum is None:
            raise EcmwfFormatError(f"step {step} h of {issue} is missing from the work files")
        if members is None:
            members = cum.shape[0]
        elif cum.shape[0] != members:
            raise EcmwfFormatError(f"step {step} h of {issue} has {cum.shape[0]} members, not {members}")
        day = daily_mm(prev, cum, d)
        values[:, d] = stats(day)
        prev = cum
        f = files[d] if d < len(files) and files[d] else {"url": file_url(issue, step, "grib2"), "etag": None, "lastModified": None}
        entries.append(
            {
                "url": f["url"],
                "etag": f.get("etag"),
                "lastModified": f.get("lastModified"),
                "size": None,
                "valuesSha256": manifest.values_sha256(values[0, d : d + 1]),
                "revision": 1,
                "fetchedAt": now(),
            }
        )
    write_issue(mirror, issue, values, members)
    last = issue + dt.timedelta(days=DAYS - 1)
    manifest.write(
        mirror,
        {
            "product": issue_product(issue),
            "revision": 1,
            "region": dict(REGION),
            "grid": {"origin": dict(ORIGIN), "step": STEP_DEG},
            "years": {"first": issue.year, "last": last.year},
            "finalThrough": None,
            "prelimThrough": None,
            "files": entries,
            "changes": [],
        },
    )
    return members


def archive_issue(mirror, issue: str) -> None:
    """Keep only an issue's mean: delete its other statistics' chunks."""
    for i in range(1, len(STATS)):
        _delete_prefix(mirror, f"{issue_product(issue)}/c/{i}/")


def run(
    mirror,
    client: polite.PoliteClient,
    today: dt.date,
    context=None,
    keep: int = KEEP_ISSUES,
    expect_members: int | None = LIVE_MEMBERS,
    now: Callable[[], str] | None = None,
    clock: Callable[[], float] = time.time,
) -> Outcome:
    """One daily run (see the module docstring). Raises polite.StopRun after a
    403 (the marker written), EcmwfFormatError for a file that isn't right,
    and lease.MirrorBusy when another run holds the copy."""
    now = now or manifest.utc_now
    budget = _Budget(context)
    out = Outcome()
    index = read_index(mirror)
    out.held, out.archived = index["issues"], index["archived"]

    refused = read_refused(mirror)
    if refused is not None and refused[:10] == today.isoformat():
        out.stopped, out.refused_at = "refused_today", refused
        return out

    with lease.hold(mirror, PRODUCT, now=clock):
        try:
            for back in (0, 1):
                issue = today - dt.timedelta(days=back)
                if issue.isoformat() in out.held:
                    out.stopped = "up_to_date"
                    break
                done = _steps_held(mirror, issue)
                if not done and not _published(client, issue):
                    continue
                out.working = issue.isoformat()
                files: dict[int, dict] = {}
                state = mirror.read_json(f"{work_prefix(issue)}files.json") or {}
                files.update({int(k): v for k, v in state.items()})
                for step in STEPS:
                    if step in done:
                        continue
                    if not budget.allows(STEP_RESERVE_S):
                        out.stopped = "deadline"
                        break
                    try:
                        cum, meta = _copy_step(mirror, client, issue, step, expect_members)
                    except polite.HttpError as e:
                        if e.status == 404:
                            out.stopped = "partial"
                            break
                        raise
                    _save_step(mirror, issue, step, cum)
                    files[step] = meta
                    mirror.write_json(f"{work_prefix(issue)}files.json", {str(k): v for k, v in files.items()})
                    done.add(step)
                out.steps_done = len(done)
                if out.stopped in ("deadline", "partial"):
                    break
                if not budget.allows(FINISH_RESERVE_S):
                    out.stopped = "deadline"
                    break
                _finish(mirror, issue, [files.get(s) for s in STEPS], now)
                kept = sorted(set([issue.isoformat(), *out.held]), reverse=True)
                dropped = kept[keep:]
                kept = kept[:keep]
                archived = sorted(set(out.archived) | set(dropped), reverse=True)
                # The index first, so a reader never finds a listed issue whose chunks are being deleted.
                write_index(mirror, kept, archived)
                for d in dropped:
                    archive_issue(mirror, d)
                _delete_prefix(mirror, work_prefix(issue))
                out.held, out.archived = kept, archived
                out.copied, out.stopped = issue.isoformat(), "copied"
                break
            _sweep(mirror, out, today)
        except polite.StopRun:
            out.stopped = "refused"
            out.refused_at = now()
            try:
                mirror.write_json(REFUSED_KEY, {"v": 1, "at": out.refused_at})
            except Exception:
                log.exception("ecmwf: could not write the refusal marker")
            raise
        finally:
            out.requests = client.requests
    return out


def _sweep(mirror, out: Outcome, today: dt.date) -> None:
    """Work a cut-short run left for an issue before yesterday, and the array
    of an issue neither held nor archived (a finish cut short), in the
    fortnight before today."""
    listed = set(out.held) | set(out.archived)
    for back in range(2, SWEEP_DAYS + 1):
        d = today - dt.timedelta(days=back)
        if _list(mirror, work_prefix(d)):
            _delete_prefix(mirror, work_prefix(d))
            out.swept.append(f"work/{d.isoformat()}")
    for back in range(0, SWEEP_DAYS + 1):
        d = (today - dt.timedelta(days=back)).isoformat()
        if d in listed or mirror.read_json(f"{issue_product(d)}/zarr.json") is None:
            continue
        _delete_prefix(mirror, f"{issue_product(d)}/")
        out.swept.append(d)


def lag_days(held: list[str], today: dt.date) -> int | None:
    return (today - dt.date.fromisoformat(held[0])).days if held else None


# --- The Lambda's entry -------------------------------------------------------------------


def handle(event, context=None, *, mirror, live: bool, opener=None, metrics, today: dt.date, contact: str | None = None, clock=None, sleep=None) -> dict:
    """Run one validated event; publish MirrorLagDays{Product=ecmwf} on every
    exit that knows the copy (a run held off, refused or failed included)."""
    validate_event(event)
    kw = {}
    if opener is not None:
        kw["opener"] = opener
    if sleep is not None:
        kw["sleep"] = sleep
    if clock is not None:
        kw["clock"] = clock
    client = polite.PoliteClient(contact=contact, min_interval=1.0 if live else 0.0, **kw)
    out = Outcome()

    def publish(held):
        lag = lag_days(held, today)
        if lag is None:
            log.info("ecmwf: the copy holds no issue yet; no %s to publish (the alarm treats that as breaching)", "MirrorLagDays")
        else:
            metrics.publish(PRODUCT, lag)
        return lag

    try:
        out = run(mirror, client, today, context, expect_members=LIVE_MEMBERS if live else None)
    except lease.MirrorBusy as e:
        log.info("ecmwf: %s; the run holding it does this work", e)
        out.stopped = "busy"
        out.held = read_index(mirror)["issues"]
    except BaseException:
        try:
            publish(read_index(mirror)["issues"])
        except Exception:
            log.exception("ecmwf: could not publish MirrorLagDays while failing")
        raise
    out.lag_days = publish(out.held)
    result = {
        "product": PRODUCT,
        "mode": "daily",
        "source": "live" if live else "fixtures",
        "stopped": out.stopped,
        "copied": out.copied,
        "working": out.working,
        "stepsDone": out.steps_done,
        "newest": out.held[0] if out.held else None,
        "held": out.held,
        "archived": len(out.archived),
        "swept": out.swept,
        "refusedAt": out.refused_at,
        "lagDays": out.lag_days,
        "requests": out.requests,
    }
    log.info("%s", json.dumps({"event": "mirror_ingest", **result}))
    return result
