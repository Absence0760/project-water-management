"""C3S seasonal forecasts' CDS requests (issue #620): the dataset, the systems,
the request for one system's init (or hindcast month) and the key a request
names.

Shared by c3s_seasonal.py (the job) and fakecds.py (fixtures mode's stand-in
CDS), so the fake can check a request against the real one without
importing the job that imports it, as era5request.py is for ERA5-Land.

A request is named by its **key**, a tuple:

    ("fc", "<centre>-<system>", "YYYY-MM")   one system's forecast from one init month
    ("hc", "<centre>-<system>", "MM")        one system's hindcast for one init calendar month,
                                             every year of HINDCAST_YEARS in one request

and written `fc/ecmwf-51/2026-10`, `hc/ecmwf-51/10` in the request state.
"""

from __future__ import annotations

import datetime as dt
import re

import grid

DATASET = "seasonal-original-single-levels"
VARIABLE = "total_precipitation"
PRODUCT = "c3s"
HC_PRODUCT = "c3s-hc"

#: Leads up to 215 days: C3S's daily accumulated precipitation runs to 5160 h (24 h to 5160 h, a step a day).
LEAD_DAYS = 215
LEAD_HOURS = tuple(24 * (d + 1) for d in range(LEAD_DAYS))
#: The common hindcast period of the C3S multi-system (1993-2016); a system holding fewer years answers with what it has.
HINDCAST_YEARS = tuple(range(1993, 2017))

#: The contributing systems, `<centre>-<system>` -> the CDS's originating_centre and system. C3S changes a centre's
#: system from time to time (the Met Office's yearly): update this table when C3S's documentation announces one, and
#: the CDS's refusal of a retired system (a failed request, then RequestsFailed) says when it was missed.
SYSTEMS = {
    "ecmwf-51": ("ecmwf", "51"),
    "ukmo-604": ("ukmo", "604"),
    "meteo_france-9": ("meteo_france", "9"),
    "dwd-22": ("dwd", "22"),
    "cmcc-35": ("cmcc", "35"),
    "ncep-2": ("ncep", "2"),
    "jma-3": ("jma", "3"),
    "eccc-4": ("eccc", "4"),
    "eccc-5": ("eccc", "5"),
}

#: Each originating centre's name, as the credit names it (the engine's liability/rainCredits.ts C3S_CENTRES says the same).
CENTRE_NAMES = {
    "ecmwf": "European Centre for Medium-Range Weather Forecasts (ECMWF)",
    "ukmo": "Met Office",
    "meteo_france": "Météo-France",
    "dwd": "Deutscher Wetterdienst (DWD)",
    "cmcc": "Euro-Mediterranean Center on Climate Change (CMCC)",
    "ncep": "NOAA National Centers for Environmental Prediction (NCEP)",
    "jma": "Japan Meteorological Agency (JMA)",
    "eccc": "Environment and Climate Change Canada (ECCC)",
}

#: The day of the init month each centre's forecast is released on the CDS, at RELEASE_HOUR_UTC:
#: the 6th for ECMWF, the 10th for the others (the dataset page, read 2026-10-28).
RELEASE_DAY = {"ecmwf": 6}
RELEASE_DAY_OTHERS = 10
RELEASE_HOUR_UTC = 12

#: The area (N, W, S, E) of the 1 deg grid's cell centres (grid.C3S): D1 snapped outward to whole degrees.
AREA = [
    round(grid.C3S.origin["lat"] + (grid.C3S.rows - 1) * grid.C3S.step, 6),
    grid.C3S.origin["lon"],
    grid.C3S.origin["lat"],
    round(grid.C3S.origin["lon"] + (grid.C3S.cols - 1) * grid.C3S.step, 6),
]

_SYSTEM = re.compile(r"^[a-z_]+-\d+$")
_INIT = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")
_MM = re.compile(r"^(0[1-9]|1[0-2])$")


def centre_of(system: str) -> str:
    return system.rsplit("-", 1)[0]


def release_at(system: str, init: str) -> dt.datetime:
    """When `system`'s forecast from `init` (YYYY-MM) is on the CDS (UTC)."""
    y, m = int(init[:4]), int(init[5:])
    return dt.datetime(y, m, RELEASE_DAY.get(centre_of(system), RELEASE_DAY_OTHERS), RELEASE_HOUR_UTC, tzinfo=dt.UTC)


def key_str(key: tuple) -> str:
    return "/".join(key)


def parse_key(s: str) -> tuple | None:
    parts = tuple(s.split("/"))
    return parts if valid_key(parts) else None


def valid_key(key) -> bool:
    if not (isinstance(key, tuple) and len(key) == 3 and key[0] in ("fc", "hc") and isinstance(key[1], str) and _SYSTEM.match(key[1])):
        return False
    return bool((_INIT if key[0] == "fc" else _MM).match(key[2] if isinstance(key[2], str) else ""))


def request(key: tuple) -> dict:
    """The CDS request for `key`: one system, total precipitation, every member, every lead to 5160 h, area D1, GRIB."""
    if not valid_key(key):
        raise ValueError(f"not a C3S request key: {key!r}")
    kind, system, when = key
    centre, number = SYSTEMS.get(system) or (centre_of(system), system.rsplit("-", 1)[1])
    if kind == "fc":
        years, month = [when[:4]], when[5:]
    else:
        years, month = [str(y) for y in HINDCAST_YEARS], when
    return {
        "originating_centre": centre,
        "system": number,
        "variable": [VARIABLE],
        "year": years,
        "month": [month],
        "day": ["01"],
        "leadtime_hour": [str(h) for h in LEAD_HOURS],
        "data_format": "grib",
        "area": list(AREA),
    }


def request_key(req: dict) -> tuple | None:
    """The key a CDS request (ours, as the CDS echoes it back) names, or None if it isn't one of ours."""

    def as_list(v):
        return [str(x) for x in (v if isinstance(v, list) else [v])]

    try:
        if as_list(req.get("variable")) != [VARIABLE]:
            return None
        if as_list(req.get("leadtime_hour")) != [str(h) for h in LEAD_HOURS]:
            return None
        system = f"{req['originating_centre']}-{as_list(req['system'])[0]}"
        months = as_list(req["month"])
        years = as_list(req["year"])
        if len(months) != 1:
            return None
        month = f"{int(months[0]):02d}"
        if years == [str(y) for y in HINDCAST_YEARS]:
            key = ("hc", system, month)
        elif len(years) == 1 and int(years[0]) > HINDCAST_YEARS[-1]:
            key = ("fc", system, f"{int(years[0]):04d}-{month}")
        else:
            return None
        return key if valid_key(key) else None
    except (KeyError, TypeError, ValueError, IndexError):
        return None
