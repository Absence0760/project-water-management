"""Writes the synthetic ECMWF ENS step files fixtures mode serves
(ingest/fixtures/ecmwf/, issue #604 R4-C) and builds the structured ones
the tests write into temporary directories. Invented values only.

The committed files are one issue (FIXTURE_ISSUE), 15 steps (24 … 360 h),
each a GRIB2 file plus its `.index` laid out as ECMWF's open data is: the
fields of every member one after another, with a field of another
parameter (2 m temperature) between them, so the job's index filter has
something to skip. They use ECMWF's real 0.1 deg global grid (3600 x 1801
points from 90 N, 0 E), but each field is constant (GRIB packs a constant
field in no bits, so a step file is a few hundred bytes): member m's day d
is `fixture_daily_mm(m, d)` mm everywhere. The tests' own files
(`step_file` with a function of lat/lon) carry the spatial structure the
subset and the corner mean are checked against.

    ingest/.venv/bin/python ingest/fixtures/ecmwf/make_ecmwf_fixtures.py

The fixture opener (ingest/ecmwf_fixturehttp.py) re-dates these files to
whatever issue is asked for.
"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Callable

import numpy as np

HERE = Path(__file__).resolve().parent
FIXTURE_ISSUE = dt.date(2026, 2, 9)
FIXTURE_MEMBERS = 4
STEPS = tuple(24 * (d + 1) for d in range(15))

# ECMWF's 0.1 deg global grid.
GLOBAL = {"ni": 3600, "nj": 1801, "lat1": 90.0, "lon1": 0.0, "lat2": -90.0, "lon2": 359.9, "step": 0.1}


def fixture_daily_mm(member: int, day: int) -> float:
    """The committed fixture's rain, the same everywhere: 0–9 mm in 1.5 mm steps."""
    return ((day * 3 + member * 5) % 7) * 1.5


def name(issue: dt.date, step: int, ext: str) -> str:
    return f"{issue:%Y%m%d}000000-{step}h-enfo-ef-sfc.{ext}"


def message(issue: dt.date, step: int, member: int, values, grid: dict = GLOBAL, short: str = "tp") -> bytes:
    """One GRIB2 message: an ensemble member's field accumulated from 0 h to
    `step` (tp) or at `step` (2t). `values` is a number (a constant field) or
    an array (nj, ni) in the grid's row order (north first)."""
    import eccodes

    h = eccodes.codes_grib_new_from_samples("GRIB2")
    try:
        eccodes.codes_set(h, "productDefinitionTemplateNumber", 11 if short == "tp" else 1)
        eccodes.codes_set(h, "typeOfGeneratingProcess", 4)
        eccodes.codes_set(h, "typeOfProcessedData", 4)
        eccodes.codes_set(h, "numberOfForecastsInEnsemble", 50)
        eccodes.codes_set(h, "number", member)
        eccodes.codes_set(h, "dataDate", int(issue.strftime("%Y%m%d")))
        eccodes.codes_set(h, "dataTime", 0)
        if short == "tp":
            eccodes.codes_set_string(h, "shortName", "tp")
            eccodes.codes_set_string(h, "stepType", "accum")
            eccodes.codes_set(h, "startStep", 0)
            eccodes.codes_set(h, "endStep", step)
        else:
            eccodes.codes_set_string(h, "shortName", "2t")
            eccodes.codes_set(h, "step", step)
        eccodes.codes_set(h, "gridType", "regular_ll")
        for k, v in {
            "Ni": grid["ni"],
            "Nj": grid["nj"],
            "latitudeOfFirstGridPointInDegrees": grid["lat1"],
            "longitudeOfFirstGridPointInDegrees": grid["lon1"],
            "latitudeOfLastGridPointInDegrees": grid["lat2"],
            "longitudeOfLastGridPointInDegrees": grid["lon2"],
            "iDirectionIncrementInDegrees": grid["step"],
            "jDirectionIncrementInDegrees": grid["step"],
            "jScansPositively": 0,
            "iScansNegatively": 0,
        }.items():
            eccodes.codes_set(h, k, v)
        n = grid["ni"] * grid["nj"]
        arr = np.full(n, float(values)) if np.isscalar(values) else np.asarray(values, dtype=np.float64).reshape(n)
        if not np.isscalar(values):
            eccodes.codes_set(h, "bitsPerValue", 24)
        eccodes.codes_set_values(h, arr)
        return eccodes.codes_get_message(h)
    finally:
        eccodes.codes_release(h)


def step_file(issue: dt.date, step: int, cum_m: Callable[[int], object], members: int, grid: dict = GLOBAL) -> tuple[bytes, str]:
    """A step's GRIB2 bytes and its index: per member a 2t field then the tp
    field `cum_m(member)` (metres, accumulated), members in a shuffled order
    as ECMWF's files have them."""
    order = [((m * 7) % members) + 1 for m in range(members)]
    blob = bytearray()
    lines = []
    for m in order:
        for short in ("2t", "tp"):
            msg = message(issue, step, m, 280.0 if short == "2t" else cum_m(m), grid, short)
            rec = {
                "domain": "g",
                "date": issue.strftime("%Y%m%d"),
                "time": "0000",
                "expver": "0001",
                "class": "od",
                "type": "pf",
                "stream": "enfo",
                "levtype": "sfc",
                "number": str(m),
                "step": str(step),
                "param": short,
                "_offset": len(blob),
                "_length": len(msg),
            }
            lines.append(json.dumps(rec))
            blob += msg
    return bytes(blob), "\n".join(lines) + "\n"


def cum_fixture_m(member: int, step: int) -> float:
    days = step // 24
    return sum(fixture_daily_mm(member, d) for d in range(days)) / 1000.0


def main(out: Path = HERE) -> None:
    for step in STEPS:
        grib, index = step_file(FIXTURE_ISSUE, step, lambda m: cum_fixture_m(m, step), FIXTURE_MEMBERS)
        (out / name(FIXTURE_ISSUE, step, "grib2")).write_bytes(grib)
        (out / name(FIXTURE_ISSUE, step, "index")).write_text(index)


if __name__ == "__main__":
    main()
