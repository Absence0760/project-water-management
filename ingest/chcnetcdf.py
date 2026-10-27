"""Read one CHC CHIRPS v3 NetCDF file and cut out the region (issue #604 D4).

CHC's `byMonth` files (Round 0 spike, docs/spikes/604-round0.md): NetCDF-4 /
HDF5, `precip(time, latitude, longitude)` float32 with `_FillValue` =
`missing_value` = -9999 and no `scale_factor`/`add_offset`; latitude runs
south to north; coordinates are float32; `time` is float32 "days since
1980-1-1". This reader holds to exactly that layout and refuses anything else
(packed values, north-up latitude, another grid step), since a silent
misread would put rain in the wrong cell.

Read with h5netcdf through xarray, decoding nothing itself: no netCDF4, no
GDAL.

Every value left after the fill becomes NaN must lie within 0–2000 mm, the
bounds the Node reader holds a day's rain to (backend/src/feeds/sources/
chirps.ts, backend/src/mirror/readCells.ts). A value outside them fails the
read with ImplausibleValueError, so the run stops and alarms before anything
is written: copied in, it would fail every feed over that cell for good.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass

import numpy as np

import grid

#: The plausible range of one day's rain in mm, as the Node reader checks it.
PLAUSIBLE_MIN_MM = 0.0
PLAUSIBLE_MAX_MM = 2000.0

_UNITS = re.compile(r"^\s*days since (\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]0{1,2}:0{1,2}(?::0{1,2}(?:\.0+)?)?)?\s*$")


@dataclass
class RegionSlice:
    """The region's values for consecutive days: values[day, row, col]."""

    first_day: dt.date
    values: np.ndarray  # float32, (days, grid.ROWS, grid.COLS), NaN where CHC has no data

    @property
    def days(self) -> list[dt.date]:
        return [self.first_day + dt.timedelta(days=i) for i in range(self.values.shape[0])]


class ImplausibleValueError(ValueError):
    """A value outside PLAUSIBLE_MIN_MM–PLAUSIBLE_MAX_MM that isn't the fill."""


def check_plausible(values: np.ndarray, first_day: dt.date, source: str = "the file") -> None:
    """Raise ImplausibleValueError naming the first non-NaN value outside 0–2000 mm."""
    bad = ~np.isnan(values) & ((values < PLAUSIBLE_MIN_MM) | (values > PLAUSIBLE_MAX_MM))
    if bad.any():
        d, row, col = (int(i) for i in np.argwhere(bad)[0])
        lat = grid.ORIGIN["lat"] + row * grid.STEP
        lon = grid.ORIGIN["lon"] + col * grid.STEP
        raise ImplausibleValueError(
            f"{source} has {int(bad.sum())} implausible value(s) outside {PLAUSIBLE_MIN_MM:g}–{PLAUSIBLE_MAX_MM:g} mm, "
            f"the first {float(values[d, row, col])} mm on {first_day + dt.timedelta(days=d)} at {lat:.3f}, {lon:.3f} (region row {row}, col {col})"
        )


def time_origin(units: str) -> dt.date:
    m = _UNITS.match(units)
    if not m:
        raise ValueError(f'time units "{units}" are not "days since YYYY-M-D"')
    return dt.date(int(m[1]), int(m[2]), int(m[3]))


def _offset(coords: np.ndarray, origin: float, count: int, name: str) -> int:
    """Where the region's first cell sits in a CHC coordinate axis."""
    c = np.asarray(coords, dtype=np.float64)
    if c.size < 2:
        raise ValueError(f"{name} has fewer than two values")
    steps = np.diff(c)
    if not np.allclose(steps, grid.STEP, atol=1e-4):
        raise ValueError(f"{name} is not ascending in {grid.STEP} deg steps")
    i0 = round((origin - c[0]) / grid.STEP)
    if i0 < 0 or i0 + count > c.size:
        raise ValueError(f"{name} ({c[0]:.3f}..{c[-1]:.3f}) does not cover the region")
    if abs(c[i0] - origin) > grid.STEP / 4:
        raise ValueError(f"{name} cell centres are off CHC's grid (found {c[i0]}, expected {origin})")
    return i0


def read_region(path: str) -> RegionSlice:
    """The region's daily values from one CHC NetCDF file."""
    import xarray as xr

    with xr.open_dataset(path, engine="h5netcdf", decode_times=False, mask_and_scale=False) as ds:
        precip = ds["precip"]
        if precip.dims != ("time", "latitude", "longitude"):
            raise ValueError(f"precip dims are {precip.dims}, expected (time, latitude, longitude)")
        if precip.dtype != np.float32:
            raise ValueError(f"precip is {precip.dtype}, expected float32")
        for packed in ("scale_factor", "add_offset"):
            if packed in precip.attrs or packed in precip.encoding:
                raise ValueError(f"precip carries {packed}; the copy expects unpacked float32")
        fills = {float(v) for k in ("_FillValue", "missing_value") for v in [precip.attrs.get(k, precip.encoding.get(k))] if v is not None}

        origin = time_origin(ds["time"].attrs["units"])
        t = np.asarray(ds["time"].values, dtype=np.float64)
        if t.size == 0:
            raise ValueError("the file has no days")
        if not np.allclose(t, np.round(t)) or not np.all(np.diff(t) == 1):
            raise ValueError("time is not consecutive whole days")
        first_day = origin + dt.timedelta(days=int(round(t[0])))

        i0 = _offset(ds["latitude"].values, grid.ORIGIN["lat"], grid.ROWS, "latitude")
        j0 = _offset(ds["longitude"].values, grid.ORIGIN["lon"], grid.COLS, "longitude")
        values = np.array(precip[:, i0 : i0 + grid.ROWS, j0 : j0 + grid.COLS].values, dtype=np.float32)

    for fill in fills | {-9999.0}:
        values[values == np.float32(fill)] = np.nan
    check_plausible(values, first_day, path)
    return RegionSlice(first_day=first_day, values=values)
