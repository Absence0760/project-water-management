"""A stand-in for NASA POWER's daily regional API (issue #604 R5-E), so
FEED_SOURCE=fixtures runs nasapower.py's live code with no network. Not
shipped in the Lambda image.

`FakePower` has the opener signature polite.PoliteClient expects
(`opener(request, timeout=…)`) and answers
`GET https://power.larc.nasa.gov/api/temporal/daily/regional?parameters=P&…`
in POWER's JSON shape: a FeatureCollection with one Point feature per 0.5 deg
grid point inside the asked box (`geometry.coordinates` [lon, lat, elevation]),
`properties.parameter.P.{YYYYMMDD: value}` for each day of the window, a
`header.fill_value` of -999, and `parameters.P.units`. Days after `latest`
are the fill value, as POWER answers a day it doesn't have yet.

The synthetic meteorology (`value()`) is a smooth, plausible field: summer
heat and sun, a dew point a few degrees under Tmin, light wind, ~95 kPa. The
points sit on x.25/x.75 deg (an invented lattice; the job places them by the
coordinates it reads, whatever they are). `refuse` (a status) plays a refusal;
`values(parameter, day, lat, lon)` overrides a value; `fill` is a set of
(parameter, day, lat, lon) to answer with the fill value. `requests` records
every URL.
"""

from __future__ import annotations

import datetime as dt
import email.message
import io
import json
import math
import urllib.error
import urllib.parse

BASE = "https://power.larc.nasa.gov/api/temporal/daily/regional"
FILL = -999.0
SPACING = 0.5
OFFSET = 0.25
UNITS = {"T2M_MAX": "C", "T2M_MIN": "C", "T2MDEW": "C", "WS2M": "m/s", "ALLSKY_SFC_SW_DWN": "MJ/m^2/day", "PS": "kPa"}


class _Response(io.BytesIO):
    def __init__(self, body: bytes, status: int, url: str):
        super().__init__(body)
        self.status = status
        self.headers = email.message.Message()
        self.headers["Content-Type"] = "application/json"
        self.url = url

    def geturl(self):
        return self.url


def value(parameter: str, day: dt.date, lat: float, lon: float) -> float:
    """The synthetic daily value of a parameter at a point."""
    season = math.cos(2 * math.pi * (day.timetuple().tm_yday - 15) / 365.0)  # +1 mid-January (southern summer)
    tmax = 24.0 + 7.0 * season + 0.1 * (lon - 25.0) - 0.2 * (lat + 25.0)
    tmin = tmax - 12.0
    return round(
        {
            "T2M_MAX": tmax,
            "T2M_MIN": tmin,
            "T2MDEW": tmin - 3.0,
            "WS2M": 2.0 + 0.5 * math.sin(lon),
            "ALLSKY_SFC_SW_DWN": 20.0 + 8.0 * season,
            "PS": 95.0 + 0.1 * math.cos(lat),
        }[parameter],
        2,
    )


def points(s: float, n: float, w: float, e: float) -> list[tuple[float, float]]:
    """The fake lattice's points inside [s, n] x [w, e] (edges included)."""
    def axis(lo, hi):
        k = math.ceil((lo - OFFSET) / SPACING - 1e-9)
        out = []
        while (x := OFFSET + k * SPACING) <= hi + 1e-9:
            out.append(round(x, 4))
            k += 1
        return out

    return [(la, lo) for la in axis(s, n) for lo in axis(w, e)]


class FakePower:
    def __init__(self, latest: dt.date | None = None, refuse: int | None = None, values=None, fill=None, units=None):
        self.latest = latest or (dt.datetime.now(dt.UTC).date() - dt.timedelta(days=3))
        self.refuse = refuse
        self.values = values
        self.fill = set(fill or ())
        self.units = {**UNITS, **(units or {})}
        self.requests: list[str] = []

    def __call__(self, req, timeout=None):
        url = req.full_url
        self.requests.append(url)
        if self.refuse:
            raise urllib.error.HTTPError(url, self.refuse, "Refused", email.message.Message(), None)
        u = urllib.parse.urlparse(url)
        if f"{u.scheme}://{u.netloc}{u.path}" != BASE:
            raise urllib.error.HTTPError(url, 404, "Not Found", email.message.Message(), None)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        p = q["parameters"]
        if "," in p or p not in UNITS or q.get("community") != "AG" or q.get("format") != "JSON":
            raise urllib.error.HTTPError(url, 422, "Unprocessable", email.message.Message(), None)
        start = dt.datetime.strptime(q["start"], "%Y%m%d").date()
        end = dt.datetime.strptime(q["end"], "%Y%m%d").date()
        days = [start + dt.timedelta(days=k) for k in range((end - start).days + 1)]
        feats = []
        for la, lo in points(float(q["latitude-min"]), float(q["latitude-max"]), float(q["longitude-min"]), float(q["longitude-max"])):
            series = {}
            for d in days:
                if d > self.latest or (p, d, la, lo) in self.fill:
                    series[f"{d:%Y%m%d}"] = FILL
                else:
                    series[f"{d:%Y%m%d}"] = self.values(p, d, la, lo) if self.values else value(p, d, la, lo)
            feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lo, la, 350.0]}, "properties": {"parameter": {p: series}}})
        body = {
            "type": "FeatureCollection",
            "features": feats,
            "header": {"title": "NASA/POWER synthetic fixture (ingest/power_fixture.py), not NASA data", "fill_value": FILL, "start": q["start"], "end": q["end"]},
            "parameters": {p: {"units": self.units[p], "longname": p}},
        }
        return _Response(json.dumps(body).encode(), 200, url)
