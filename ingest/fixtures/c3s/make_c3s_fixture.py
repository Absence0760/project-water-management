"""Write a synthetic C3S seasonal request's GRIB as the CDS returns it (fixtures mode, tests).

    ingest/.venv/bin/python ingest/fixtures/c3s/make_c3s_fixture.py fc/ecmwf-51/2026-10 OUT.grib [--members 3] [--leads 30]
    ingest/.venv/bin/python ingest/fixtures/c3s/make_c3s_fixture.py hc/ecmwf-51/10 OUT.grib [--years 1993,1994]

Invented values in the layout of a `seasonal-original-single-levels` request
for `total_precipitation` over area [-8, 10, -36, 41] (issue #620): GRIB2,
one message per (start year, member, lead), `tp` in m **accumulated from
the start**, `endStep` the lead in hours (24, 48, …), `number` the member
(from 0, as ECMWF numbers them), `dataDate` the start (the 1st of the init
month; a hindcast's year is its own), a regular 1 deg grid from 8 S, 10 E,
north first.

Nothing here is written to the repo: the fake CDS (ingest/fakecds.py,
`FakeC3sCds`) calls `write_request` for each download, so the file is always
the one this script describes. `daily_mm()` says what each day holds (mm, the
day's rain, before accumulation), so tests check the copy against it. No
client or real data: a pattern of whole tenths of a millimetre that differs
by system, member, year, day and cell.

Tiny on purpose: a few members (`members`, default 2, ECMWF 3), any number
of leads up to the request's (`leads`), and a hindcast's years limited to
`years` (default the first three of the request), which is also how a system
holding fewer hindcast years than asked looks.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import c3srequest  # noqa: E402

#: The file's grid: the request's area at 1 deg, north first.
NORTH, WEST, SOUTH, EAST = c3srequest.AREA
NLAT = round(NORTH - SOUTH) + 1
NLON = round(EAST - WEST) + 1
DEFAULT_MEMBERS = {"ecmwf-51": 3}
DEFAULT_HINDCAST_YEARS = 3


def members_of(system: str, members=None) -> int:
    if isinstance(members, dict):
        return members.get(system, DEFAULT_MEMBERS.get(system, 2))
    return members if members is not None else DEFAULT_MEMBERS.get(system, 2)


def daily_mm(system: str, year: int, member: int, day: int, i: np.ndarray, j: np.ndarray) -> np.ndarray:
    """Day `day`'s (lead day, 0 = the 1st) rain in mm for south-up cell (i, j) of grid.C3S: 0-11 mm in 0.5 mm steps, some dry days."""
    s = sum(map(ord, system)) % 11
    v = ((i * 7 + j * 13 + day * 5 + member * 3 + year + s) % 23) * 0.5
    return np.where(((i + j + day + member) % 7) == 0, 0.0, v)


def _message(values_m: np.ndarray, date: int, hour: int, member: int, members: int) -> bytes:
    import eccodes

    h = eccodes.codes_grib_new_from_samples("GRIB2")
    try:
        eccodes.codes_set(h, "productDefinitionTemplateNumber", 11)
        eccodes.codes_set(h, "typeOfGeneratingProcess", 4)
        eccodes.codes_set(h, "typeOfProcessedData", 4)
        eccodes.codes_set(h, "numberOfForecastsInEnsemble", members)
        eccodes.codes_set(h, "number", member)
        eccodes.codes_set(h, "dataDate", date)
        eccodes.codes_set(h, "dataTime", 0)
        eccodes.codes_set_string(h, "shortName", "tp")
        eccodes.codes_set_string(h, "stepType", "accum")
        eccodes.codes_set(h, "startStep", 0)
        eccodes.codes_set(h, "endStep", hour)
        eccodes.codes_set(h, "gridType", "regular_ll")
        for k, v in {
            "Ni": NLON,
            "Nj": NLAT,
            "latitudeOfFirstGridPointInDegrees": NORTH,
            "longitudeOfFirstGridPointInDegrees": WEST,
            "latitudeOfLastGridPointInDegrees": SOUTH,
            "longitudeOfLastGridPointInDegrees": EAST,
            "iDirectionIncrementInDegrees": 1.0,
            "jDirectionIncrementInDegrees": 1.0,
            "jScansPositively": 0,
            "iScansNegatively": 0,
        }.items():
            eccodes.codes_set(h, k, v)
        eccodes.codes_set(h, "bitsPerValue", 24)
        eccodes.codes_set_values(h, values_m.reshape(-1).astype(np.float64))
        return eccodes.codes_get_message(h)
    finally:
        eccodes.codes_release(h)


def request_years(key: tuple, years=None) -> list[int]:
    """The start years the file holds: the init's year, or a hindcast's first DEFAULT_HINDCAST_YEARS (or `years`)."""
    if key[0] == "fc":
        return [int(key[2][:4])]
    if years is None:
        return list(c3srequest.HINDCAST_YEARS[:DEFAULT_HINDCAST_YEARS])
    return [y for y in years if y in c3srequest.HINDCAST_YEARS]


def write_request(path, key: tuple, *, members=None, leads: int | None = None, years=None, values=None, skip=None) -> Path:
    """Write the request `key`'s GRIB to `path`. `values(system, year, member, day, i, j)` (mm) replaces daily_mm;
    `skip(year, member, hour)` true leaves that message out (a missing field)."""
    system = key[1]
    month = int(key[2][-2:])
    n = members_of(system, members)
    hours = c3srequest.LEAD_HOURS[: leads if leads is not None else len(c3srequest.LEAD_HOURS)]
    fn = values or daily_mm
    i, j = np.meshgrid(np.arange(NLAT), np.arange(NLON), indexing="ij")  # south-up
    out = bytearray()
    for year in request_years(key, years):
        date = year * 10000 + month * 100 + 1
        for member in range(n):
            acc = np.zeros((NLAT, NLON))
            for d, hour in enumerate(hours):
                acc = acc + np.asarray(fn(system, year, member, d, i, j), dtype=np.float64)
                if skip is not None and skip(year, member, hour):
                    continue
                out += _message((acc / 1000.0)[::-1, :], date, hour, member, n)  # north first
    path = Path(path)
    path.write_bytes(bytes(out))
    return path


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("key", help="fc/<system>/YYYY-MM or hc/<system>/MM")
    p.add_argument("out")
    p.add_argument("--members", type=int)
    p.add_argument("--leads", type=int)
    p.add_argument("--years", help="hindcast years, comma-separated")
    a = p.parse_args()
    key = c3srequest.parse_key(a.key)
    if key is None:
        p.error(f"not a request key: {a.key}")
    years = [int(y) for y in a.years.split(",")] if a.years else None
    print(write_request(a.out, key, members=a.members, leads=a.leads, years=years))


if __name__ == "__main__":
    main()
