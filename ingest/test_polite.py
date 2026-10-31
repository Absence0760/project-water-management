"""polite.py: pacing, conditional GET, Retry-After and the 403 stop, all offline.

    ingest/.venv/bin/python -m unittest discover -s ingest
"""

import email.message
import http.client
import io
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import polite  # noqa: E402


def headers(**kv):
    h = email.message.Message()
    for k, v in kv.items():
        h[k.replace("_", "-")] = v
    return h


class FakeResponse(io.BytesIO):
    def __init__(self, body=b"", status=200, **hdrs):
        super().__init__(body)
        self.status = status
        self.headers = headers(**hdrs)


class BrokenResponse(FakeResponse):
    """A body that breaks after `body`: http.client's IncompleteRead, a reset, a timeout."""

    def __init__(self, body=b"", error=None, **hdrs):
        super().__init__(body, **hdrs)
        self.error = error or http.client.IncompleteRead(body, 10)

    def read(self, n=-1):
        chunk = super().read(n)
        if chunk:
            return chunk
        raise self.error


class FakeServer:
    """An opener answering from a script of responses: bytes, (status, headers) or an int status."""

    def __init__(self, *script):
        self.script = list(script)
        self.requests = []

    def __call__(self, req, timeout=None):
        self.requests.append(req)
        nxt = self.script.pop(0)
        if isinstance(nxt, FakeResponse):
            return nxt
        status, hdrs = nxt if isinstance(nxt, tuple) else (nxt, {})
        raise urllib.error.HTTPError(req.full_url, status, "x", headers(**hdrs), io.BytesIO(b""))


class FakeTime:
    def __init__(self):
        self.now = 1000.0
        self.slept = []

    def clock(self):
        return self.now

    def sleep(self, s):
        self.slept.append(s)
        self.now += s


def client(server, t=None, **kw):
    t = t or FakeTime()
    return polite.PoliteClient(contact="ops@example.com", clock=t.clock, sleep=t.sleep, wall_clock=lambda: 1_700_000_000.0, opener=server, **kw), t


class Pacing(unittest.TestCase):
    def test_requests_are_at_least_min_interval_apart(self):
        server = FakeServer(FakeResponse(b"a"), FakeResponse(b"b"), FakeResponse(b"c"))
        c, t = client(server)
        c.get("https://x/1")
        t.now += 0.25  # work between requests counts towards the gap
        c.get("https://x/2")
        c.get("https://x/3")
        self.assertEqual(t.slept, [0.75, 1.0])

    def test_interval_is_configurable_and_no_wait_when_already_late(self):
        server = FakeServer(FakeResponse(b"a"), FakeResponse(b"b"))
        c, t = client(server, min_interval=5)
        c.get("https://x/1")
        t.now += 7
        c.get("https://x/2")
        self.assertEqual(t.slept, [])


class ConditionalGet(unittest.TestCase):
    def test_sends_validators_and_user_agent(self):
        server = FakeServer(FakeResponse(b"body", ETag='"abc"', Last_Modified="Wed, 27 May 2026 18:19:55 GMT"))
        c, _ = client(server)
        r = c.get("https://x/f.nc", etag='"old"', last_modified="Tue, 26 May 2026 00:00:00 GMT")
        req = server.requests[0]
        self.assertEqual(req.get_header("If-none-match"), '"old"')
        self.assertEqual(req.get_header("If-modified-since"), "Tue, 26 May 2026 00:00:00 GMT")
        self.assertIn("ops@example.com", req.get_header("User-agent"))
        self.assertTrue(req.get_header("User-agent").startswith("water-management-ingest/1 (+https://github.com/"))
        self.assertEqual((r.status, r.body, r.size, r.etag), (200, b"body", 4, '"abc"'))
        self.assertFalse(r.not_modified)

    def test_304_is_a_skip_with_no_body(self):
        for answer in [(304, {"ETag": '"abc"'}), FakeResponse(b"", status=304, ETag='"abc"')]:
            c, _ = client(FakeServer(answer))
            r = c.get("https://x/f.nc", etag='"abc"')
            self.assertTrue(r.not_modified)
            self.assertIsNone(r.body)
            self.assertEqual(r.etag, '"abc"')

    def test_no_validators_no_conditional_headers(self):
        server = FakeServer(FakeResponse(b"x"))
        c, _ = client(server)
        c.get("https://x/f")
        self.assertIsNone(server.requests[0].get_header("If-none-match"))
        self.assertIsNone(server.requests[0].get_header("If-modified-since"))

    def test_user_agent_without_contact(self):
        self.assertEqual(polite.user_agent(None), polite.USER_AGENT)
        self.assertEqual(polite.user_agent("  "), polite.USER_AGENT)

    def test_dest_streams_to_a_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            c, _ = client(FakeServer(FakeResponse(b"0123456789")))
            r = c.get("https://x/f", dest=f"{tmp}/f")
            self.assertIsNone(r.body)
            self.assertEqual(r.size, 10)
            self.assertEqual(Path(f"{tmp}/f").read_bytes(), b"0123456789")


class Refusals(unittest.TestCase):
    def test_403_stops_the_run_and_is_never_retried(self):
        server = FakeServer(403, FakeResponse(b"never reached"))
        c, t = client(server)
        with self.assertRaises(polite.StopRun) as e:
            c.get("https://x/f")
        self.assertEqual(len(server.requests), 1)
        self.assertEqual(len(server.script), 1)
        self.assertEqual(t.slept, [])
        self.assertEqual(e.exception.status, 403)

    def test_retry_after_seconds_is_honoured(self):
        server = FakeServer((429, {"Retry-After": "7"}), (503, {"Retry-After": "2"}), FakeResponse(b"ok"))
        c, t = client(server)
        r = c.get("https://x/f")
        self.assertEqual(r.body, b"ok")
        # 7 s and 2 s waits; the 1 s pacing is already covered after each.
        self.assertEqual(t.slept, [7.0, 2.0])
        self.assertEqual(len(server.requests), 3)

    def test_retry_after_http_date(self):
        server = FakeServer((503, {"Retry-After": "Tue, 14 Nov 2023 22:14:00 GMT"}), FakeResponse(b"ok"))
        c, t = client(server)  # wall clock 1_700_000_000 = 22:13:20 GMT
        c.get("https://x/f")
        self.assertEqual(t.slept, [40.0])

    def test_retry_after_too_long_gives_up(self):
        c, t = client(FakeServer((429, {"Retry-After": "3600"})), max_wait=300)
        with self.assertRaises(polite.RetryLater):
            c.get("https://x/f")
        self.assertEqual(t.slept, [])

    def test_retries_are_bounded_and_back_off_without_retry_after(self):
        server = FakeServer(503, 503, 503)
        c, t = client(server, max_retries=2, default_backoff=10)
        with self.assertRaises(polite.RetryLater):
            c.get("https://x/f")
        self.assertEqual(t.slept, [10.0, 20.0])
        self.assertEqual(len(server.requests), 3)

    def test_each_429_and_503_is_logged_with_its_retry_after(self):
        server = FakeServer((429, {"Retry-After": "7"}), 503, (429, {"Retry-After": " 120 "}), (429, {"Retry-After": "9"}))
        c, t = client(server, max_retries=3, default_backoff=10)
        with self.assertLogs("ingest", level="WARNING") as logs, self.assertRaises(polite.RetryLater) as e:
            c.get("https://x/f.nc")
        self.assertEqual(
            [r.getMessage() for r in logs.records],
            [
                "https://x/f.nc answered HTTP 429 (attempt 1 of 4), Retry-After '7'",
                "https://x/f.nc answered HTTP 503 (attempt 2 of 4), Retry-After absent",
                "https://x/f.nc answered HTTP 429 (attempt 3 of 4), Retry-After '120'",
                "https://x/f.nc answered HTTP 429 (attempt 4 of 4), Retry-After '9'",
            ],
        )
        self.assertEqual(t.slept, [7.0, 20.0, 120.0])
        # The message the backfill execution fails with names what CHC asked for last.
        self.assertEqual(str(e.exception), "https://x/f.nc still answered HTTP 429 after 3 retries (Retry-After '9')")
        self.assertNotIsInstance(e.exception, polite.TruncatedDownload)

    def test_retry_later_says_when_retry_after_was_absent(self):
        c, _ = client(FakeServer(503, 503), max_retries=1, default_backoff=1)
        with self.assertLogs("ingest", level="WARNING"), self.assertRaises(polite.RetryLater) as e:
            c.get("https://x/f")
        self.assertIn("(Retry-After absent)", str(e.exception))

    def test_too_long_a_retry_after_is_named_in_the_message(self):
        c, _ = client(FakeServer((429, {"Retry-After": "3600"})), max_wait=300)
        with self.assertLogs("ingest", level="WARNING"), self.assertRaises(polite.RetryLater) as e:
            c.get("https://x/f")
        self.assertIn("HTTP 429", str(e.exception))
        self.assertIn("Retry-After '3600'", str(e.exception))

    def test_a_wait_past_the_time_budget_gives_up_instead_of_sleeping(self):
        asked = []
        server = FakeServer((429, {"Retry-After": "200"}), FakeResponse(b"ok"))
        c, t = client(server, may_retry=lambda wait: asked.append(wait) or False)
        with self.assertLogs("ingest", level="WARNING"), self.assertRaises(polite.RetryLater) as e:
            c.get("https://x/f")
        self.assertEqual(asked, [200.0])
        self.assertEqual(t.slept, [])
        self.assertEqual(len(server.requests), 1)
        self.assertIn("no time left", str(e.exception))
        self.assertIn("Retry-After '200'", str(e.exception))

    def test_a_wait_the_budget_allows_is_slept(self):
        server = FakeServer((503, {"Retry-After": "5"}), FakeResponse(b"ok"))
        c, t = client(server, may_retry=lambda wait: True)
        with self.assertLogs("ingest", level="WARNING"):
            self.assertEqual(c.get("https://x/f").body, b"ok")
        self.assertEqual(t.slept, [5.0])

    def test_other_errors_raise_without_retry(self):
        server = FakeServer(404)
        c, _ = client(server)
        with self.assertRaises(polite.HttpError) as e:
            c.get("https://x/f")
        self.assertEqual(e.exception.status, 404)
        self.assertEqual(len(server.requests), 1)

    def test_unreadable_retry_after(self):
        self.assertIsNone(polite.retry_after_seconds("soon"))
        self.assertIsNone(polite.retry_after_seconds(None))


class Truncation(unittest.TestCase):
    """A body shorter than its Content-Length, or one that breaks mid-read, is
    retried like a 503 and never handed back as if whole (the 1986-08 backfill)."""

    def test_short_body_is_retried_then_succeeds(self):
        for dest in (False, True):
            with self.subTest(dest=dest), tempfile.TemporaryDirectory() as tmp:
                server = FakeServer(FakeResponse(b"0123", Content_Length="10"), FakeResponse(b"0123456789", Content_Length="10"))
                c, t = client(server, default_backoff=10)
                r = c.get("https://x/f.nc", dest=f"{tmp}/f" if dest else None)
                self.assertEqual(r.size, 10)
                self.assertEqual(len(server.requests), 2)
                self.assertEqual(c.requests, 2)
                self.assertEqual(t.slept, [10.0])  # the backoff; the 1 s pacing is already covered
                if dest:
                    self.assertEqual(Path(f"{tmp}/f").read_bytes(), b"0123456789")  # the short attempt overwritten
                else:
                    self.assertEqual(r.body, b"0123456789")

    def test_always_short_raises_truncated_download_after_max_retries(self):
        server = FakeServer(*[FakeResponse(b"012", Content_Length="10") for _ in range(3)])
        c, t = client(server, max_retries=2, default_backoff=10)
        with tempfile.TemporaryDirectory() as tmp, self.assertRaises(polite.TruncatedDownload) as e:
            c.get("https://x/f.nc", dest=f"{tmp}/f")
        self.assertIsInstance(e.exception, polite.RetryLater)
        self.assertIn("3 of 10 bytes", str(e.exception))
        self.assertEqual(len(server.requests), 3)
        self.assertEqual(t.slept, [10.0, 20.0])

    def test_truncated_backoff_overrides_and_paces_every_retry(self):
        server = FakeServer(FakeResponse(b"0", Content_Length="2"), FakeResponse(b"01", Content_Length="2"))
        c, t = client(server, truncated_backoff=0.0, min_interval=5)
        c.get("https://x/f")
        self.assertEqual(t.slept, [0.0, 5.0])  # no backoff, but still one request per min_interval

    def test_may_retry_refusing_gives_up_at_once(self):
        asked = []
        server = FakeServer(FakeResponse(b"0", Content_Length="2"), FakeResponse(b"01", Content_Length="2"))
        c, t = client(server, default_backoff=60, may_retry=lambda wait: asked.append(wait) or False)
        with self.assertRaises(polite.TruncatedDownload):
            c.get("https://x/f")
        self.assertEqual(asked, [60.0])
        self.assertEqual(len(server.requests), 1)
        self.assertEqual(t.slept, [])

    def test_a_backoff_over_max_wait_gives_up(self):
        c, t = client(FakeServer(FakeResponse(b"0", Content_Length="2")), default_backoff=600, max_wait=300)
        with self.assertRaises(polite.TruncatedDownload):
            c.get("https://x/f")
        self.assertEqual(t.slept, [])

    def test_connection_breaking_mid_body_is_retried(self):
        for error in (http.client.IncompleteRead(b"01", 8), ConnectionResetError(104, "reset"), TimeoutError("timed out")):
            for dest in (False, True):
                with self.subTest(error=type(error).__name__, dest=dest), tempfile.TemporaryDirectory() as tmp:
                    server = FakeServer(BrokenResponse(b"01", error=error, Content_Length="10"), FakeResponse(b"0123456789", Content_Length="10"))
                    c, _ = client(server, default_backoff=1)
                    r = c.get("https://x/f", dest=f"{tmp}/f" if dest else None)
                    self.assertEqual(r.size, 10)
                    self.assertEqual(len(server.requests), 2)

    def test_a_disk_error_is_not_retried(self):
        server = FakeServer(FakeResponse(b"0123456789", Content_Length="10"))
        c, _ = client(server)
        with self.assertRaises(OSError):
            c.get("https://x/f", dest="/nonexistent-dir/f")
        self.assertEqual(len(server.requests), 1)

    def test_no_content_length_is_accepted_as_before(self):
        c, t = client(FakeServer(FakeResponse(b"0123")))
        r = c.get("https://x/f")
        self.assertEqual((r.size, r.body), (4, b"0123"))
        self.assertEqual(t.slept, [])

    def test_a_content_encoding_skips_the_length_check(self):
        c, _ = client(FakeServer(FakeResponse(b"decoded body", Content_Length="5", Content_Encoding="gzip")))
        self.assertEqual(c.get("https://x/f").size, 12)

    def test_a_206_part_is_checked_against_its_own_length(self):
        server = FakeServer(
            FakeResponse(b"23", status=206, Content_Length="4", Content_Range="bytes 2-5/100"),
            FakeResponse(b"2345", status=206, Content_Length="4", Content_Range="bytes 2-5/100"),
        )
        c, _ = client(server, default_backoff=1)
        r = c.get("https://x/f", byte_range=(2, 5))
        self.assertEqual((r.status, r.body), (206, b"2345"))
        self.assertEqual(len(server.requests), 2)

    def test_304_is_unaffected(self):
        server = FakeServer(FakeResponse(b"", status=304, ETag='"abc"', Content_Length="10"))
        c, t = client(server)
        r = c.get("https://x/f", etag='"abc"')
        self.assertTrue(r.not_modified)
        self.assertEqual(len(server.requests), 1)
        self.assertEqual(t.slept, [])

    def test_unreadable_content_length_is_ignored(self):
        self.assertIsNone(polite.expected_length(headers(Content_Length="ten")))
        self.assertEqual(polite.expected_length(headers(Content_Length="10", Content_Encoding="identity")), 10)


if __name__ == "__main__":
    unittest.main()
