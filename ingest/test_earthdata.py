"""earthdata.py (issue #618 7e/7g): the IMERG job's Earthdata secret as a bare
token or a stored login, the token API (list, create, the 2-token limit,
revoke), the days-left metric, and no secret in any message, exception or log.

No network and no real token: Earthdata Login is FakeEdl below, and every
token is a synthetic JWT built here (unsigned; only `exp` is read).

    ingest/.venv/bin/python -m unittest test_earthdata   (from ingest/)
"""

import base64
import datetime as dt
import io
import json
import logging
import os
import sys
import tempfile
import traceback
import unittest
import unittest.mock
import urllib.error
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "fixtures" / "imerg"))

import cloudwatch  # noqa: E402
import earthdata  # noqa: E402
import imerg  # noqa: E402
import imerg_fixture  # noqa: E402
import polite  # noqa: E402

NOW = dt.datetime(2024, 10, 12, 6, 0, tzinfo=dt.UTC)
TODAY = NOW.date()
USER = "wm-ingest-test"
PASSWORD = "not-a-real-password-7Q"  # synthetic
LOGIN_SECRET = json.dumps({"username": USER, "password": PASSWORD})
BASIC = "Basic " + base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()


def jwt(days: float, sub: str = "t") -> str:
    """A synthetic, unsigned JWT that ends `days` after NOW."""
    def b64(doc) -> str:
        return base64.urlsafe_b64encode(json.dumps(doc).encode()).decode().rstrip("=")

    exp = int((NOW + dt.timedelta(days=days)).timestamp())
    return f"{b64({'typ': 'JWT', 'alg': 'none'})}.{b64({'sub': sub, 'exp': exp})}.c2lnbmF0dXJl"


class _Res(io.BytesIO):
    def __init__(self, body, url, status=200):
        super().__init__(body)
        self.status = status
        self.url = url
        self.headers = imerg_fixture._headers({"Content-Type": "application/json"})

    def geturl(self):
        return self.url


class FakeEdl:
    """Earthdata Login's user token API as its docs describe it: Basic auth,
    at most 2 tokens, max_token_limit on a third, revoke by query parameter."""

    def __init__(self, tokens=(), refuse=None, new_days=60.0):
        self.tokens = list(tokens)
        self.refuse = refuse  # None, or (status, body dict) for every request
        self.new_days = new_days
        self.calls: list[tuple[str, str]] = []
        self.created: list[str] = []
        self.revoked: list[str] = []
        self.auth_headers: list[str | None] = []
        self.redirectable_auth: list[bool] = []

    def _error(self, url, status, body):
        raise urllib.error.HTTPError(url, status, "x", imerg_fixture._headers({}), io.BytesIO(json.dumps(body).encode()))

    def __call__(self, req, timeout=None):
        u = urllib.parse.urlparse(req.full_url)
        assert u.hostname == "urs.earthdata.nasa.gov", u.hostname
        self.calls.append((req.get_method(), u.path))
        self.auth_headers.append(dict(req.header_items()).get("Authorization"))
        self.redirectable_auth.append("Authorization" in req.headers)
        if self.refuse:
            self._error(req.full_url, *self.refuse)
        if dict(req.header_items()).get("Authorization") != BASIC:
            self._error(req.full_url, 401, {"error": "invalid_credentials", "error_description": "Invalid user credentials"})
        if req.get_method() == "GET" and u.path == "/api/users/tokens":
            return _Res(json.dumps([{"access_token": t, "expiration_date": "01/01/2099"} for t in self.tokens]).encode(), req.full_url)
        if req.get_method() == "POST" and u.path == "/api/users/token":
            if len(self.tokens) >= 2:
                self._error(req.full_url, 403, {"error": "max_token_limit", "error_description": "User already has maximum number of tokens."})
            t = jwt(self.new_days, sub=f"new{len(self.created)}")
            self.tokens.append(t)
            self.created.append(t)
            return _Res(json.dumps({"access_token": t, "token_type": "Bearer", "expiration_date": "12/11/2024"}).encode(), req.full_url)
        if req.get_method() == "POST" and u.path == "/api/users/revoke_token":
            t = urllib.parse.parse_qs(u.query)["token"][0]
            self.tokens.remove(t)
            self.revoked.append(t)
            return _Res(b"", req.full_url)
        self._error(req.full_url, 404, {"error": "not_found"})


def resolve(secret, edl):
    return earthdata.resolve(secret, "ops@example.com", NOW, opener=edl, sleep=lambda s: None)


class Secret(unittest.TestCase):
    def test_a_bare_token_passes_through_with_no_request(self):
        token = jwt(40)
        edl = FakeEdl()
        cred = resolve(token + "\n", edl)
        self.assertEqual((cred.token, cred.mode), (token, "token"))
        self.assertEqual(earthdata.days_left(cred.expires, NOW), 40)
        self.assertEqual(edl.calls, [])

    def test_a_bare_token_that_is_not_a_jwt_still_works_with_no_end(self):
        cred = resolve("opaque-token-value", FakeEdl())
        self.assertEqual((cred.token, cred.expires), ("opaque-token-value", None))

    def test_malformed_json_is_a_clear_error_without_the_value(self):
        for bad in ('{"username": "u", "password": ', '{"username": "u"}', '{"password": "' + PASSWORD + '"}', '{"username": "u", "password": "' + PASSWORD + '", "otp": 1}', '{"username": 5, "password": "' + PASSWORD + '"}'):
            with self.subTest(bad=bad[:20]):
                with self.assertRaises(earthdata.SecretFormatError) as caught:
                    resolve(bad, FakeEdl())
                self.assertIn("deployment.md", str(caught.exception))
                self.assertNotIn(PASSWORD, "".join(traceback.format_exception(caught.exception)))

    def test_an_empty_secret_is_refused(self):
        with self.assertRaisesRegex(earthdata.SecretFormatError, "empty"):
            resolve("  \n", FakeEdl())

    def test_the_login_and_credential_never_show_the_secret_in_repr(self):
        login = earthdata.parse_secret(LOGIN_SECRET)
        cred = earthdata.Credential("tok-xyz", "login", None)
        self.assertNotIn(PASSWORD, repr(login))
        self.assertNotIn("tok-xyz", repr(cred))
        self.assertNotIn(PASSWORD, repr(earthdata.EdlClient(login)))


class Login(unittest.TestCase):
    def test_finds_the_existing_valid_token(self):
        short, long_ = jwt(20, "a"), jwt(50, "b")
        edl = FakeEdl([short, long_])
        cred = resolve(LOGIN_SECRET, edl)
        self.assertEqual((cred.token, cred.mode), (long_, "login"))
        self.assertEqual(edl.calls, [("GET", "/api/users/tokens")])
        self.assertEqual(earthdata.days_left(cred.expires, NOW), 50)

    def test_an_expiring_token_gets_a_new_one(self):
        old = jwt(3, "old")
        edl = FakeEdl([old])
        cred = resolve(LOGIN_SECRET, edl)
        self.assertEqual(edl.created, [cred.token])
        self.assertEqual(edl.revoked, [])  # under the limit: the old one is left to run out
        self.assertEqual(earthdata.days_left(cred.expires, NOW), 60)

    def test_no_token_at_all_creates_one(self):
        edl = FakeEdl([])
        cred = resolve(LOGIN_SECRET, edl)
        self.assertEqual(edl.calls, [("GET", "/api/users/tokens"), ("POST", "/api/users/token")])
        self.assertEqual(cred.token, edl.created[0])

    def test_at_the_two_token_limit_the_one_ending_first_is_revoked(self):
        sooner, later = jwt(1, "sooner"), jwt(5, "later")
        edl = FakeEdl([later, sooner])
        cred = resolve(LOGIN_SECRET, edl)
        self.assertEqual(edl.revoked, [sooner])
        self.assertEqual(edl.tokens, [later, cred.token])
        self.assertEqual(
            edl.calls,
            [("GET", "/api/users/tokens"), ("POST", "/api/users/token"), ("POST", "/api/users/revoke_token"), ("POST", "/api/users/token")],
        )

    def test_an_expired_token_counts_as_ending_first(self):
        expired, soon = jwt(-2, "expired"), jwt(6, "soon")
        edl = FakeEdl([soon, expired])
        resolve(LOGIN_SECRET, edl)
        self.assertEqual(edl.revoked, [expired])

    def test_the_basic_auth_header_is_never_redirectable(self):
        edl = FakeEdl([jwt(30)])
        resolve(LOGIN_SECRET, edl)
        self.assertEqual(edl.auth_headers, [BASIC])
        self.assertEqual(edl.redirectable_auth, [False])

    def test_requests_are_paced(self):
        slept = []
        edl = FakeEdl([jwt(1, "a"), jwt(2, "b")])
        client = earthdata.EdlClient(earthdata.parse_secret(LOGIN_SECRET), opener=edl, clock=lambda: 0.0, sleep=slept.append)
        earthdata.obtain(earthdata.parse_secret(LOGIN_SECRET), client, NOW)
        self.assertEqual(client.requests, 4)  # list, create (limit), revoke, create
        self.assertEqual(slept, [1.0, 1.0, 1.0])

    def test_a_redirect_off_earthdata_login_is_an_error(self):
        def away(req, timeout=None):
            return _Res(b"[]", "https://elsewhere.example.com/x")

        with self.assertRaisesRegex(earthdata.EdlError, "redirected"):
            resolve(LOGIN_SECRET, away)


class Refusal(unittest.TestCase):
    def assert_no_secret(self, exc, *extra):
        text = "".join(traceback.format_exception(exc)) + repr(exc) + str(exc.args)
        for s in (PASSWORD, BASIC, BASIC.split()[1], *extra):
            self.assertNotIn(s, text)

    def test_a_401_is_a_clear_error_without_the_secret(self):
        edl = FakeEdl(refuse=(401, {"error": "invalid_credentials", "error_description": "Invalid user credentials"}))
        with self.assertRaises(earthdata.LoginRefused) as caught:
            resolve(LOGIN_SECRET, edl)
        e = caught.exception
        self.assertIsInstance(e, polite.StopRun)
        self.assertEqual(e.status, 401)
        self.assertIn("refused the stored username and password", str(e))
        self.assertIn("multi-factor", str(e))
        self.assertIn("deployment.md", str(e))
        self.assert_no_secret(e)

    def test_a_wrong_password_is_a_401(self):
        wrong = json.dumps({"username": USER, "password": "something-else"})
        with self.assertRaises(earthdata.LoginRefused):
            resolve(wrong, FakeEdl([jwt(30)]))

    def test_an_mfa_refusal_says_so(self):
        edl = FakeEdl(refuse=(401, {"error": "mfa_required", "error_description": "Multi-factor authentication is required"}))
        with self.assertRaisesRegex(earthdata.LoginRefused, "multi-factor sign-in.*bare user token"):
            resolve(LOGIN_SECRET, edl)

    def test_a_403_other_than_the_token_limit_stops(self):
        edl = FakeEdl([jwt(1, "a")])
        orig = edl.__call__

        def forbid_create(req, timeout=None):
            if req.get_method() == "POST":
                edl._error(req.full_url, 403, {"error": "account_locked"})
            return orig(req, timeout)

        with self.assertRaisesRegex(earthdata.LoginRefused, "account_locked"):
            resolve(LOGIN_SECRET, forbid_create)

    def test_a_network_error_names_no_secret_or_revoke_url(self):
        token = jwt(1, "leaky")

        class Opener(FakeEdl):
            def __call__(self, req, timeout=None):
                if "revoke" in req.full_url:
                    raise urllib.error.URLError(f"failed for {req.full_url} {dict(req.header_items())}")
                return super().__call__(req, timeout)

        with self.assertRaises(earthdata.EdlError) as caught:
            resolve(LOGIN_SECRET, Opener([token, jwt(2, "b")]))
        self.assertIn("revoke_token", str(caught.exception))
        self.assert_no_secret(caught.exception, token)

    def test_an_http_error_body_echoing_the_header_is_not_repeated(self):
        edl = FakeEdl(refuse=(500, {"error": "server_error", "error_description": f"echo {BASIC}"}))
        with self.assertRaises(earthdata.EdlError) as caught:
            resolve(LOGIN_SECRET, edl)
        self.assert_no_secret(caught.exception)


class Expiry(unittest.TestCase):
    def test_days_left_from_a_synthetic_jwt(self):
        self.assertEqual(earthdata.days_left(earthdata.jwt_expiry(jwt(9.5)), NOW), 9)
        self.assertEqual(earthdata.days_left(earthdata.jwt_expiry(jwt(-0.5)), NOW), -1)

    def test_not_a_jwt_has_no_end(self):
        for t in ("plain", "a.b", "a.!!!.c", "a." + base64.urlsafe_b64encode(b'{"no":"exp"}').decode().rstrip("=") + ".c"):
            self.assertIsNone(earthdata.jwt_expiry(t))

    def test_edls_expiration_date(self):
        self.assertEqual(earthdata.parse_expiration_date("08/09/2022"), dt.datetime(2022, 8, 9, tzinfo=dt.UTC))
        self.assertEqual(earthdata.parse_expiration_date("2022-08-09"), dt.datetime(2022, 8, 9, tzinfo=dt.UTC))
        self.assertIsNone(earthdata.parse_expiration_date("soon"))
        # The JWT's exp wins over expiration_date.
        self.assertEqual(earthdata.token_expiry(jwt(30), "01/01/2099"), NOW.replace(microsecond=0) + dt.timedelta(days=30))
        self.assertEqual(earthdata.token_expiry("opaque", "01/01/2099"), dt.datetime(2099, 1, 1, tzinfo=dt.UTC))


class Handle(unittest.TestCase):
    """imerg.handle in live mode over the fakes: the metric, the refusal marker, the logs."""

    ARN = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/ingest/earthdata-token-AbCdEf"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "mirror"
        env = {"MIRROR_URL": f"file://{self.root}", "FEED_SOURCE": "live", "EARTHDATA_TOKEN_SECRET_ARN": self.ARN}
        self.env = unittest.mock.patch.dict(os.environ, env)
        self.env.start()
        self.metrics = cloudwatch.LocalSink()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def secrets(self, value):
        class Secrets:
            def get_secret_value(self, SecretId):
                return {"SecretString": value}

        return Secrets()

    def run_handle(self, secret, edl, token_for_opendap):
        fake = imerg_fixture.FakeEarthdata(latest=TODAY - dt.timedelta(days=1), token=token_for_opendap)
        real = imerg.EarthdataOpener
        with unittest.mock.patch.object(imerg, "EarthdataOpener", lambda t: real(t, fake)):
            out = imerg.handle(
                {"product": "imerg_late", "mode": "recent", "days": 1},
                metrics=self.metrics,
                today=lambda: TODAY,
                clock=lambda: NOW.timestamp(),
                sleep=lambda s: None,
                secrets_client=self.secrets(secret),
                edl_opener=edl,
            )
        return out, fake

    def test_a_login_gets_a_token_sends_it_and_publishes_its_days(self):
        edl = FakeEdl([])
        expected = jwt(60, "new0")
        with self.assertLogs("ingest", level="INFO") as logs:
            out, fake = self.run_handle(LOGIN_SECRET, edl, expected)
        self.assertEqual(len(out["copied"]), 1)
        self.assertEqual(edl.created, [expected])
        self.assertIn(("EarthdataTokenDaysLeft", "imerg_late", 60), self.metrics.other)
        self.assertTrue(any(h.get("Authorization") == f"Bearer {expected}" for u, h in fake.requests if "opendap" in u))
        text = "\n".join(logs.output) + json.dumps(out)
        for s in (expected, PASSWORD, BASIC):
            self.assertNotIn(s, text)

    def test_a_bare_jwt_secret_publishes_its_days(self):
        token = jwt(12)
        self.run_handle(token, FakeEdl(), token)
        self.assertEqual(self.metrics.other, [("EarthdataTokenDaysLeft", "imerg_late", 12)])

    def test_a_refused_login_marks_the_day_publishes_zero_and_logs_no_secret(self):
        edl = FakeEdl(refuse=(401, {"error": "invalid_credentials"}))
        with self.assertLogs("ingest", level="INFO") as logs:
            with self.assertRaises(earthdata.LoginRefused):
                self.run_handle(LOGIN_SECRET, edl, "unused")
        self.assertEqual(self.metrics.other, [("EarthdataTokenDaysLeft", "imerg_late", 0)])
        self.assertEqual(len(self.metrics.published), 1)  # MirrorLagDays still on the way out
        marker = json.loads((self.root / "ingest-state" / "imerg_late" / "refused.json").read_text())
        self.assertEqual((marker["status"], marker["host"]), (401, "urs.earthdata.nasa.gov"))
        text = "\n".join(logs.output)
        self.assertIn("refused the stored username and password", text)
        for s in (PASSWORD, BASIC):
            self.assertNotIn(s, text)
        # The next run that UTC day asks nothing, not even Earthdata Login.
        edl2 = FakeEdl([jwt(30)])
        out, _ = self.run_handle(LOGIN_SECRET, edl2, "unused")
        self.assertEqual(out["stopped"], "refused_today")
        self.assertEqual(edl2.calls, [])

    def test_a_malformed_secret_fails_clearly(self):
        with self.assertRaisesRegex(earthdata.SecretFormatError, "not valid JSON"):
            self.run_handle('{"username": ', FakeEdl(), "unused")
        self.assertEqual(self.metrics.other, [])


class Sink(unittest.TestCase):
    def test_the_cloudwatch_sink_sends_the_token_metric(self):
        sent = []

        class Client:
            def put_metric_data(self, **kw):
                sent.append(kw)

        logging.getLogger("ingest").disabled = True
        try:
            cloudwatch.CloudWatchSink(Client()).publish_metric("EarthdataTokenDaysLeft", "imerg_late", 9)
        finally:
            logging.getLogger("ingest").disabled = False
        self.assertEqual(sent[0]["Namespace"], "water-management/Mirror")
        d = sent[0]["MetricData"][0]
        self.assertEqual((d["MetricName"], d["Dimensions"], d["Value"]), ("EarthdataTokenDaysLeft", [{"Name": "Product", "Value": "imerg_late"}], 9.0))


if __name__ == "__main__":
    unittest.main()
