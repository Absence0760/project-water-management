"""A stand-in for CHC's server over the synthetic `byMonth` directory
(fixtures/chirps/, make_chirps_fixtures.py), so FEED_SOURCE=fixtures runs the
same listing, diff and download code as live mode with no network.

`FixtureOpener` has the signature polite.PoliteClient expects of an opener
(`opener(request, timeout=…)`). It serves, for either product:

- the listing page (`listing.html`, or a variant's) at the byMonth URL,
  with an ETag of its content;
- each file the listing names, from the variant's directory first, with
  `Last-Modified` = the listing's time, an nginx-style ETag
  ("<mtime hex>-<size hex>") and `Content-Length`;
- 304 to a conditional GET whose validators match, 404 for anything else.

Tests swap in a variant (`rewritten`, `changed`) to play CHC re-copying a file,
and read `requests` to count what the job asked for. Not shipped in the
Lambda image.
"""

from __future__ import annotations

import email.message
import hashlib
import email.utils
import io
import re
import urllib.error
from pathlib import Path

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "chirps"
BASE = "https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/final"
_FILE = re.compile(r"^" + re.escape(BASE) + r"/(rnl|sat)/netcdf/byMonth/([^/]*)$")
_ROW = re.compile(r'<a href="([^"]+)">[^<]*</a>\s+(\d{2}-[A-Z][a-z]{2}-\d{4} \d{2}:\d{2})\s+(\d+)')


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


class FixtureOpener:
    def __init__(self, root: Path = FIXTURE_DIR, variant: str | None = None):
        self.root = Path(root)
        self.variant = variant
        self.requests: list[tuple[str, dict]] = []

    def _listing(self) -> str:
        return (self.root / (f"listing-{self.variant}.html" if self.variant else "listing.html")).read_text()

    def _entries(self) -> dict[str, tuple[str, int]]:
        import datetime as dt

        out = {}
        for href, when, size in _ROW.findall(self._listing()):
            t = dt.datetime.strptime(when, "%d-%b-%Y %H:%M").replace(tzinfo=dt.UTC)
            out[href] = (email.utils.format_datetime(t, usegmt=True), int(size))
        return out

    def _path(self, name: str) -> Path:
        if self.variant and (self.root / self.variant / name).is_file():
            return self.root / self.variant / name
        return self.root / name

    def __call__(self, req, timeout=None):
        url = req.full_url
        headers = {k.title(): v for k, v in req.header_items()}
        self.requests.append((url, headers))
        m = _FILE.match(url)
        if not m:
            raise urllib.error.HTTPError(url, 404, "Not Found", _headers({}), None)
        name = m[2]
        if name == "":
            # An ETag of the page's content, so fixtures mode exercises the
            # listing's 304 (nginx's autoindex may send none: then the job
            # reads the whole page each day, one request either way).
            body = self._listing().encode()
            etag = f'"{hashlib.sha256(body).hexdigest()[:16]}"'
            if headers.get("If-None-Match") == etag:
                raise urllib.error.HTTPError(url, 304, "Not Modified", _headers({"ETag": etag}), None)
            return _Response(body, 200, _headers({"Content-Type": "text/html", "Content-Length": str(len(body)), "ETag": etag}))
        entry = self._entries().get(name)
        if entry is None:
            raise urllib.error.HTTPError(url, 404, "Not Found", _headers({}), None)
        last_modified, size = entry
        path = self._path(name)
        if path.stat().st_size != size:
            raise AssertionError(f"the fixture listing says {name} is {size} bytes, the file is {path.stat().st_size}: re-run make_chirps_fixtures.py")
        etag = f'"{int(email.utils.parsedate_to_datetime(last_modified).timestamp()):x}-{size:x}"'
        h = {"Last-Modified": last_modified, "ETag": etag, "Content-Length": str(size)}
        if headers.get("If-None-Match") == etag or (
            "If-None-Match" not in headers and headers.get("If-Modified-Since") and email.utils.parsedate_to_datetime(headers["If-Modified-Since"]) >= email.utils.parsedate_to_datetime(last_modified)
        ):
            raise urllib.error.HTTPError(url, 304, "Not Modified", _headers(h), None)
        return _Response(path.read_bytes(), 200, _headers(h))
