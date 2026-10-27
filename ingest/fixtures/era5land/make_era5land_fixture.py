"""Write a synthetic ERA5-Land month as the CDS returns it (fixtures mode, tests).

    ingest/.venv/bin/python ingest/fixtures/era5land/make_era5land_fixture.py YYYY-MM OUT.nc [--revised] [--preliminary]

Invented values in the layout of a `reanalysis-era5-land` request for
`total_precipitation` at 00:00 over area [-8, 10, -35.5, 41], NetCDF-4 with
`download_format: unarchived` (the new CDS, 2024 on): `tp(valid_time,
latitude, longitude)` float32 in m, NaN over sea, latitude descending (north
first), `valid_time` int64 "seconds since 1970-01-01", and `expver(valid_time)`
"0001" (consolidated) or "0005" (ERA5-Land-T).

Nothing here is written to the repo: the fake CDS (ingest/fakecds.py) calls
`write_month` for each download, so the file is always the one this script
describes. `value_m()` says what each point holds, so tests check the copy
against it without reading the file twice. No client or real data.

The points sit on x.x0 deg, 276 x 311 of them, the copy's cells' corners.
"Sea" is an invented strip: west of 14 deg E, and south of -34 deg east of
30 deg E. `--revised` moves one point's rain (the ERA5T -> ERA5-Land
revision the tests replay).
"""

from __future__ import annotations

import argparse
import datetime as dt
from pathlib import Path

import numpy as np

NLAT = 276
NLON = 311
LAT_S = -35.5
LON_W = 10.0
STEP = 0.1
#: The point the `revised` variant changes (south-up indices) and by how much (m).
REVISED_POINT = (150, 150)
REVISED_DELTA_M = 0.0025


def lats_south_up() -> np.ndarray:
    return np.round(LAT_S + STEP * np.arange(NLAT), 4)


def lons() -> np.ndarray:
    return np.round(LON_W + STEP * np.arange(NLON), 4)


def sea() -> np.ndarray:
    """(NLAT, NLON) south-up: True where the invented coast says sea."""
    la = lats_south_up()[:, None]
    lo = lons()[None, :]
    return (lo < 14.0) | ((la < -34.0) & (lo > 30.0))


def value_m(step: dt.date, i: np.ndarray, j: np.ndarray, revised: bool = False) -> np.ndarray:
    """tp in m at the 00 UTC step of `step` for south-up point (i, j): the day before's total."""
    k = step.toordinal()
    v = ((i * 7 + j * 13 + k * 5) % 40) * 0.0005  # 0..19.5 mm
    v = np.where(((i + j + k) % 9) == 0, 0.0, v)  # some dry days
    if revised:
        v = np.where((i == REVISED_POINT[0]) & (j == REVISED_POINT[1]), v + REVISED_DELTA_M, v)
    return v


def month_steps(year: int, month: int) -> list[dt.date]:
    nxt = dt.date(year + (month == 12), month % 12 + 1, 1)
    return [dt.date(year, month, 1) + dt.timedelta(days=d) for d in range((nxt - dt.date(year, month, 1)).days)]


def write_month(path, year: int, month: int, *, revised: bool = False, preliminary: bool | None = False, values=None) -> Path:
    """Write the month's 00 UTC steps to `path`. `values(step, i, j)` (m) replaces value_m for a test;
    `preliminary=None` writes no `expver` (a file that does not say its phase)."""
    import xarray as xr

    steps = month_steps(year, month)
    i, j = np.meshgrid(np.arange(NLAT), np.arange(NLON), indexing="ij")
    fn = values or (lambda s, i, j: value_m(s, i, j, revised))
    data = np.stack([np.asarray(fn(s, i, j), dtype=np.float64) for s in steps]).astype(np.float32)
    data[:, sea()] = np.nan
    # North first, as the CDS writes it.
    data = data[:, ::-1, :]
    epoch = dt.datetime(1970, 1, 1)
    secs = np.array([int((dt.datetime(s.year, s.month, s.day) - epoch).total_seconds()) for s in steps], dtype=np.int64)
    ds = xr.Dataset(
        {
            "tp": (("valid_time", "latitude", "longitude"), data, {"units": "m", "long_name": "Total precipitation", "GRIB_paramId": 228}),
        },
        coords={
            "valid_time": ("valid_time", secs, {"units": "seconds since 1970-01-01", "calendar": "proleptic_gregorian"}),
            "latitude": ("latitude", lats_south_up()[::-1]),
            "longitude": ("longitude", lons()),
            "number": ((), 0),
        },
        attrs={"Conventions": "CF-1.7", "institution": "synthetic fixture (ingest/fixtures/era5land), not ECMWF data"},
    )
    if preliminary is not None:
        ds["expver"] = (("valid_time",), np.array(["0005" if preliminary else "0001"] * len(steps), dtype="<U4"))
    path = Path(path)
    ds.to_netcdf(path, engine="h5netcdf", encoding={"tp": {"zlib": True, "complevel": 4, "_FillValue": np.float32(np.nan)}})
    return path


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("month", help="YYYY-MM")
    p.add_argument("out")
    p.add_argument("--revised", action="store_true")
    p.add_argument("--preliminary", action="store_true")
    a = p.parse_args()
    y, m = (int(x) for x in a.month.split("-"))
    print(write_month(a.out, y, m, revised=a.revised, preliminary=a.preliminary))


if __name__ == "__main__":
    main()
