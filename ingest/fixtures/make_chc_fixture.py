"""Write the synthetic CHC NetCDF fixture the ingest job's fixtures mode reads.

    ingest/.venv/bin/python ingest/fixtures/make_chc_fixture.py [OUTDIR]

Invented values in CHC's real `byMonth` layout (Round 0 spike,
docs/spikes/604-round0.md): NetCDF-4/HDF5, `precip(time, latitude,
longitude)` float32 with `_FillValue` = `missing_value` = -9999 and no
packing, latitude ascending (south to north), float32 coordinates, and
`time` as float32 "days since 1980-1-1", gzip 5. It covers the region (D1)
plus a 10-cell margin on every side, not the globe, and only the last three
days of February 2024 (a leap year, so the 29th lands on doy index 59).

Land is two invented rectangles plus the region's south-west corner cell; the
rest is sea (-9999). `value()` says what each land cell-day holds, so tests
can check placement without reading the file twice. No client or real data.
"""

from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import grid  # noqa: E402

MARGIN = 10
LAT0 = grid.ORIGIN["lat"] - MARGIN * grid.STEP
LON0 = grid.ORIGIN["lon"] - MARGIN * grid.STEP
NLAT = grid.ROWS + 2 * MARGIN
NLON = grid.COLS + 2 * MARGIN
FIRST_DAY = dt.date(2024, 2, 27)
DAYS = 3
NAME = "chirps-v3.0.2024.02.days_p05.nc"
EPOCH = dt.date(1980, 1, 1)


def is_land(row: int, col: int) -> bool:
    """Region row/col (south-west origin)."""
    return (row, col) == (0, 0) or (40 <= row < 140 and 300 <= col < 420) or (400 <= row < 450 and 20 <= col < 90)


def value(day: int, row: int, col: int) -> float:
    """The rain (mm) at a region cell on fixture day `day` (0-based), NaN for sea.
    Multiples of 0.5, so float32 holds them exactly; about a fifth are 0."""
    if not is_land(row, col):
        return float("nan")
    return ((row * 7 + col * 13 + day * 31) % 50) / 2


def region_values() -> np.ndarray:
    rows, cols = np.meshgrid(np.arange(grid.ROWS), np.arange(grid.COLS), indexing="ij")
    land = np.zeros((grid.ROWS, grid.COLS), dtype=bool)
    land[0, 0] = True
    land[40:140, 300:420] = True
    land[400:450, 20:90] = True
    out = np.full((DAYS, grid.ROWS, grid.COLS), np.nan, dtype=np.float32)
    for d in range(DAYS):
        v = (((rows * 7 + cols * 13 + d * 31) % 50) / 2).astype(np.float32)
        out[d][land] = v[land]
    return out


def write(outdir: Path) -> Path:
    import h5netcdf

    outdir.mkdir(parents=True, exist_ok=True)
    path = outdir / NAME
    full = np.full((DAYS, NLAT, NLON), -9999, dtype=np.float32)
    region = region_values()
    full[:, MARGIN : MARGIN + grid.ROWS, MARGIN : MARGIN + grid.COLS] = np.where(np.isnan(region), np.float32(-9999), region)
    with h5netcdf.File(path, "w") as f:
        f.attrs["Conventions"] = "CF-1.6"
        f.attrs["title"] = "Synthetic CHIRPS-like fixture (invented values; water-management ingest tests)"
        f.dimensions = {"time": DAYS, "latitude": NLAT, "longitude": NLON}
        t = f.create_variable("time", ("time",), "f4")
        t[:] = np.array([(FIRST_DAY - EPOCH).days + i for i in range(DAYS)], dtype=np.float32)
        t.attrs["units"] = "days since 1980-1-1"
        t.attrs["calendar"] = "gregorian"
        lat = f.create_variable("latitude", ("latitude",), "f4")
        lat[:] = (LAT0 + np.arange(NLAT) * grid.STEP).astype(np.float32)
        lat.attrs["units"] = "degrees_north"
        lon = f.create_variable("longitude", ("longitude",), "f4")
        lon[:] = (LON0 + np.arange(NLON) * grid.STEP).astype(np.float32)
        lon.attrs["units"] = "degrees_east"
        p = f.create_variable(
            "precip",
            ("time", "latitude", "longitude"),
            "f4",
            fillvalue=np.float32(-9999),
            compression="gzip",
            compression_opts=5,
            chunks=(DAYS, 190, 320),
        )
        p[:] = full
        p.attrs["missing_value"] = np.float32(-9999)
        p.attrs["units"] = "mm/day"
        p.attrs["long_name"] = "Climate Hazards group InfraRed Precipitation (synthetic)"
    return path


if __name__ == "__main__":
    print(write(Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent / "chc"))
