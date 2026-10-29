"""Writes a synthetic NEX-GDDP-CMIP6 tree for cmip6_delta.py's fixtures mode
and tests (issue #621): three invented models, `SYN-A`, `SYN-B` and `SYN-C`,
each with `historical`, `ssp245` and `ssp585`, two years a scenario, the daily
`pr`, `tasmax` and `tasmin` files in NEX's real layout and key names:

    <root>/NEX-GDDP-CMIP6/<model>/<scenario>/<variant>/<var>/<var>_day_<model>_<scenario>_<variant>_<grid>_<YYYY>[_v<N.N>].nc

Nothing is committed but this script: the tests and `cmip6_delta.py --source
fixtures` write what they need into a temporary directory (a second or so).
No real model, place or value.

Each file is NetCDF-4 like NEX's: `<var>(time, lat, lon)` float32 with
`_FillValue` 1e20, pr in kg m-2 s-1, temperatures in K, a global `license`
attribute. Its axes are D1 plus one 0.25 deg cell on every side (lat
-36.125..-7.875, lon 9.875..41.125), so the cut drops a margin, and only a
few cells hold values (`LAND`): a 4 x 4 block round 33.5 S, 21.5 E, D1's
south-west cell, and two cells just outside D1 with implausible values (a
leaked margin fails the run). HDF5 chunks that no land touches are never
allocated, so a file is a few kB.

What differs between the models, so each path of the reader is exercised:

- SYN-A: `proleptic_gregorian`, "days since 1950-01-01" at noon, latitude
  ascending, `gn`; its ssp245 tasmax 2036 exists twice, the first release and
  a `_v1.1` with every value 0.5 K warmer (the reader takes v1.1).
- SYN-B: `noleap`, "days since 1850-01-01 00:00:00", latitude **descending**
  (north first), variant `r1i1p1f2`, `gr`; its ssp585 tasmin 2066 lacks one
  day (fill) at one land cell (`GAP`), so that cell's month is NaN.
- SYN-C: `360_day`, "hours since 1950-01-01" at noon, `gn`; its historical
  files say `CC BY-SA 4.0` (the archive's first licence) and its ssp585 pr
  2066 carries no `license` attribute at all.

    ingest/.venv/bin/python ingest/fixtures/cmip6/make_cmip6_fixture.py <dir>
"""

from __future__ import annotations

import datetime as dt
import math
import sys
from pathlib import Path

import numpy as np

ROOT = "NEX-GDDP-CMIP6"
STEP = 0.25
#: The file's axes: D1 (10-41 E, 35.5-8 S) plus one cell each side.
LAT0, NLAT = -36.125, 114
LON0, NLON = 9.875, 126
FILL = np.float32(1e20)
CHUNK = (6, 6)

MODELS = {
    "SYN-A": {"variant": "r1i1p1f1", "grid": "gn", "calendar": "proleptic_gregorian", "units": "days since 1950-01-01", "noon": True, "descending": False},
    "SYN-B": {"variant": "r1i1p1f2", "grid": "gr", "calendar": "noleap", "units": "days since 1850-01-01 00:00:00", "noon": False, "descending": True},
    "SYN-C": {"variant": "r1i1p1f1", "grid": "gn", "calendar": "360_day", "units": "hours since 1950-01-01", "noon": True, "descending": False},
}
SCENARIOS = ("historical", "ssp245", "ssp585")
VARIABLES = ("pr", "tasmax", "tasmin")
#: The years each scenario holds (inside cmip6_delta's windows, not contiguous on purpose for the SSPs).
YEARS = {"historical": (2013, 2014), "ssp245": (2036, 2066), "ssp585": (2036, 2066)}
LICENSE = "CC0 1.0 Universal (synthetic fixture: invented values)"
OLD_LICENSE = "CC BY-SA 4.0 (synthetic fixture: invented values)"
#: (model, scenario, var, year) files written a second time as `_v1.1`, with `V11_DELTA_K` added.
V11 = {("SYN-A", "ssp245", "tasmax", 2036)}
V11_DELTA_K = 0.5
#: (model, scenario, var, year, calendar day index, lat, lon): one day of fill at a land cell.
GAP = ("SYN-B", "ssp585", "tasmin", 2066, 40, -33.875, 21.125)
NO_LICENSE = {("SYN-C", "ssp585", "pr", 2066)}

#: Land cells (lat, lon centres) inside D1, and two outside it whose values must never reach the copy.
BLOCK = [(-33.875 + 0.25 * i, 21.125 + 0.25 * j) for i in range(4) for j in range(4)]
CORNER = (-35.375, 10.125)
LAND = [*BLOCK, CORNER]
OUTSIDE = [(-35.625, 10.125), (-35.375, 9.875)]
#: An outside cell's daily rain (mm) and temperature (K): implausible, so a leaked margin fails the read.
OUTSIDE_MM = 5000.0
OUTSIDE_K = 400.0

_SCEN = {"historical": 0, "ssp245": 1, "ssp585": 2}
_MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


def calendar_days(calendar: str, year: int) -> list[tuple[int, int]]:
    """Every (month, day) of `year` in the calendar, in order."""
    if calendar == "360_day":
        return [(m, d) for m in range(1, 13) for d in range(1, 31)]
    leap = calendar == "proleptic_gregorian" and (year % 4 == 0 and (year % 100 != 0 or year % 400 == 0))
    return [(m, d) for m in range(1, 13) for d in range(1, _MONTH_DAYS[m - 1] + (1 if leap and m == 2 else 0) + 1)]


def _cell(lat: float, lon: float) -> tuple[int, int]:
    return round((lat - LAT0) / STEP), round((lon - LON0) / STEP)


def daily_mm(model: str, scenario: str, year: int, k: int, month: int, lat: float, lon: float) -> float:
    """The invented rain (mm/day) on calendar day index `k` (month `month`) at a land cell: winter-wet, drier under each SSP."""
    i, j = _cell(lat, lon)
    mi = int(model[-1], 36) - 10
    base = ((k * 5 + i * 3 + j * 7 + year + mi * 11) % 9) * 0.5
    season = 1.5 if month in (5, 6, 7, 8) else 0.6
    return base * season * (1.0, 0.9, 0.8)[_SCEN[scenario]]


def daily_k(var: str, model: str, scenario: str, year: int, k: int, ndays: int, lat: float, lon: float) -> float:
    """The invented tasmax or tasmin (K) on calendar day index `k` at a land cell: a seasonal cycle, warmer under each SSP."""
    i, j = _cell(lat, lon)
    mi = int(model[-1], 36) - 10
    tmax = 273.15 + 22.0 + 7.0 * math.cos(2 * math.pi * (k - 15) / ndays) + (0.0, 1.5, 3.0)[_SCEN[scenario]] + mi * 0.3 + ((i + j) % 4) * 0.25
    return tmax if var == "tasmax" else tmax - 11.0 - (i % 3)


def file_name(model: str, scenario: str, var: str, year: int, version: str | None = None) -> str:
    spec = MODELS[model]
    return f"{var}_day_{model}_{scenario}_{spec['variant']}_{spec['grid']}_{year}{'_' + version if version else ''}.nc"


def file_key(model: str, scenario: str, var: str, year: int, version: str | None = None) -> str:
    """The object key, as in s3://nex-gddp-cmip6/<key>."""
    return f"{ROOT}/{model}/{scenario}/{MODELS[model]['variant']}/{var}/{file_name(model, scenario, var, year, version)}"


def values(model: str, scenario: str, var: str, year: int, version: str | None = None) -> np.ndarray:
    """The file's values (days, NLAT, NLON) in its own units, south first, FILL where it holds nothing."""
    spec = MODELS[model]
    days = calendar_days(spec["calendar"], year)
    out = np.full((len(days), NLAT, NLON), FILL, dtype=np.float32)
    for lat, lon in LAND:
        i, j = _cell(lat, lon)
        for k, (month, _) in enumerate(days):
            if var == "pr":
                v = daily_mm(model, scenario, year, k, month, lat, lon) / 86400.0
            else:
                v = daily_k(var, model, scenario, year, k, len(days), lat, lon) + (V11_DELTA_K if version == "v1.1" else 0.0)
            out[k, i, j] = v
    for lat, lon in OUTSIDE:
        i, j = _cell(lat, lon)
        out[:, i, j] = OUTSIDE_MM / 86400.0 if var == "pr" else OUTSIDE_K
    if GAP[:4] == (model, scenario, var, year):
        i, j = _cell(GAP[5], GAP[6])
        out[GAP[4], i, j] = FILL
    return out


def _time_values(model: str, year: int) -> np.ndarray:
    spec = MODELS[model]
    cal = spec["calendar"]
    epoch_year = int(spec["units"].split("since ")[1][:4])
    if cal == "proleptic_gregorian":
        start = (dt.date(year, 1, 1) - dt.date(epoch_year, 1, 1)).days
    elif cal == "noleap":
        start = (year - epoch_year) * 365
    else:
        start = (year - epoch_year) * 360
    t = np.arange(len(calendar_days(cal, year)), dtype=np.float64) + start + (0.5 if spec["noon"] else 0.0)
    return t * 24 if spec["units"].startswith("hours") else t


def write_file(path: Path, model: str, scenario: str, var: str, year: int, version: str | None = None) -> None:
    import h5netcdf

    spec = MODELS[model]
    v = values(model, scenario, var, year, version)
    lat = LAT0 + np.arange(NLAT) * STEP
    if spec["descending"]:
        v, lat = v[:, ::-1, :], lat[::-1]
    path.parent.mkdir(parents=True, exist_ok=True)
    with h5netcdf.File(path, "w") as f:
        f.attrs["title"] = "Synthetic NEX-GDDP-CMIP6-like file (invented values; water-management ingest tests)"
        f.attrs["source_id"] = model
        f.attrs["scenario"] = scenario
        f.attrs["variant_label"] = spec["variant"]
        if (model, scenario, var, year) not in NO_LICENSE:
            f.attrs["license"] = OLD_LICENSE if (model == "SYN-C" and scenario == "historical") else LICENSE
        f.dimensions = {"time": v.shape[0], "lat": NLAT, "lon": NLON}
        t = f.create_variable("time", ("time",), "f8")
        t[:] = _time_values(model, year)
        t.attrs["units"] = spec["units"]
        t.attrs["calendar"] = spec["calendar"]
        la = f.create_variable("lat", ("lat",), "f8")
        la[:] = lat
        la.attrs["units"] = "degrees_north"
        lo = f.create_variable("lon", ("lon",), "f8")
        lo[:] = LON0 + np.arange(NLON) * STEP
        lo.attrs["units"] = "degrees_east"
        x = f.create_variable(var, ("time", "lat", "lon"), "f4", fillvalue=FILL, chunks=(v.shape[0], *CHUNK), compression="gzip", compression_opts=4)
        x.attrs["units"] = "kg m-2 s-1" if var == "pr" else "K"
        x.attrs["missing_value"] = FILL
        # Only the chunks a value touches: the rest stay unallocated (read as the fill).
        for lat_c, lon_c in [*LAND, *OUTSIDE]:
            i, j = _cell(lat_c, lon_c)
            if spec["descending"]:
                i = NLAT - 1 - i
            ci, cj = (i // CHUNK[0]) * CHUNK[0], (j // CHUNK[1]) * CHUNK[1]
            x[:, ci : ci + CHUNK[0], cj : cj + CHUNK[1]] = v[:, ci : ci + CHUNK[0], cj : cj + CHUNK[1]]


def write_tree(root: Path, models=tuple(MODELS), scenarios=SCENARIOS) -> list[str]:
    """Write every fixture file under `root` (plus a stray file the listing must ignore); return the keys written."""
    keys = []
    for model in models:
        for scenario in scenarios:
            for var in VARIABLES:
                for year in YEARS[scenario]:
                    versions = [None, "v1.1"] if (model, scenario, var, year) in V11 else [None]
                    for version in versions:
                        key = file_key(model, scenario, var, year, version)
                        write_file(root / key, model, scenario, var, year, version)
                        keys.append(key)
    stray = root / ROOT / "SYN-A" / "historical" / MODELS["SYN-A"]["variant"] / "hurs" / "README.txt"
    stray.parent.mkdir(parents=True, exist_ok=True)
    stray.write_text("not a variable the copy reads\n")
    return keys


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("cmip6-fixture")
    print(f"wrote {len(write_tree(out))} files under {out}")
