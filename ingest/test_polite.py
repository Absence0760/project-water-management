"""polite.py: pacing, conditional GET, Retry-After and the 403 stop, all offline.

    ingest/.venv/bin/python -m unittest discover -s ingest
"""

import email.message
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


if __name__ == "__main__":
    unittest.main()
