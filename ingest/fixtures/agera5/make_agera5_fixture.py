"""Write a synthetic AgERA5 month as the CDS returns it (fixtures mode, tests).

    ingest/.venv/bin/python ingest/fixtures/agera5/make_agera5_fixture.py YYYY-MM OUT.zip [--revised] [--single]

Invented values in the shape we expect from a `sis-agrometeorological-indicators`
request for `reference_evapotranspiration`, version 2_0, over area
[-8, 10, -35.5, 41]: a **zip of one NetCDF-4 file a day** (AgERA5's usual
download form), each holding one data variable
`Reference_Evapotranspiration_FAO56(time, lat, lon)` float32 in `mm d-1`, NaN
over sea, latitude descending (north first), cell centres on x.x5 deg (AgERA5's
0.1 deg grid), `time` "days since 1900-01-01". `--single` writes one NetCDF
with every day instead, and `lattice="corners"` (write_month) puts the points
on x.x0 deg, the other lattice agera5.py accepts. **The exact variable name
and units string of the real files are unverified** (agera5.py accepts any
single data variable in mm/day); the first live run settles them.

Nothing here is written to the repo: the fake CDS (ingest/fakecds.py
FakeAgera5Cds) calls `write_month` for each download. `value_mm()` says what
each cell holds, so tests check the copy against it.

"Sea" is the same invented strip as the ERA5-Land fixture's: west of 14 deg E,
and south of -34 deg east of 30 deg E. `--revised` moves one cell's value.
"""

from __future__ import annotations

import argparse
import datetime as dt
import io
import zipfile
from pathlib import Path

import numpy as np

LAT_S = -35.5
LON_W = 10.0
STEP = 0.1
ROWS = 275
COLS = 310
VARIABLE = "Reference_Evapotranspiration_FAO56"
UNITS = "mm d-1"
#: The cell the `revised` variant changes (south-up indices) and by how much (mm).
REVISED_CELL = (150, 150)
REVISED_DELTA_MM = 0.25


def axes(lattice: str = "centres") -> tuple[np.ndarray, np.ndarray]:
    """(lats south-up, lons) of the file's points: cell centres (x.x5), or corners (x.x0, one more each way)."""
    if lattice == "centres":
        return np.round(LAT_S + STEP / 2 + STEP * np.arange(ROWS), 4), np.round(LON_W + STEP / 2 + STEP * np.arange(COLS), 4)
    return np.round(LAT_S + STEP * np.arange(ROWS + 1), 4), np.round(LON_W + STEP * np.arange(COLS + 1), 4)


def sea(lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
    la = lats[:, None]
    lo = lons[None, :]
    return (lo < 14.0) | ((la < -34.0) & (lo > 30.0))


def value_mm(day: dt.date, i: np.ndarray, j: np.ndarray, revised: bool = False) -> np.ndarray:
    """ET0 in mm on `day` at south-up point (i, j): 0.5–10.25 mm, higher in summer."""
    k = day.toordinal()
    season = 1.0 + 0.5 * np.cos(2 * np.pi * (day.timetuple().tm_yday - 15) / 365.0)
    v = (((i * 3 + j * 11 + k * 7) % 20) * 0.25 + 0.5) * season
    if revised:
        v = np.where((i == REVISED_CELL[0]) & (j == REVISED_CELL[1]), v + REVISED_DELTA_MM, v)
    return v


def month_days(year: int, month: int) -> list[dt.date]:
    nxt = dt.date(year + (month == 12), month % 12 + 1, 1)
    return [dt.date(year, month, 1) + dt.timedelta(days=d) for d in range((nxt - dt.date(year, month, 1)).days)]


def _dataset(days: list[dt.date], data: np.ndarray, lats: np.ndarray, lons: np.ndarray, units: str, variable: str):
    import xarray as xr

    t = np.array([(d - dt.date(1900, 1, 1)).days for d in days], dtype=np.int64)
    return xr.Dataset(
        {variable: (("time", "lat", "lon"), data[:, ::-1, :], {"units": units, "long_name": "Reference evapotranspiration (FAO-56 Penman-Monteith)"})},
        coords={
            "time": ("time", t, {"units": "days since 1900-01-01", "calendar": "proleptic_gregorian"}),
            "lat": ("lat", lats[::-1]),
            "lon": ("lon", lons),
        },
        attrs={"Conventions": "CF-1.7", "institution": "synthetic fixture (ingest/fixtures/agera5), not Copernicus data"},
    )


def _bytes(ds) -> bytes:
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "d.nc"
        name = next(iter(ds.data_vars))
        ds.to_netcdf(p, engine="h5netcdf", encoding={name: {"zlib": True, "complevel": 4, "_FillValue": np.float32(np.nan)}})
        return p.read_bytes()


def write_month(path, year: int, month: int, *, revised: bool = False, single: bool = False, lattice: str = "centres", values=None, units: str = UNITS, variable: str = VARIABLE, days: list[dt.date] | None = None) -> Path:
    """Write the month's days to `path`. `values(day, i, j)` (mm) replaces value_mm for a test."""
    days = days or month_days(year, month)
    lats, lons = axes(lattice)
    i, j = np.meshgrid(np.arange(lats.size), np.arange(lons.size), indexing="ij")
    fn = values or (lambda d, i, j: value_mm(d, i, j, revised))
    data = np.stack([np.asarray(fn(d, i, j), dtype=np.float64) for d in days]).astype(np.float32)
    data[:, sea(lats, lons)] = np.nan
    path = Path(path)
    if single:
        path.write_bytes(_bytes(_dataset(days, data, lats, lons, units, variable)))
        return path
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        for n, d in enumerate(days):
            name = f"Reference-Evapotranspiration-FAO56_C3S-glob-agric_AgERA5_{d:%Y%m%d}_final-v2.0.nc"
            z.writestr(name, _bytes(_dataset([d], data[n : n + 1], lats, lons, units, variable)))
    path.write_bytes(buf.getvalue())
    return path


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("month", help="YYYY-MM")
    p.add_argument("out")
    p.add_argument("--revised", action="store_true")
    p.add_argument("--single", action="store_true")
    a = p.parse_args()
    y, m = (int(x) for x in a.month.split("-"))
    print(write_month(a.out, y, m, revised=a.revised, single=a.single))


if __name__ == "__main__":
    main()
