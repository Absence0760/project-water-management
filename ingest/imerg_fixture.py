"""A stand-in for NASA's CMR search and GES DISC's OPeNDAP service (issue #604
R4-D), so FEED_SOURCE=fixtures runs imerg.py's live code with no network and
no Earthdata token. Not shipped in the Lambda image.

`FakeEarthdata` has the opener signature polite.PoliteClient expects
(`opener(request, timeout=…)`) and answers:

- **CMR** `GET https://cmr.earthdata.nasa.gov/search/granules.umm_json?…`
  with `short_name=GPM_3IMERGDL`, `version[]=07` (and `08`) and
  `temporal=<start>,<end>`: one UMM-G item per day in the window up to
  `latest` (yesterday by default, as IMERG Late is ~14 h behind), V07 for
  every day and V08 from `v08_from` on (when set), shaped like CMR's
  (GranuleUR, TemporalExtent, RelatedUrls with the OPeNDAP link);
- **OPeNDAP** `GET https://opendap.earthdata.nasa.gov/collections/…/granules/<GranuleUR>.dap.nc4?dap4.ce=…`:
  the constraint's index ranges cut out of fixtures/imerg's synthetic global
  field for that day, written as NetCDF-4 in IMERG's real layout
  (make_imerg_fixture.write), so the job's subsetting and reading run for
  real.

`refuse` maps a host to a status (403, 401) to play a refusal; `token`, when
set, makes OPeNDAP answer 401 to a request without `Authorization: Bearer
<token>`. `requests` records (url, headers) for every call.
"""

from __future__ import annotations

import datetime as dt
import email.message
import io
import json
import re
import sys
import tempfile
import urllib.error
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures" / "imerg"))

import make_imerg_fixture as fx  # noqa: E402

CMR = "https://cmr.earthdata.nasa.gov/search/granules.umm_json"
OPENDAP = "https://opendap.earthdata.nasa.gov/collections/"
_COLLECTION = {"07": "C2723754859-GES_DISC", "08": "C9999999999-GES_DISC"}
_TAG = {"07": "V07C", "08": "V08A"}
_CE = re.compile(r"^/precipitation\[(\d+):1:(\d+)\]\[(\d+):1:(\d+)\]\[(\d+):1:(\d+)\]")
_GRANULE = re.compile(r"/granules/GPM_3IMERGDL\.(\d{2}):3B-DAY-L\.MS\.MRG\.3IMERG\.(\d{8})-S000000-E235959\.(V\d{2}[A-Z])\.nc4\.dap\.nc4$")


class _Response(io.BytesIO):
    def __init__(self, body: bytes, status: int, headers: email.message.Message, url: str):
        super().__init__(body)
        self.status = status
        self.headers = headers
        self.url = url

    def geturl(self):
        return self.url


def _headers(pairs: dict) -> email.message.Message:
    h = email.message.Message()
    for k, v in pairs.items():
        h[k] = v
    return h


def granule_ur(day: dt.date, version: str) -> str:
    return f"GPM_3IMERGDL.{version}:{fx.file_name(day, _TAG[version])}"


def opendap_url(day: dt.date, version: str) -> str:
    return f"{OPENDAP}{_COLLECTION[version]}/granules/{urllib.parse.quote(granule_ur(day, version), safe='')}"


def umm_item(day: dt.date, version: str) -> dict:
    name = fx.file_name(day, _TAG[version])
    return {
        "meta": {"concept-id": f"G{day:%Y%m%d}{version}-GES_DISC", "provider-id": "GES_DISC"},
        "umm": {
            "GranuleUR": granule_ur(day, version),
            "TemporalExtent": {"RangeDateTime": {"BeginningDateTime": f"{day.isoformat()}T00:00:00.000Z", "EndingDateTime": f"{day.isoformat()}T23:59:59.999Z"}},
            "CollectionReference": {"ShortName": "GPM_3IMERGDL", "Version": version},
            "RelatedUrls": [
                {"URL": f"https://data.gesdisc.earthdata.nasa.gov/data/GPM_L3/GPM_3IMERGDL.{version}/{day:%Y/%m}/{name}", "Type": "GET DATA"},
                {"URL": f"s3://gesdisc-cumulus-prod-protected/GPM_L3/GPM_3IMERGDL.{version}/{day:%Y/%m}/{name}", "Type": "GET DATA VIA DIRECT ACCESS"},
                {"URL": opendap_url(day, version), "Type": "USE SERVICE API", "Subtype": "OPENDAP DATA"},
            ],
        },
    }


class FakeEarthdata:
    def __init__(self, latest: dt.date | None = None, v08_from: dt.date | None = None, refuse: dict | None = None, token: str | None = None, missing: set | None = None, values=None):
        self.latest = latest or (dt.datetime.now(dt.UTC).date() - dt.timedelta(days=1))
        self.v08_from = v08_from
        self.refuse = dict(refuse or {})
        self.token = token
        self.missing = set(missing or ())  # days CMR lists no granule for
        self.values = values  # optional (day, version) -> (lon, lat) array override
        self.requests: list[tuple[str, dict]] = []

    def __call__(self, req, timeout=None):
        url = req.full_url
        headers = {k.title(): v for k, v in req.header_items()}
        self.requests.append((url, headers))
        host = urllib.parse.urlparse(url).hostname
        if host in self.refuse:
            raise urllib.error.HTTPError(url, self.refuse[host], "Refused", _headers({}), None)
        if url.startswith(CMR + "?"):
            return self._search(url)
        if url.startswith(OPENDAP):
            if self.token is not None and headers.get("Authorization") != f"Bearer {self.token}":
                raise urllib.error.HTTPError(url, 401, "Unauthorized", _headers({}), None)
            return self._subset(url)
        raise urllib.error.HTTPError(url, 404, "Not Found", _headers({}), None)

    def _search(self, url: str):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        if q.get("short_name") != ["GPM_3IMERGDL"]:
            raise urllib.error.HTTPError(url, 400, "Bad Request", _headers({}), None)
        start, end = (dt.date.fromisoformat(s[:10]) for s in q["temporal"][0].split(","))
        items = []
        day = start
        while day <= min(end, self.latest):
            if day not in self.missing:
                for v in q.get("version[]", []):
                    if v == "07" or (v == "08" and self.v08_from is not None and day >= self.v08_from):
                        items.append(umm_item(day, v))
            day += dt.timedelta(days=1)
        body = json.dumps({"hits": len(items), "took": 1, "items": items}).encode()
        return _Response(body, 200, _headers({"Content-Type": "application/vnd.nasa.cmr.umm_results+json", "CMR-Hits": str(len(items))}), url)

    def _subset(self, url: str):
        u = urllib.parse.urlparse(url)
        m = _GRANULE.search(urllib.parse.unquote(u.path))
        ce = urllib.parse.parse_qs(u.query).get("dap4.ce", [""])[0]
        c = _CE.match(ce)
        if not m or not c:
            raise urllib.error.HTTPError(url, 400, "Bad Request", _headers({}), None)
        version, day = m[1], dt.datetime.strptime(m[2], "%Y%m%d").date()
        t0, t1, x0, x1, y0, y1 = (int(g) for g in c.groups())
        if (t0, t1) != (0, 0) or not (0 <= x0 <= x1 < fx.NLON and 0 <= y0 <= y1 < fx.NLAT):
            raise urllib.error.HTTPError(url, 400, "Bad Request", _headers({}), None)
        values = self.values(day, version) if self.values else None
        with tempfile.TemporaryDirectory(prefix="imerg-fake-") as tmp:
            path = fx.write(Path(tmp) / "subset.nc4", day, values, slice(x0, x1 + 1), slice(y0, y1 + 1))
            body = path.read_bytes()
        return _Response(body, 200, _headers({"Content-Type": "application/x-netcdf;ver=4", "Content-Length": str(len(body))}), url)
