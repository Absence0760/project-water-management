"""The ingest job's one HTTP client, polite by construction (issue #604, "The rule" 5).

- One descriptive User-Agent with a contact address (`INGEST_CONTACT`).
- Conditional GETs (If-None-Match / If-Modified-Since); a 304 is a skip.
- Pacing: at most one request every `min_interval` seconds (1 by default),
  retries included, so the job never runs more than one request at a time.
- 429 and 503 honour `Retry-After` (seconds or an HTTP date), up to
  `max_retries` times; a wait longer than `max_wait` gives up instead of
  sleeping past the Lambda's budget.
- **A 403 raises `StopRun` at once and is never retried**: CHC bans by
  volume (2026-10-25), and the run must stop and alert, not keep knocking.

Stdlib `urllib` only. The clock, the sleep and the opener are injectable so
the tests never touch the network or wait.
"""

from __future__ import annotations

import email.utils
import shutil
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable

USER_AGENT = "water-management-ingest/1 (+https://github.com/Absence0760/project-water-management)"


class StopRun(Exception):
    """The upstream refused us (403): stop the whole run and alert. Never retry."""

    def __init__(self, url: str, status: int = 403):
        super().__init__(f"{url} answered HTTP {status}: stopping the run (never retried; issue #604)")
        self.url = url
        self.status = status


class RetryLater(Exception):
    """The upstream asked us to wait longer than this run can, or kept asking."""


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

    def get(self, url: str, etag: str | None = None, last_modified: str | None = None, dest: str | None = None) -> Response:
        """GET `url`, conditionally when `etag`/`last_modified` are given.
        With `dest`, the body streams to that file instead of memory."""
        headers = {"User-Agent": self.user_agent}
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
                    if dest is not None:
                        with open(dest, "wb") as out:
                            shutil.copyfileobj(res, out, 1 << 20)
                            size = out.tell()
                        body = None
                    else:
                        body = res.read()
                        size = len(body)
                    return Response(url, status, False, h.get("ETag"), h.get("Last-Modified"), size, body)
            except urllib.error.HTTPError as e:
                e.close()  # release the connection; the error body is never read
                status = e.code
                if status == 304:
                    return Response(url, 304, True, e.headers.get("ETag"), e.headers.get("Last-Modified"), None, None)
                if status == 403:
                    raise StopRun(url) from None
                if status in (429, 503):
                    attempt += 1
                    if attempt > self.max_retries:
                        raise RetryLater(f"{url} still answered HTTP {status} after {self.max_retries} retries") from None
                    wait = retry_after_seconds(e.headers.get("Retry-After"), self.wall_clock)
                    if wait is None:
                        wait = self.default_backoff * 2 ** (attempt - 1)
                    if wait > self.max_wait:
                        raise RetryLater(f"{url} asked us to wait {wait:.0f} s (over {self.max_wait:.0f} s)") from None
                    self.sleep(wait)
                    continue
                raise HttpError(url, status) from None
