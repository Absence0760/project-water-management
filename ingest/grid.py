"""The copy's region and grid (issue #604 D1), shared by every product.

The region is 10-41 deg E, 35.5-8 deg S on CHC's 0.05 deg grid: 550 rows x
620 columns. Index [0, 0] is the south-west cell (centre lat -35.475, lon
10.025); the row index grows northwards (CHC's NetCDF order) and the column
index eastwards. Indices always come from the origin and the step, never from
matching coordinate values: CHC stores coordinates as float32 (10.024994).

The module's constants are CHC's 0.05 deg grid. Each product's own grid (issue
#604 R4-B) comes from `for_product`: the same region at 0.05 deg for the
CHIRPS products and 0.1 deg for `era5l`, `imerg_late`, `agera5_et0` and
`power_et0` (275 rows x 310
columns, [0, 0] centred at lat -35.45, lon 10.05), with its daily chunk (25
chunks a day at either step) and its finals' first year. The third grid,
`C3S` (issue #620), is C3S's seasonal 1 deg grid: cell centres on whole
degrees over D1 snapped outward (29 rows x 32 columns, [0, 0] centred at
lat -36, lon 10), so its box (`SEASONAL_REGION`) is wider than D1. It mirrors
backend/src/mirror/grid.ts PRODUCT_GRIDS, so the writers and the Node reader
agree on one definition.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import math
import re

REGION = {"w": 10.0, "s": -35.5, "e": 41.0, "n": -8.0}
STEP = 0.05
ORIGIN = {"lat": -35.475, "lon": 10.025}
ROWS = 550
COLS = 620

# The finals layout's first year (D2): year index = year - FIRST_YEAR.
FIRST_YEAR = 1981
DOYS = 366


@dataclasses.dataclass(frozen=True)
class Grid:
    """One product's grid over REGION: its step, south-west cell centre, size and chunks."""

    step: float
    origin: dict
    rows: int
    cols: int
    daily_chunks: tuple[int, int, int]
    finals_chunks: tuple[int, int, int, int]
    first_year: int
    #: The box the grid's cells tile: D1 for every grid but the seasonal one (SEASONAL_REGION).
    region: dict = dataclasses.field(default_factory=lambda: dict(REGION))

    @property
    def attrs(self) -> dict:
        """The `region` and `grid` attributes every array of this grid carries (and its manifest)."""
        return {"region": dict(self.region), "grid": {"origin": dict(self.origin), "step": self.step}}

    def row_index(self, lat: float) -> int:
        i = round((lat - self.origin["lat"]) / self.step)
        if not 0 <= i < self.rows:
            raise ValueError(f"latitude {lat} is outside the region {self.region}")
        return i

    def col_index(self, lon: float) -> int:
        j = round((lon - self.origin["lon"]) / self.step)
        if not 0 <= j < self.cols:
            raise ValueError(f"longitude {lon} is outside the region {self.region}")
        return j


def _grid(step: float, daily_chunks: tuple[int, int, int], first_year: int = FIRST_YEAR) -> Grid:
    return Grid(
        step=step,
        origin={"lat": round(REGION["s"] + step / 2, 9), "lon": round(REGION["w"] + step / 2, 9)},
        rows=round((REGION["n"] - REGION["s"]) / step),
        cols=round((REGION["e"] - REGION["w"]) / step),
        daily_chunks=daily_chunks,
        finals_chunks=(1, DOYS, 20, 20),
        first_year=first_year,
    )


#: CHC's 0.05 deg grid (the module's constants), and the 0.1 deg grid of ERA5-Land and IMERG.
CHC = _grid(STEP, (1, 110, 124))
TENTH = _grid(0.1, (1, 55, 62))
ERA5L = dataclasses.replace(TENTH, first_year=1950)
#: AgERA5's daily reference ET (R5-E), finals from 1979; NASA POWER's computed ET0 (`power_et0`) is daily on TENTH.
AGERA5 = dataclasses.replace(TENTH, first_year=1979)



def seasonal_region(region: dict = REGION, step: float = 1.0) -> dict:
    """The box of the seasonal grid (issue #620): `region`'s bounds snapped
    outward to whole multiples of `step`, which are the cells' **centres**
    (C3S's 1 deg points sit on whole degrees), so the box the cells tile is
    half a cell wider each way. D1 (10-41 E, 35.5-8 S) gives centres 36-8 S,
    10-41 E: 29 rows x 32 columns, the box 9.5-41.5 E, 36.5-7.5 S."""
    s = math.floor(region["s"] / step) * step
    n = math.ceil(region["n"] / step) * step
    w = math.floor(region["w"] / step) * step
    e = math.ceil(region["e"] / step) * step
    h = step / 2
    return {"w": round(w - h, 9), "s": round(s - h, 9), "e": round(e + h, 9), "n": round(n + h, 9)}


SEASONAL_REGION = seasonal_region()


def _seasonal_grid(step: float = 1.0) -> Grid:
    r = SEASONAL_REGION
    rows = round((r["n"] - r["s"]) / step)
    cols = round((r["e"] - r["w"]) / step)
    return Grid(
        step=step,
        origin={"lat": round(r["s"] + step / 2, 9), "lon": round(r["w"] + step / 2, 9)},
        rows=rows,
        cols=cols,
        daily_chunks=(1, rows, cols),
        finals_chunks=(1, DOYS, rows, cols),
        first_year=1993,
        region=dict(r),
    )


#: The third grid (issue #620): C3S's seasonal forecasts and hindcasts (`c3s/<init>`, `c3s-hc/<system>/<MM>`)
#: on 1 deg cells centred on whole degrees over D1 snapped outward ([0, 0] centred at 36 S, 10 E).
C3S = _seasonal_grid()
_C3S_PRODUCT = re.compile(r"^(c3s/\d{4}-(0[1-9]|1[0-2])|c3s-hc/[a-z_]+-\d+/(0[1-9]|1[0-2]))$")

#: Each product's grid; a forecast issue (`gefs/<issue>`, `ecmwf/<issue>`) by its prefix.
PRODUCT_GRIDS = {"rnl": CHC, "sat": CHC, "prelim": CHC, "era5l": ERA5L, "imerg_late": TENTH, "agera5_et0": AGERA5, "power_et0": TENTH}
_FORECAST_GRIDS = {"gefs": CHC, "ecmwf": TENTH}


def for_product(product: str) -> Grid:
    """The grid `product` (a store path) is held on; ValueError for one the copy doesn't hold."""
    if product in PRODUCT_GRIDS:
        return PRODUCT_GRIDS[product]
    if _C3S_PRODUCT.match(product):
        return C3S
    head, _, issue = product.partition("/")
    if head in _FORECAST_GRIDS and len(issue) == 10:
        dt.date.fromisoformat(issue)
        return _FORECAST_GRIDS[head]
    raise ValueError(f"the copy holds no product {product!r}")


def row_index(lat: float) -> int:
    """The row of the cell whose centre is nearest `lat`, inside the region."""
    i = round((lat - ORIGIN["lat"]) / STEP)
    if not 0 <= i < ROWS:
        raise ValueError(f"latitude {lat} is outside the region {REGION}")
    return i


def col_index(lon: float) -> int:
    """The column of the cell whose centre is nearest `lon`, inside the region."""
    j = round((lon - ORIGIN["lon"]) / STEP)
    if not 0 <= j < COLS:
        raise ValueError(f"longitude {lon} is outside the region {REGION}")
    return j


def doy_index(day: dt.date) -> int:
    """Days since 1 January of the day's year: 0..365 (365 only in a leap year)."""
    return (day - dt.date(day.year, 1, 1)).days


def year_index(year: int, first_year: int = FIRST_YEAR) -> int:
    if year < first_year:
        raise ValueError(f"{year} is before the array's first year {first_year}")
    return year - first_year
