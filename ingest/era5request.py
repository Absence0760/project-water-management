"""ERA5-Land's CDS request: the dataset, the request for a month and the month a request names.

Shared by era5land.py (the job) and fakecds.py (fixtures mode's stand-in
CDS), so the fake can check a request against the real one without
importing the job that imports it. era5land re-exports every name here.
"""

from __future__ import annotations

import datetime as dt

import grid
from cdsjob import CDS_URL, CdsError  # noqa: F401  (one CdsError for every CDS product; cdsjob imports no job module)

DATASET = "reanalysis-era5-land"
VARIABLE = "total_precipitation"
#: The product this request module serves (fakecds names it in a refusal).
PRODUCT = "era5l"

#: Re-request a preliminary (or unknown) month this long after its end (the consolidated data are ~2 months behind);
#: era5land.RECHECK_EVERY_DAYS says how often after that.
RECHECK_AFTER_DAYS = 75


def month_str(ym: tuple[int, int]) -> str:
    return f"{ym[0]:04d}-{ym[1]:02d}"


def next_month(ym):
    y, m = ym
    return (y + 1, 1) if m == 12 else (y, m + 1)


def month_end(ym) -> dt.date:
    return dt.date(*next_month(ym), 1) - dt.timedelta(days=1)


def month_request(ym) -> dict:
    """The CDS request for month `ym`: every day's 00 UTC step, region D1, one unarchived NetCDF."""
    days = month_end(ym).day
    return {
        "variable": [VARIABLE],
        "year": f"{ym[0]:04d}",
        "month": f"{ym[1]:02d}",
        "day": [f"{d:02d}" for d in range(1, days + 1)],
        "time": ["00:00"],
        "data_format": "netcdf",
        "download_format": "unarchived",
        "area": [grid.REGION["n"], grid.REGION["w"], grid.REGION["s"], grid.REGION["e"]],
    }


def request_month(req: dict) -> tuple[int, int] | None:
    """The month a CDS request (ours, as the CDS echoes it back) asks for, or None if it isn't one of ours."""

    def one(v):
        return v[0] if isinstance(v, list) and len(v) == 1 else v

    try:
        if [str(v) for v in (req.get("variable") if isinstance(req.get("variable"), list) else [req.get("variable")])] != [VARIABLE]:
            return None
        if [str(t) for t in (req.get("time") if isinstance(req.get("time"), list) else [req.get("time")])] not in (["00:00"], ["00"]):
            return None
        return int(one(req["year"])), int(one(req["month"]))
    except (KeyError, TypeError, ValueError):
        return None
