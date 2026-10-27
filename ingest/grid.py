"""The copy's region and grid (issue #604 D1), shared by every product.

The region is 10-41 deg E, 35.5-8 deg S on CHC's 0.05 deg grid: 550 rows x
620 columns. Index [0, 0] is the south-west cell (centre lat -35.475, lon
10.025); the row index grows northwards (CHC's NetCDF order) and the column
index eastwards. Indices always come from the origin and the step, never from
matching coordinate values: CHC stores coordinates as float32 (10.024994).
"""

from __future__ import annotations

import datetime as dt

REGION = {"w": 10.0, "s": -35.5, "e": 41.0, "n": -8.0}
STEP = 0.05
ORIGIN = {"lat": -35.475, "lon": 10.025}
ROWS = 550
COLS = 620

# The finals layout's first year (D2): year index = year - FIRST_YEAR.
FIRST_YEAR = 1981
DOYS = 366


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
