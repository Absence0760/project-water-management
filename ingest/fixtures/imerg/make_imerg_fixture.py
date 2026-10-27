"""Write synthetic IMERG Late daily files in IMERG's real layout (issue #604 R4-D).

    ingest/.venv/bin/python ingest/fixtures/imerg/make_imerg_fixture.py [OUTDIR] [YYYY-MM-DD]

Writes one global file, `3B-DAY-L.MS.MRG.3IMERG.<YYYYMMDD>-S000000-E235959.V07C.nc4`,
for the day given (default 2024-10-01). Invented values, nothing real.

The layout is GES DISC's `GPM_3IMERGDL` V07 daily NetCDF-4 (HDF5):

- dimensions `time` (1), `lon` (3600), `lat` (1800); the 0.1 deg grid's
  centres sit on x.x5: lon -179.95 .. 179.95 eastwards, **lat -89.95 ..
  89.95 northwards** (south first);
- `precipitation(time, lon, lat)` float32: **lon before lat**, so a day's
  grid is (lon, lat), the transpose of the copy's (lat, lon). Units
  `mm/day` (V07's daily mean rate; V06 called it `precipitationCal`, in mm),
  `_FillValue` -9999.9;
- `time(time)` int32, `days since 1970-01-01 00:00:00Z`, the day's start.

`imerg_fixture.py` (fixtures mode's fake GES DISC) serves OPeNDAP subsets of
the same arrays from `global_values(day)`, so the job reads exactly what this
script writes for that day. `value(day, lat, lon)` says what one cell holds,
for tests that place a known value at a known coordinate.
"""

from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

import numpy as np

NLON = 3600
NLAT = 1800
STEP = 0.1
LON0 = -179.95
LAT0 = -89.95
FILL = np.float32(-9999.9)
EPOCH = dt.date(1970, 1, 1)
VERSION_TAG = "V07C"
DEFAULT_DAY = dt.date(2024, 10, 1)


def file_name(day: dt.date, tag: str = VERSION_TAG) -> str:
    return f"3B-DAY-L.MS.MRG.3IMERG.{day:%Y%m%d}-S000000-E235959.{tag}.nc4"


def lons() -> np.ndarray:
    return (LON0 + STEP * np.arange(NLON)).astype(np.float32)


def lats() -> np.ndarray:
    return (LAT0 + STEP * np.arange(NLAT)).astype(np.float32)


def lon_index(lon: float) -> int:
    return round((lon - LON0) / STEP)


def lat_index(lat: float) -> int:
    return round((lat - LAT0) / STEP)


def value(day: dt.date, lat: float, lon: float) -> float:
    """The rain (mm/day) the synthetic file holds at a cell centre on `day`,
    NaN where it holds the fill. Multiples of 0.25, so float32 is exact."""
    return float(global_values(day)[lon_index(lon), lat_index(lat)])


_CACHE: dict[dt.date, np.ndarray] = {}


def global_values(day: dt.date) -> np.ndarray:
    """(lon, lat) float32 for `day`, NaN where the file holds the fill.

    A diagonal ramp that differs every day and between every pair of
    neighbouring cells in both directions (so a transposed or flipped read
    can't pass), a block of fill over the south Atlantic inside the region
    (the copy's NaN), and zero (dry) elsewhere in a stripe."""
    if day in _CACHE:
        return _CACHE[day]
    i = np.arange(NLON)[:, None]
    j = np.arange(NLAT)[None, :]
    k = day.toordinal()
    v = (((i * 7 + j * 3 + k * 11) % 400) / 4).astype(np.float32)
    v[(i + j + k) % 9 == 0] = 0.0
    # Fill: lon 10.0–12.0, lat -35.5 to -30.0 (inside region D1's south-west corner, over the sea).
    v[lon_index(10.05) : lon_index(11.95) + 1, lat_index(-35.45) : lat_index(-30.05) + 1] = np.nan
    _CACHE.clear()
    _CACHE[day] = v
    return v


def write(path: Path, day: dt.date, values: np.ndarray | None = None, lon_slice: slice = slice(None), lat_slice: slice = slice(None), units: str = "mm/day", var: str = "precipitation") -> Path:
    """Write IMERG's daily layout for `day` to `path`: the whole globe, or the
    lon/lat index slices OPeNDAP would return. `values` overrides the
    synthetic field ((lon, lat), NaN for the fill); `units` and `var` let
    tests write a layout the reader must refuse."""
    import h5netcdf

    v = global_values(day) if values is None else values
    sub = np.where(np.isnan(v), FILL, v).astype(np.float32)[lon_slice, lat_slice]
    lo, la = lons()[lon_slice], lats()[lat_slice]
    path.parent.mkdir(parents=True, exist_ok=True)
    with h5netcdf.File(path, "w") as f:
        f.attrs["FileHeader"] = "Synthetic IMERG-like fixture (invented values; water-management ingest tests)"
        f.dimensions = {"time": 1, "lon": lo.size, "lat": la.size}
        t = f.create_variable("time", ("time",), "i4")
        t[:] = np.array([(day - EPOCH).days], dtype=np.int32)
        t.attrs["units"] = "days since 1970-01-01 00:00:00Z"
        t.attrs["standard_name"] = "time"
        x = f.create_variable("lon", ("lon",), "f4")
        x[:] = lo
        x.attrs["units"] = "degrees_east"
        y = f.create_variable("lat", ("lat",), "f4")
        y[:] = la
        y.attrs["units"] = "degrees_north"
        p = f.create_variable(var, ("time", "lon", "lat"), "f4", fillvalue=FILL, compression="gzip", compression_opts=4)
        p[0, :, :] = sub
        p.attrs["units"] = units
        p.attrs["long_name"] = "Daily mean precipitation rate (combined microwave-IR) estimate"
    return path


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent / "out"
    day = dt.date.fromisoformat(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_DAY
    print(write(out / file_name(day), day))
