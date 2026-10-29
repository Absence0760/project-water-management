"""A stand-in for ECMWF's open data bucket over the synthetic step files in
fixtures/ecmwf/ (make_ecmwf_fixtures.py), so FEED_SOURCE=fixtures runs the
ECMWF job's index, range and decode code with no network.

`EcmwfFixtureOpener` has the signature polite.PoliteClient expects of an
opener. It serves every issue: the committed files are one issue, re-dated
to the one asked for (the index's `date`, and each GRIB message's
`dataDate`, which has a fixed width, so offsets and lengths don't move).
It answers a `Range` with 206 and those bytes, carries an ETag and a
Last-Modified, and answers 404 for a step it doesn't have or an issue after
`published_through` (to play a run that isn't out yet). `refuse` makes
every request a 403. Tests read `requests`. Not shipped in the Lambda image.
"""

from __future__ import annotations

import datetime as dt
import email.message
import email.utils
import hashlib
import io
import re
import urllib.error
from pathlib import Path

import ecmwf_forecast

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "ecmwf"
_URL = re.compile(r"^" + re.escape(ecmwf_forecast.BASE_URL) + r"/(\d{8})/00z/ifs/0p1/enfo/(\d{8})000000-(\d+)h-enfo-ef-sfc\.(index|grib2)$")


class _Response(io.BytesIO):
    def __init__(self, body: bytes, status: int, headers: email.message.Message):
        super().__init__(body)
        self.status = status
        self.headers = headers


def _headers(pairs: dict) -> email.message.Message:
    h = email.message.Message()
    for k, v in pairs.items():
        if v is not None:
            h[k] = v
    return h


def _redate_grib(blob: bytes, date: int) -> bytes:
    import eccodes

    out = bytearray()
    pos = 0
    while pos < len(blob):
        length = int.from_bytes(blob[pos + 8 : pos + 16], "big")  # GRIB2 section 0: total length
        h = eccodes.codes_new_from_message(blob[pos : pos + length])
        try:
            eccodes.codes_set(h, "dataDate", date)
            msg = eccodes.codes_get_message(h)
        finally:
            eccodes.codes_release(h)
        if len(msg) != length:
            raise RuntimeError("re-dating changed a message's length")
        out += msg
        pos += length
    return bytes(out)


class EcmwfFixtureOpener:
    def __init__(self, root: Path = FIXTURE_DIR, published_through: dt.date | None = None, missing_steps: tuple[int, ...] = (), refuse: bool = False):
        self.root = Path(root)
        self.published_through = published_through
        self.missing_steps = set(missing_steps)
        self.refuse = refuse
        self.requests: list[tuple[str, dict]] = []
        self._cache: dict[tuple[str, int, str], bytes] = {}
        self._source = self._find_source()

    def _find_source(self) -> str:
        names = sorted(p.name for p in self.root.glob("*-24h-enfo-ef-sfc.index"))
        if not names:
            raise FileNotFoundError(f"no ECMWF fixture in {self.root} (run make_ecmwf_fixtures.py)")
        return names[0][:8]

    def _body(self, date: str, step: int, ext: str) -> bytes | None:
        key = (date, step, ext)
        if key not in self._cache:
            path = self.root / f"{self._source}000000-{step}h-enfo-ef-sfc.{ext}"
            if not path.is_file():
                return None
            raw = path.read_bytes()
            if ext == "index":
                raw = raw.replace(f'"date": "{self._source}"'.encode(), f'"date": "{date}"'.encode())
            else:
                raw = _redate_grib(raw, int(date))
            self._cache[key] = raw
        return self._cache[key]

    def __call__(self, req, timeout=None):
        url = req.full_url
        headers = {k.title(): v for k, v in req.header_items()}
        self.requests.append((url, headers))
        if self.refuse:
            raise urllib.error.HTTPError(url, 403, "Forbidden", _headers({}), None)
        m = _URL.match(url)
        if not m or m[1] != m[2]:
            raise urllib.error.HTTPError(url, 404, "Not Found", _headers({}), None)
        date, step, ext = m[1], int(m[3]), m[4]
        issue = dt.datetime.strptime(date, "%Y%m%d").date()
        if step in self.missing_steps or (self.published_through is not None and issue > self.published_through):
            raise urllib.error.HTTPError(url, 404, "Not Found", _headers({}), None)
        body = self._body(date, step, ext)
        if body is None:
            raise urllib.error.HTTPError(url, 404, "Not Found", _headers({}), None)
        h = {
            "ETag": f'"{hashlib.md5(body).hexdigest()}"',
            "Last-Modified": email.utils.format_datetime(dt.datetime.combine(issue, dt.time(9, 40), dt.UTC), usegmt=True),
        }
        rng = headers.get("Range")
        if rng:
            a, b = (int(x) for x in re.fullmatch(r"bytes=(\d+)-(\d+)", rng).groups())
            part = body[a : b + 1]
            return _Response(part, 206, _headers({**h, "Content-Length": str(len(part)), "Content-Range": f"bytes {a}-{a + len(part) - 1}/{len(body)}"}))
        return _Response(body, 200, _headers({**h, "Content-Length": str(len(body))}))
