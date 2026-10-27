"""AgERA5's CDS request: the dataset, the request for a month and the month a request names.

Shared by agera5.py (the job) and fakecds.py (fixtures mode's stand-in
CDS), so the fake can check a request against the real one without
importing the job that imports it (era5request.py does the same for
ERA5-Land). agera5 re-exports every name here.
"""

from __future__ import annotations

import datetime as dt

import grid
from cdsjob import month_end

PRODUCT = "agera5_et0"
DATASET = "sis-agrometeorological-indicators"
VARIABLE = "reference_evapotranspiration"
VERSION = "2_0"


def month_days(ym) -> list[dt.date]:
    return [dt.date(*ym, d) for d in range(1, month_end(ym).day + 1)]


def month_request(ym) -> dict:
    """The CDS request for month `ym`: every day, region D1, version 2.0."""
    return {
        "variable": VARIABLE,
        "year": [f"{ym[0]:04d}"],
        "month": [f"{ym[1]:02d}"],
        "day": [f"{d.day:02d}" for d in month_days(ym)],
        "version": VERSION,
        "area": [grid.REGION["n"], grid.REGION["w"], grid.REGION["s"], grid.REGION["e"]],
    }


def request_month(req: dict) -> tuple[int, int] | None:
    """The month a CDS request (ours, as the CDS echoes it back) asks for, or None if it isn't one of ours."""

    def one(v):
        return v[0] if isinstance(v, list) and len(v) == 1 else v

    try:
        if str(one(req.get("variable"))) != VARIABLE or str(one(req.get("version"))) != VERSION:
            return None
        return int(one(req["year"])), int(one(req["month"]))
    except (KeyError, TypeError, ValueError):
        return None
