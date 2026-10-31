"""The ingest job's one HTTP client, polite by construction (issue #604, "The rule" 5).

- One descriptive User-Agent with a contact address (`INGEST_CONTACT`).
- Conditional GETs (If-None-Match / If-Modified-Since); a 304 is a skip.
- Range requests (`byte_range`), for reading a few pixels of a TIFF
  (verify_copy.py), paced like every other request.
- Pacing: at most one request every `min_interval` seconds (1 by default),
  retries included, so the job never runs more than one request at a time.
- 429 and 503 honour `Retry-After` (seconds or an HTTP date), up to
  `max_retries` times; a wait longer than `max_wait`, or one `may_retry(wait)`
  refuses (the Lambda's time budget), gives up with `RetryLater` instead of
  sleeping past the Lambda's budget. Each 429/503 is logged (warning) with its
  status, the attempt and the Retry-After received (or "absent"), and the
  `RetryLater` message names that Retry-After too, so a failed backfill says
  what CHC asked for (2026-10-31). The backfill state machine retries
  `RetryLater` with long waits (infra/ingest_backfill.tf).
- **A 403 raises `StopRun` at once and is never retried**: CHC bans by
  volume (2026-10-25), and the run must stop and alert, not keep knocking.
- **A body that ends early is a failed request, not a file.** When the
  response has a `Content-Length` (and no `Content-Encoding`), the bytes
  received must match it, for a 200 and for a 206's part alike; a short body,
  or a connection that breaks mid-body (`IncompleteRead`, a reset, a timeout,
  a TLS EOF), is retried like a 503 without `Retry-After`: paced, counted,
  backing off `truncated_backoff` (default `default_backoff`) doubling, up to
  `max_retries` times and only while `may_retry(wait)` allows (the Lambda's
  time budget), then `TruncatedDownload`. http.client's `read(amt)` returns a
  short body without raising when the server closes early, so without this a
  dropped connection reached the NetCDF reader as a truncated file (the
  1986-08 backfill, 2026-10-30).

Stdlib `urllib` only. The clock, the sleep and the opener are injectable so
the tests never touch the network or wait.
"""

from __future__ import annotations

import email.utils
import http.client
import logging
import ssl
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable

log = logging.getLogger("ingest")

USER_AGENT = "water-management-ingest/1 (+https://github.com/Absence0760/project-water-management)"


class StopRun(Exception):
    """The upstream refused us (403): stop the whole run and alert. Never retry."""

    def __init__(self, url: str, status: int = 403):
        super().__init__(f"{url} answered HTTP {status}: stopping the run (never retried; issue #604)")
        self.url = url
        self.status = status


class RetryLater(Exception):
    """The upstream asked us to wait longer than this run can, or kept asking."""


class TruncatedDownload(RetryLater):
    """The body kept ending before its Content-Length (or the connection broke
    mid-body) after every retry. Its class name is the error the backfill
    state machine retries (infra/ingest_backfill.tf)."""


#: A connection that breaks while the body is read: retried as a truncation.
#: Not OSError at large, which would also retry a full disk.
_BODY_ERRORS = (http.client.IncompleteRead, ConnectionError, TimeoutError, ssl.SSLError)


def expected_length(headers) -> int | None:
    """The body's length from Content-Length, or None when it can't be checked
    (absent, unreadable, or a Content-Encoding an opener might decode)."""
    enc = (headers.get("Content-Encoding") or "").strip().lower()
    if enc not in ("", "identity"):
        return None
    value = (headers.get("Content-Length") or "").strip()
    return int(value) if value.isdigit() else None


class HttpError(Exception):
    def __init__(self, url: str, status: int):
        super().__init__(f"{url} answered HTTP {status}")
        self.url = url
        self.status = status


@dataclass
class Response:
    url: str
    status: int
    not_modified: bool
    etag: str | None
    last_modified: str | None
    size: int | None
    body: bytes | None  # None on a 304, or when written to `dest`


def user_agent(contact: str | None) -> str:
    contact = (contact or "").strip()
    return f"{USER_AGENT[:-1]}; {contact})" if contact else USER_AGENT


def retry_after_seconds(value: str | None, now: Callable[[], float] = time.time) -> float | None:
    """Retry-After as seconds from now: delta-seconds or an HTTP date; None if absent or unreadable."""
    if value is None:
        return None
    value = value.strip()
    if value.isdigit():
        return float(value)
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    return max(0.0, when.timestamp() - now())


class PoliteClient:
    def __init__(
        self,
        contact: str | None = None,
        min_interval: float = 1.0,
        max_retries: int = 3,
        max_wait: float = 300.0,
        default_backoff: float = 30.0,
        truncated_backoff: float | None = None,
        may_retry: Callable[[float], bool] | None = None,
        timeout: float = 120.0,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        wall_clock: Callable[[], float] = time.time,
        opener: Callable = urllib.request.urlopen,
    ):
        self.user_agent = user_agent(contact)
        self.min_interval = min_interval
        self.max_retries = max_retries
        self.max_wait = max_wait
        self.default_backoff = default_backoff
        self.truncated_backoff = default_backoff if truncated_backoff is None else truncated_backoff
        self.may_retry = may_retry
        self.timeout = timeout
        self.clock = clock
        self.sleep = sleep
        self.wall_clock = wall_clock
        self.opener = opener
        self._last: float | None = None
        self.requests = 0

    def _pace(self) -> None:
        if self._last is not None:
            wait = self._last + self.min_interval - self.clock()
            if wait > 0:
                self.sleep(wait)
        self._last = self.clock()

    @staticmethod
    def _stream(res, dest: str) -> int:
        """Copy the body to `dest` (truncating whatever an earlier attempt left) and return its size."""
        size = 0
        with open(dest, "wb") as out:
            while chunk := res.read(1 << 20):
                out.write(chunk)
                size += len(chunk)
        return size

    def get(
        self,
        url: str,
        etag: str | None = None,
        last_modified: str | None = None,
        dest: str | None = None,
        byte_range: tuple[int, int] | None = None,
    ) -> Response:
        """GET `url`, conditionally when `etag`/`last_modified` are given.
        With `dest`, the body streams to that file instead of memory. With
        `byte_range` (first, last), inclusive, only those bytes are asked for
        (`Range`; a 206 answers it, and a server may clip it at the end of the
        file). A server that ignores Range answers 200 with the whole body:
        the caller slices it (verify_copy.py does)."""
        headers = {"User-Agent": self.user_agent}
        if byte_range is not None:
            first, last = byte_range
            if not 0 <= first <= last:
                raise ValueError(f"byte range {byte_range} is not first <= last")
            headers["Range"] = f"bytes={first}-{last}"
        if etag:
            headers["If-None-Match"] = etag
        if last_modified:
            headers["If-Modified-Since"] = last_modified
        attempt = 0
        while True:
            self._pace()
            self.requests += 1
            req = urllib.request.Request(url, headers=headers, method="GET")
            try:
                with self.opener(req, timeout=self.timeout) as res:
                    status = getattr(res, "status", 200)
                    h = res.headers
                    if status == 304:
                        return Response(url, 304, True, h.get("ETag"), h.get("Last-Modified"), None, None)
                    expected = expected_length(h)
                    try:
                        if dest is not None:
                            size = self._stream(res, dest)
                            body = None
                        else:
                            body = res.read()
                            size = len(body)
                        short = expected is not None and size != expected
                        why = f"{size} of {expected} bytes" if short else None
                    except _BODY_ERRORS as e:
                        short, why = True, f"{type(e).__name__} mid-body"
                    if not short:
                        return Response(url, status, False, h.get("ETag"), h.get("Last-Modified"), size, body)
                attempt += 1
                wait = self.truncated_backoff * 2 ** (attempt - 1)
                if attempt > self.max_retries or wait > self.max_wait or (self.may_retry is not None and not self.may_retry(wait)):
                    raise TruncatedDownload(f"{url} ended early ({why}) after {attempt - 1} retries")
                self.sleep(wait)
                continue
            except urllib.error.HTTPError as e:
                e.close()  # release the connection; the error body is never read
                status = e.code
                if status == 304:
                    return Response(url, 304, True, e.headers.get("ETag"), e.headers.get("Last-Modified"), None, None)
                if status == 403:
                    raise StopRun(url) from None
                if status in (429, 503):
                    attempt += 1
                    raw = e.headers.get("Retry-After") if e.headers is not None else None
                    asked = "absent" if raw is None else repr(raw.strip())
                    log.warning("%s answered HTTP %d (attempt %d of %d), Retry-After %s", url, status, attempt, self.max_retries + 1, asked)
                    if attempt > self.max_retries:
                        raise RetryLater(f"{url} still answered HTTP {status} after {self.max_retries} retries (Retry-After {asked})") from None
                    wait = retry_after_seconds(raw, self.wall_clock)
                    if wait is None:
                        wait = self.default_backoff * 2 ** (attempt - 1)
                    if wait > self.max_wait:
                        raise RetryLater(f"{url} answered HTTP {status} and asked us to wait {wait:.0f} s (over {self.max_wait:.0f} s; Retry-After {asked})") from None
                    if self.may_retry is not None and not self.may_retry(wait):
                        raise RetryLater(f"{url} answered HTTP {status}; no time left in this invocation to wait {wait:.0f} s (Retry-After {asked})") from None
                    self.sleep(wait)
                    continue
                raise HttpError(url, status) from None
