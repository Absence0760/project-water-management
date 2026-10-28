"""C3S seasonal forecasts and hindcasts into the copy (issue #620 step 5):
products `c3s/<init>` and `c3s-hc/<system>/<MM>`.

    Copernicus Climate Data Store (CDS), dataset `seasonal-original-single-levels`,
    variable `total_precipitation` (24 h accumulations since the start), every
    member, leads 24 h to 5160 h (215 days), area D1 at the CDS's native 1 deg.

**Licence.** CC BY 4.0 plus the *Additional licence to use non European
contributions* (the dataset page, read 2026-10-28): the source must be
acknowledged, there is no guarantee of continuity or quality and no
liability. Both are accepted once on the CDS account (operator step,
docs/deployment.md § C3S seasonal forecasts). Wherever the values show, the
Copernicus credit (`CREDIT`) and the contributing centres (`centres`) go
with them; the arrays carry both, so a reader of the copy alone still has
them (docs/data-sources.md § c3s-seasonal; the engine's
liability/rainCredits.ts holds the same words for the app).

**The systems.** One CDS request per system (c3srequest.SYSTEMS, the
`<centre>-<system>` ids: `ecmwf-51`, `ukmo-604`, …). ECMWF's forecast from
init month M is released on the CDS on the 6th of M at 12 UTC, the other
centres' on the 10th (`c3srequest.release_at`); a run asks for a system's
init only `RELEASE_MARGIN_S` after that.

**Never wait inside a Lambda: submit on one run, collect on a later one.**
The machinery is ERA5-Land's (cdsjob.py: era5land.py's docstring has the
rules), keyed by request instead of month: the state is
`ingest-state/c3s/requests.json`, one entry per request key (`fc/<system>/<YYYY-MM>`,
`hc/<system>/<MM>`); the intent is written before each submit, and a run
that finds an intent with no id (a crash), or no state at all, first adopts
its own queued request (`find`); a failed request is resubmitted with
backoff 1, 2, 4, 8 days and after `MAX_ATTEMPTS` raises `RequestsFailed`
every run until the operator clears its entry; at most `MAX_IN_FLIGHT`
requests queued at once; a 401/403 stops the run (polite.StopRun) and leaves
the same-day refused marker; the lease (`c3s`) is held for the whole run.
The CDS's results are downloaded whole through the polite client.

**monthly** (the daily rule, infra/c3s.tf): collect what is ready; then, per
system, submit its newest released init and any between it and the newest
held (at most `CATCH_UP_INITS`); then drain the wanted hindcasts. Forecasts go
first, newest first.

**backfill** `{"month": "MM", "system"?: "<centre>-<system>"}`: marks that
init calendar month's hindcast wanted for every system (or one), then
collects and submits as slots allow; later daily runs keep draining the
wanted entries, so one invocation per month (12 in all) is enough. Each
hindcast is ONE request: every year of `HINDCAST_YEARS` (1993-2016), every
member, every lead. A system holding fewer years answers with those; the
years held are recorded (the array's `years`, the manifest's `years`).

**Decoding (eccodes).** The CDS's GRIB holds one message per start, member
and lead: `tp` in m accumulated from the start, `endStep` the lead in hours,
`number` the member, `dataDate` the start (the init month's 1st; a
hindcast's year is its own). The points sit on whole degrees, which are the
1 deg grid's cell centres (grid.C3S: 29 rows x 32 columns, [0, 0] centred at
36 S, 10 E, rows northwards), so a cell is its point, no remap. Day d
(lead_day d, 0 = the init month's 1st) is

    1000 * (tp[24 (d + 1) h] - tp[24 d h])      mm/day, tp[0 h] = 0,

packing noise below zero clamped to 0 (down to -`NEGATIVE_FAIL_MM`; further
below fails the run, as does a day above `MAX_DAILY_MM`). A lead the file
lacks leaves NaN for the days it bounds; the lead axis is always
`LEAD_DAYS` (215) long, NaN past what a system gives.

**What is stored.** Zarr groups, each holding one array `tp_mm` (float32,
NaN fill, [bytes little-endian, gzip 6], chunk one member's whole forecast):

- `c3s/<YYYY-MM>/tp_mm`: dims (system, member, lead_day, lat, lon), shape
  (systems, members, 215, 29, 32). The `system` coordinate is the group's
  `systems` attribute (the systems list when the init was first written,
  growing if one is added); members are padded with NaN to the largest
  system's count (`members` lists each system's own, 0 until collected).
  Each system is written as its request is collected.
- `c3s-hc/<system>/<MM>/tp_mm`: dims (year, member, lead_day, lat, lon), the
  `year` coordinate the group's `years`.

The group's attributes: `centres` (the contributing centres' names, for the
credit), `source` ("C3S seasonal-original-single-levels"), `licence`,
`credit` (`CREDIT`), `citation`, `systems`/`years`, `members`, `init` or
`initMonth`, `firstDay`/`leadDays`, `region` and `grid`. Each product has a
manifest (`<product>/manifest.json`, manifest.py: one file per CDS request,
its URL `cds://seasonal-original-single-levels/total_precipitation/<system>/<YYYY-MM>`
or `…/<system>/hindcast/<MM>`), and `c3s/index.json` lists what is held:
`{"inits": {"YYYY-MM": [systems]}, "hindcasts": {system: ["MM", …]}}`.

**MirrorLagDays{Product=c3s}** on every exit once the copy is reachable:
today minus the 1st of the newest init every system of SYSTEMS is held for.
None held: nothing to publish, and the alarm's missing-data rule
(infra/c3s.tf) treats that as breaching.

**The key** is ERA5-Land's CDS key (`CDS_KEY_SECRET_ARN`), read at run time
in live mode only and never logged. Fixtures mode (the default) uses
fakecds.FakeC3sCds, which writes synthetic GRIB
(fixtures/c3s/make_c3s_fixture.py); no key, no network.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import logging
import os
import tempfile
import time
from pathlib import Path
from typing import Callable

import numpy as np

import cdsjob
import chirps_final
import cloudwatch
import grid
import lease
import manifest
import polite
import zarrstore
from c3srequest import (  # noqa: F401  (re-exported)
    CENTRE_NAMES,
    DATASET,
    HC_PRODUCT,
    HINDCAST_YEARS,
    LEAD_DAYS,
    LEAD_HOURS,
    PRODUCT,
    SYSTEMS,
    VARIABLE,
    centre_of,
    key_str,
    parse_key,
    release_at,
    request,
    request_key,
)

log = logging.getLogger("ingest")

RUNBOOK = "docs/deployment.md § C3S seasonal forecasts"
GRID = grid.C3S
#: One member's whole forecast (every lead, the whole region): ~800 kB raw.
CHUNKS = (1, 1, LEAD_DAYS, GRID.rows, GRID.cols)
VAR = "tp_mm"

#: Ask for a system's init this long after its 12 UTC release.
RELEASE_MARGIN_S = 1800
#: The monthly run fills a gap after a system's newest held init back this far at most.
CATCH_UP_INITS = 2
MAX_IN_FLIGHT = 4
BACKOFF_BASE_DAYS = 1
BACKOFF_MAX_DAYS = 16
MAX_ATTEMPTS = 5
#: Don't start a download with less than this left (a hindcast is a few hundred MB and its write a few minutes).
COLLECT_RESERVE_S = 420.0
#: A de-accumulated day below zero is packing noise down to this (mm), clamped to 0; further below fails the run.
NEGATIVE_FAIL_MM = 5.0
MAX_DAILY_MM = 2000.0

SOURCE = "C3S seasonal-original-single-levels"
LICENCE = "CC BY 4.0, and the Additional licence to use non European contributions (CDS dataset seasonal-original-single-levels)"
CREDIT = (
    "Contains modified Copernicus Climate Change Service information [year]. "
    "Neither the European Commission nor ECMWF is responsible for any use that may be made of the Copernicus information or data it contains."
)
CITATION = (
    "Copernicus Climate Change Service, Climate Data Store (2018): Seasonal forecast daily and subdaily data on single levels. "
    "Copernicus Climate Change Service (C3S) Climate Data Store (CDS). DOI: 10.24381/cds.181d637e"
)

INDEX_KEY = f"{PRODUCT}/index.json"

BadEvent = cdsjob.BadEvent
RequestsFailed = cdsjob.RequestsFailed
CdsError = cdsjob.CdsError


class C3sFormatError(ValueError):
    """A file that isn't the request's: the run fails before anything is written."""


# --- names ---------------------------------------------------------------------------------


def forecast_product(init: str) -> str:
    return f"{PRODUCT}/{init}"


def hindcast_product(system: str, mm: str) -> str:
    return f"{HC_PRODUCT}/{system}/{mm}"


def product_of(key: tuple) -> str:
    return forecast_product(key[2]) if key[0] == "fc" else hindcast_product(key[1], key[2])


def file_url(key: tuple) -> str:
    """The manifest's `url` for a request: what was asked, not the (expiring) download link."""
    when = key[2] if key[0] == "fc" else f"hindcast/{key[2]}"
    return f"cds://{DATASET}/{VARIABLE}/{key[1]}/{when}"


def centres_of(systems) -> list[str]:
    """The contributing centres' names, once each, in the systems' order."""
    out = []
    for s in systems:
        name = CENTRE_NAMES.get(centre_of(s), centre_of(s))
        if name not in out:
            out.append(name)
    return out


def init_str(y: int, m: int) -> str:
    return f"{y:04d}-{m:02d}"


def prev_init(init: str) -> str:
    y, m = cdsjob.prev_month((int(init[:4]), int(init[5:])))
    return init_str(y, m)


def next_init(init: str) -> str:
    y, m = cdsjob.next_month((int(init[:4]), int(init[5:])))
    return init_str(y, m)


def newest_released(system: str, now: dt.datetime) -> str:
    """The newest init `system`'s forecast is on the CDS for at `now` (UTC), with the margin."""
    init = init_str(now.year, now.month)
    while release_at(system, init) + dt.timedelta(seconds=RELEASE_MARGIN_S) > now:
        init = prev_init(init)
    return init


# --- reading one request's GRIB ------------------------------------------------------------


@dataclasses.dataclass
class Decoded:
    years: list[int]  # the starts' years (one for a forecast)
    members: int
    values: np.ndarray  # float32 mm/day, (years, members, LEAD_DAYS, GRID.rows, GRID.cols), south-up


def _axis_map(first: float, inc: float, n: int, origin: float, size: int, what: str) -> tuple[np.ndarray, np.ndarray]:
    """(file indices, grid indices) of the file's points that are grid cell centres."""
    coords = first + inc * np.arange(n)
    idx = np.rint((coords - origin) / GRID.step).astype(int)
    on = np.abs(coords - (origin + idx * GRID.step)) < 1e-3
    if not on.all():
        raise C3sFormatError(f"the file's {what} points are not on whole degrees")
    keep = (idx >= 0) & (idx < size)
    return np.nonzero(keep)[0], idx[keep]


def read_request(path: str, key: tuple) -> Decoded:
    """Request `key`'s GRIB as the copy's daily totals (mm/day). Two passes:
    the headers (what starts, members and leads it holds), then the values."""
    import eccodes

    kind, system, when = key
    month = int(when[-2:])
    want_years = [int(when[:4])] if kind == "fc" else list(HINDCAST_YEARS)

    def messages():
        with open(path, "rb") as f:
            while (h := eccodes.codes_grib_new_from_file(f)) is not None:
                try:
                    yield h
                finally:
                    eccodes.codes_release(h)

    seen = set()
    years, numbers = set(), set()
    gridkeys = None
    for h in messages():
        get = lambda k: eccodes.codes_get(h, k)  # noqa: E731
        if get("shortName") != "tp" or get("units") != "m":
            raise C3sFormatError(f"{path} holds {get('shortName')} in {get('units')}, not tp in m")
        if get("stepType") != "accum" or get("startStep") != 0:
            raise C3sFormatError(f"{path}: a tp field accumulated over {get('stepRange')}, not from the start")
        date = get("dataDate")
        y, mo = date // 10000, date // 100 % 100
        if mo != month or y not in want_years:
            raise C3sFormatError(f"{path}: a field from the {date} start, not {key_str(key)}'s")
        hour = get("endStep")
        if hour % 24 or not 0 <= hour <= LEAD_HOURS[-1]:
            raise C3sFormatError(f"{path}: a lead of {hour} h")
        k = (y, get("number"), hour)
        if k in seen:
            raise C3sFormatError(f"{path}: the {y} start's member {k[1]} at {hour} h twice")
        seen.add(k)
        years.add(y)
        numbers.add(k[1])
        g = (get("gridType"), get("Ni"), get("Nj"), float(get("latitudeOfFirstGridPointInDegrees")), float(get("longitudeOfFirstGridPointInDegrees")), float(get("iDirectionIncrementInDegrees")), float(get("jDirectionIncrementInDegrees")), get("jScansPositively"), get("iScansNegatively"))
        if gridkeys is None:
            gridkeys = g
        elif g != gridkeys:
            raise C3sFormatError(f"{path}: its fields are on different grids")
    if not seen:
        raise C3sFormatError(f"{path} holds no field")
    gtype, ni, nj, lat1, lon1, di, dj, j_south, i_neg = gridkeys
    if gtype != "regular_ll" or i_neg != 0 or abs(di - GRID.step) > 1e-6 or abs(dj - GRID.step) > 1e-6:
        raise C3sFormatError(f"{path} is not on a regular {GRID.step} deg grid ({gtype}, {di} x {dj})")
    rows_f, rows_g = _axis_map(lat1, dj if j_south == 1 else -dj, nj, GRID.origin["lat"], GRID.rows, "latitude")
    cols_f, cols_g = _axis_map(lon1 if lon1 < 180 else lon1 - 360, di, ni, GRID.origin["lon"], GRID.cols, "longitude")

    ys = sorted(years)
    nums = sorted(numbers)
    yi = {y: i for i, y in enumerate(ys)}
    mi = {n: i for i, n in enumerate(nums)}
    acc = np.full((len(ys), len(nums), LEAD_DAYS + 1, GRID.rows, GRID.cols), np.nan, dtype=np.float32)
    acc[:, :, 0] = 0.0
    for h in messages():
        get = lambda k: eccodes.codes_get(h, k)  # noqa: E731
        hour = get("endStep")
        if hour == 0:
            continue
        vals = eccodes.codes_get_values(h).reshape(nj, ni)
        if get("bitmapPresent"):
            vals = np.where(vals == get("missingValue"), np.nan, vals)
        sub = vals[np.ix_(rows_f, cols_f)]
        date = get("dataDate")
        acc[yi[date // 10000], mi[get("number")], hour // 24][np.ix_(rows_g, cols_g)] = sub * 1000.0
    # In place, newest lead first, so a hindcast needs one array, not two (CMCC's 40 members x 24 years is ~770 MB).
    for d in range(LEAD_DAYS, 0, -1):
        acc[:, :, d] -= acc[:, :, d - 1]
    daily = acc[:, :, 1:]
    noise = (daily < 0) & (daily >= -NEGATIVE_FAIL_MM)
    daily[noise] = 0.0
    bad = ~np.isnan(daily) & ((daily < 0) | (daily > MAX_DAILY_MM))
    if bad.any():
        y, m, d, r, c = (int(i) for i in np.argwhere(bad)[0])
        raise C3sFormatError(
            f"{path}: {int(bad.sum())} day(s) outside 0-{MAX_DAILY_MM:g} mm, the first {float(daily[y, m, d, r, c]):.3f} mm on lead day {d} of the {ys[y]} start, member {nums[m]}, at {GRID.origin['lat'] + r:.0f}, {GRID.origin['lon'] + c:.0f}"
        )
    return Decoded(years=ys, members=len(nums), values=daily)


# --- writing -------------------------------------------------------------------------------


def _common_attrs(systems) -> dict:
    return {"source": SOURCE, "licence": LICENCE, "credit": CREDIT, "citation": CITATION, "centres": centres_of(systems), "variable": VAR, **GRID.attrs}


def _array_attrs(first_day: str | None) -> dict:
    return {"units": "mm/day", "long_name": "daily precipitation (de-accumulated from C3S total_precipitation)", **({"firstDay": first_day} if first_day else {}), "leadDays": LEAD_DAYS, **GRID.attrs}


def _ensure_groups(store, path: str):
    import zarr

    zarr.open_group(store=store, mode="a", zarr_format=3)
    parts = path.split("/")
    for i in range(1, len(parts) + 1):
        g = zarr.open_group(store=store, path="/".join(parts[:i]), mode="a", zarr_format=3)
    return g


def _create(store, path: str, shape, dims, attrs):
    import zarr
    from zarr.codecs import BytesCodec, GzipCodec

    return zarr.create_array(
        store=store,
        name=f"{path}/{VAR}",
        shape=shape,
        chunks=CHUNKS,
        dtype="float32",
        fill_value=np.nan,
        serializer=BytesCodec(endian="little"),
        compressors=[GzipCodec(level=zarrstore.GZIP_LEVEL)],
        filters=None,
        dimension_names=dims,
        attributes=attrs,
        overwrite=True,
    )


def write_forecast_system(mirror, init: str, system: str, dec: Decoded) -> None:
    """Write one system's members into `c3s/<init>/tp_mm`, creating the init's array (every SYSTEMS slot) or growing it."""
    import zarr

    product = forecast_product(init)
    # The system's slot, from the group's own list (its metadata is plain JSON), so only that slot's chunks are staged.
    meta = mirror.read_json(f"{product}/zarr.json")
    systems = list((meta or {}).get("attributes", {}).get("systems") or SYSTEMS)
    if system not in systems:
        systems.append(system)
    s = systems.index(system)
    prefixes = [f"{PRODUCT}/zarr.json", f"{product}/zarr.json", f"{product}/{VAR}/zarr.json", f"{product}/{VAR}/c/{s}/"]
    with mirror.stage(prefixes) as root:
        store = zarr.storage.LocalStore(root)
        g = _ensure_groups(store, product)
        if (root / product / VAR / "zarr.json").exists():
            arr = zarr.open_array(store=store, path=f"{product}/{VAR}", mode="r+", zarr_format=3)
            members = list(g.attrs["members"])
            while len(members) < len(systems):
                members.append(0)
        else:
            arr = _create(store, product, (len(systems), max(dec.members, 1), LEAD_DAYS, GRID.rows, GRID.cols), ("system", "member", "lead_day", "lat", "lon"), _array_attrs(f"{init}-01"))
            members = [0] * len(systems)
        width = max(arr.shape[1], dec.members)
        if arr.shape[0] < len(systems) or arr.shape[1] < width:
            arr.resize((len(systems), width, LEAD_DAYS, GRID.rows, GRID.cols))
        slab = np.full((width, LEAD_DAYS, GRID.rows, GRID.cols), np.nan, dtype=np.float32)
        slab[: dec.members] = dec.values[0]
        arr[s] = slab
        members[s] = dec.members
        held = [x for x, n in zip(systems, members) if n > 0]
        g.attrs.update({**_common_attrs(held), "init": init, "firstDay": f"{init}-01", "leadDays": LEAD_DAYS, "systems": systems, "members": members})


def write_hindcast(mirror, system: str, mm: str, dec: Decoded) -> None:
    """Write `c3s-hc/<system>/<MM>/tp_mm` whole (one request holds every year)."""
    import zarr

    product = hindcast_product(system, mm)
    with mirror.stage([f"{HC_PRODUCT}/zarr.json", f"{HC_PRODUCT}/{system}/zarr.json", f"{product}/"]) as root:
        store = zarr.storage.LocalStore(root)
        g = _ensure_groups(store, product)
        arr = _create(store, product, (len(dec.years), dec.members, LEAD_DAYS, GRID.rows, GRID.cols), ("year", "member", "lead_day", "lat", "lon"), _array_attrs(None))
        for i in range(len(dec.years)):
            arr[i] = dec.values[i]
        g.attrs.update({**_common_attrs([system]), "system": system, "initMonth": int(mm), "years": dec.years, "members": dec.members, "leadDays": LEAD_DAYS})


def read_index(mirror) -> dict:
    doc = mirror.read_json(INDEX_KEY) or {}
    return {"inits": dict(doc.get("inits") or {}), "hindcasts": dict(doc.get("hindcasts") or {})}


def _write_index(mirror, idx: dict) -> None:
    mirror.write_json(
        INDEX_KEY,
        {
            "inits": {k: sorted(idx["inits"][k], key=_system_order) for k in sorted(idx["inits"], reverse=True)},
            "hindcasts": {k: sorted(set(idx["hindcasts"][k])) for k in sorted(idx["hindcasts"], key=_system_order)},
        },
    )


def _system_order(s: str):
    order = list(SYSTEMS)
    return (order.index(s) if s in order else len(order), s)


def ingest_request(mirror, key: tuple, path: Path, now: Callable[[], str] = manifest.utc_now) -> dict:
    """Write one collected request into its product, its manifest and the index."""
    dec = read_request(str(path), key)
    kind, system, when = key
    product = product_of(key)
    sha = manifest.values_sha256(dec.values.reshape(-1, GRID.rows, GRID.cols))
    url = file_url(key)
    m = manifest.read(mirror, product) or manifest.new(product)
    previous = manifest.file_entry(m, url)
    outcome = "unchanged"
    if previous is None or previous["valuesSha256"] != sha:
        if kind == "fc":
            write_forecast_system(mirror, when, system, dec)
        else:
            write_hindcast(mirror, system, when, dec)
        if previous is None:
            outcome = "added"
        else:
            # The forecast was re-collected (state lost) and came back different: claim every cell.
            m["revision"] += 1
            first = dt.date(dec.years[0], int(when[-2:]), 1)
            m["changes"].append({"revision": m["revision"], "days": [first.isoformat(), (first + dt.timedelta(days=LEAD_DAYS - 1)).isoformat()], "cellsChanged": GRID.rows * GRID.cols, "maxAbsDiff": MAX_DAILY_MM})
            outcome = "changed"
    manifest.upsert_file(m, {"url": url, "etag": None, "lastModified": None, "size": path.stat().st_size, "valuesSha256": sha, "revision": m["revision"], "fetchedAt": now()})
    if kind == "fc":
        last = dt.date(dec.years[0], int(when[5:]), 1) + dt.timedelta(days=LEAD_DAYS - 1)
        m["years"] = {"first": dec.years[0], "last": last.year}
    else:
        m["years"] = {"first": dec.years[0], "last": dec.years[-1]}
    manifest.write(mirror, m)
    idx = read_index(mirror)
    if kind == "fc":
        idx["inits"].setdefault(when, [])
        if system not in idx["inits"][when]:
            idx["inits"][when].append(system)
    else:
        idx["hindcasts"].setdefault(system, [])
        if when not in idx["hindcasts"][system]:
            idx["hindcasts"][system].append(when)
    _write_index(mirror, idx)
    return {"request": key_str(key), "outcome": outcome, "years": dec.years, "members": dec.members, "revision": m["revision"]}


def held_keys(idx: dict) -> set[tuple]:
    out = {("fc", s, init) for init, systems in idx["inits"].items() for s in systems}
    out |= {("hc", s, mm) for s, months in idx["hindcasts"].items() for mm in months}
    return out


# --- the request state ---------------------------------------------------------------------

ENTRY = {"requestId": None, "submittedAt": None, "purpose": None, "wanted": False, "attempts": 0, "retryAt": None, "lastError": None, "collectedAt": None}


def state_key() -> str:
    return cdsjob.state_key(PRODUCT)


def read_state(mirror) -> tuple[dict, bool]:
    doc = mirror.read_json(state_key())
    if doc is None:
        return {"requests": {}}, False
    return {"requests": {k: {**ENTRY, **v} for k, v in (doc.get("requests") or {}).items() if parse_key(k)}}, True


def write_state(mirror, st: dict) -> None:
    mirror.write_json(state_key(), {"requests": {k: st["requests"][k] for k in sorted(st["requests"])}})


def backoff_seconds(attempts: int) -> float:
    return cdsjob.backoff_seconds(attempts, BACKOFF_BASE_DAYS, BACKOFF_MAX_DAYS)


# --- one run ---------------------------------------------------------------------------------

Run = cdsjob.Run


def run(mirror, mode: str, ev: dict, r: Run) -> dict:
    with lease.hold(mirror, PRODUCT, r.clock):
        refused = mirror.read_json(cdsjob.refused_key(PRODUCT))
        if refused and refused.get("date") == r.today.isoformat():
            raise polite.StopRun(f"{cdsjob.CDS_URL} (refused earlier today, {refused.get('status')})", refused.get("status") or 403)
        try:
            return _run(mirror, mode, ev, r)
        except polite.StopRun as e:
            mirror.write_json(cdsjob.refused_key(PRODUCT), {"date": r.today.isoformat(), "status": e.status, "at": cdsjob._iso(r.clock())})
            raise


def _run(mirror, mode: str, ev: dict, r: Run) -> dict:
    st, existed = read_state(mirror)
    reqs = st["requests"]
    held = held_keys(read_index(mirror))
    now = r.clock()
    out = {"collected": [], "submitted": [], "failed": [], "inFlight": 0, "gaveUp": []}

    for key in held:
        e = reqs.setdefault(key_str(key), dict(ENTRY))
        if e["collectedAt"] is None and e["requestId"] is None:
            e["collectedAt"] = r.now()

    # 1. Collect every request in flight.
    for ks in sorted(k for k, e in reqs.items() if e["requestId"]):
        e = reqs[ks]
        key = parse_key(ks)
        status = r.cds.status(e["requestId"])
        if status in ("accepted", "running"):
            continue
        if status == "successful":
            if not r.budget.allows(0):
                log.info("c3s: %s is ready, but too little time is left; the next run collects it", ks)
                continue
            with tempfile.TemporaryDirectory(prefix="c3s-", dir=r.workdir) as tmp:
                path = Path(tmp) / "request.grib"
                r.cds.download(e["requestId"], str(path))
                res = ingest_request(mirror, key, path, r.now)
            log.info("c3s: %s %s (%s), %d member(s), years %s", res["outcome"], ks, e["purpose"], res["members"], res["years"])
            res["purpose"] = e["purpose"]
            out["collected"].append(res)
            e.update(requestId=None, submittedAt=None, wanted=False, attempts=0, retryAt=None, lastError=None, collectedAt=r.now(), purpose=None)
            held.add(key)
        else:
            e["attempts"] += 1
            e.update(requestId=None, submittedAt=None, lastError=f"the request ended {status}", retryAt=cdsjob._iso(now + backoff_seconds(e["attempts"])))
            log.warning("c3s: the %s request ended %s (attempt %d); resubmitting after %s", ks, status, e["attempts"], e["retryAt"])
            out["failed"].append({"request": ks, "status": status, "attempts": e["attempts"], "retryAt": e["retryAt"]})
        write_state(mirror, st)

    # 2. What this run wants: forecasts (newest first), then the wanted hindcasts.
    wanted: list[tuple[tuple, str]] = []
    if mode == "monthly":
        at = dt.datetime.fromtimestamp(now, dt.UTC)
        fc = []
        for system in SYSTEMS:
            newest = newest_released(system, at)
            floor = newest
            for _ in range(CATCH_UP_INITS - 1):
                floor = prev_init(floor)
            mine = sorted(k[2] for k in held if k[0] == "fc" and k[1] == system)
            init = max(next_init(mine[-1]), floor) if mine else newest
            while init <= newest:
                if ("fc", system, init) not in held:
                    fc.append(("fc", system, init))
                init = next_init(init)
        fc.sort(key=lambda k: (k[2], -_system_order(k[1])[0]), reverse=True)
        wanted += [(k, "new") for k in fc]
    else:
        for system in [ev["system"]] if ev.get("system") else SYSTEMS:
            key = ("hc", system, ev["month"])
            if key not in held:
                reqs.setdefault(key_str(key), dict(ENTRY))["wanted"] = True
    for ks in sorted((k for k, e in reqs.items() if e["wanted"]), key=lambda k: (parse_key(k)[2], _system_order(parse_key(k)[1]))):
        key = parse_key(ks)
        if key not in held:
            wanted.append((key, "backfill"))

    # 3. Submit while slots are free: at most one request per key in flight.
    in_flight = sum(1 for e in reqs.values() if e["requestId"])
    for key, purpose in wanted:
        ks = key_str(key)
        e = reqs.setdefault(ks, dict(ENTRY))
        if e["requestId"]:
            continue
        if e["attempts"] >= MAX_ATTEMPTS:
            out["gaveUp"].append(ks)
            continue
        if e["retryAt"] and cdsjob._epoch(e["retryAt"]) > now:
            continue
        if in_flight >= MAX_IN_FLIGHT:
            break
        rid = None
        if e["submittedAt"] or not existed:
            rid = r.cds.find(DATASET, key)
            if rid:
                log.info("c3s: adopting the CDS request %s already queued for %s", rid, ks)
        if rid is None:
            e.update(submittedAt=cdsjob._iso(now), purpose=purpose)
            write_state(mirror, st)  # the intent, before the submit
            try:
                rid = r.cds.submit(DATASET, request(key))
            except CdsError as err:
                e["attempts"] += 1
                e.update(submittedAt=None, lastError=str(err), retryAt=cdsjob._iso(now + backoff_seconds(e["attempts"])))
                write_state(mirror, st)
                out["failed"].append({"request": ks, "status": "submit-error", "attempts": e["attempts"], "retryAt": e["retryAt"]})
                continue
            log.info("c3s: submitted %s (%s) as %s", ks, purpose, rid)
        e.update(requestId=rid, submittedAt=e["submittedAt"] or cdsjob._iso(now), purpose=purpose)
        out["submitted"].append({"request": ks, "purpose": purpose, "requestId": rid})
        in_flight += 1
        write_state(mirror, st)

    out["inFlight"] = in_flight
    write_state(mirror, st)
    if out["gaveUp"]:
        raise RequestsFailed(f"c3s: the requests {', '.join(out['gaveUp'])} failed {MAX_ATTEMPTS} times; clear their entries in {state_key()} to try again (ingest/README.md)")
    return out


# --- the handler (lambda_handler.py hands c3s events here) ------------------------------------


def validate_event(event) -> dict:
    """{"product": "c3s", "mode": "monthly"} or {"product": "c3s", "mode": "backfill", "month": "MM", "system"?}; BadEvent otherwise."""
    if not isinstance(event, dict):
        raise BadEvent("the event must be a JSON object")
    extra = set(event) - {"product", "mode", "month", "system"}
    if extra:
        raise BadEvent(f"unknown event keys: {sorted(extra)}")
    if event.get("product") != PRODUCT:
        raise BadEvent(f"product must be {PRODUCT!r}")
    mode = event.get("mode")
    if mode == "monthly":
        if "month" in event or "system" in event:
            raise BadEvent("a monthly run takes no month or system")
        return {"product": PRODUCT, "mode": mode, "month": None, "system": None}
    if mode != "backfill":
        raise BadEvent(f"mode must be monthly or backfill, got {mode!r}")
    month, system = event.get("month"), event.get("system")
    if not (isinstance(month, str) and len(month) == 2 and month.isdigit() and 1 <= int(month) <= 12):
        raise BadEvent(f'a backfill names the hindcast\'s init month ("month": "01".."12"), got {month!r}')
    if system is not None and system not in SYSTEMS:
        raise BadEvent(f"system must be one of {list(SYSTEMS)}, got {system!r}")
    return {"product": PRODUCT, "mode": mode, "month": month, "system": system}


def lag_days(idx: dict, today: dt.date) -> int | None:
    """Days since the 1st of the newest init every system of SYSTEMS is held for; None when there is none."""
    full = [init for init, systems in idx["inits"].items() if set(SYSTEMS) <= set(systems)]
    return (today - dt.date.fromisoformat(f"{max(full)}-01")).days if full else None


def _fake(variant, today):
    import fakecds

    return fakecds.FakeC3sCds(variant=variant, today=today)


def handler(event, context=None, s3_client=None, metrics=None, cds=None, clock=None, today=None, secrets_client=None) -> dict:
    """Run one c3s event; MirrorLagDays{Product=c3s} on every exit once the event is valid and the copy known.
    `s3_client`, `metrics`, `cds`, `clock`, `today` and `secrets_client` are for tests."""
    clock = clock or time.time
    today_d = (today or (lambda: dt.datetime.fromtimestamp(clock(), dt.UTC).date()))()
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

    def publish():
        lag = lag_days(read_index(mirror), today_d)
        if lag is None:
            log.info("c3s: the copy holds no complete init yet; no %s to publish (the alarm treats that as breaching)", cloudwatch.METRIC)
        else:
            metrics.publish(PRODUCT, lag)
        return lag

    try:
        if cds is None:
            if live:
                cds = cdsjob.LazyLiveCds(
                    lambda: cdsjob.LiveCds(
                        cdsjob.read_cds_key(os.environ.get("CDS_KEY_SECRET_ARN", ""), secrets_client, PRODUCT, RUNBOOK),
                        contact=os.environ.get("INGEST_CONTACT"),
                        request_month=request_key,
                    )
                )
            else:
                cds = _fake(os.environ.get("INGEST_FIXTURE_VARIANT") or None, today_d)
        r = Run(cds=cds, budget=chirps_final.Budget(context, COLLECT_RESERVE_S), today=today_d, clock=clock)
        out = run(mirror, ev["mode"], ev, r)
    except lease.MirrorBusy as e:
        lag = publish()
        if ev["mode"] == "backfill":
            raise
        log.info("c3s: %s; the run holding it does this work", e)
        return _result(ev, source, mirror, {"busy": str(e)}, lag)
    except BaseException:
        try:
            publish()
        except Exception:
            log.exception("c3s: could not publish %s while failing", cloudwatch.METRIC)
        raise
    return _result(ev, source, mirror, out, publish())


def _result(ev, source, mirror, out, lag) -> dict:
    idx = read_index(mirror)
    return {"product": PRODUCT, "mode": ev["mode"], "source": source, "newestInit": max(idx["inits"]) if idx["inits"] else None, "lagDays": lag, **out}
