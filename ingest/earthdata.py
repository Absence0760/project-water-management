"""The Earthdata Login credential for the IMERG Late job (imerg.py; issue #618 7e/7g).

The Secrets Manager secret (`EARTHDATA_TOKEN_SECRET_ARN`) holds one of:

- **a bare user token** (the original format): used as it is, exactly as
  before. Tokens last 60 days, so the operator rotates it by hand; the
  `EarthdataTokenDaysLeft` metric and its alarm are the reminder.
- **a login**, JSON `{"username": "...", "password": "..."}`: the job gets a
  token itself from Earthdata Login's (EDL) user token API, with HTTP Basic
  auth, and replaces it before it runs out. Nothing to rotate.

The token API (https://urs.earthdata.nasa.gov/documentation/for_users/user_token,
checked 2026-10-28), all on https://urs.earthdata.nasa.gov with Basic auth:

    GET  /api/users/tokens              -> [{access_token, expiration_date}, ...]
    POST /api/users/token               -> {access_token, token_type, expiration_date}
                                           403 {"error": "max_token_limit"} at 2 tokens
    POST /api/users/revoke_token?token= -> 200
    401 {"error": "invalid_credentials"} on a wrong login

A login run lists the tokens and uses the one that lasts longest, when it has
more than REFRESH_DAYS left. Otherwise it creates one; when EDL answers
`max_token_limit` (a user holds at most 2), it revokes the listed token that
runs out first (by then within REFRESH_DAYS of its end, or past it, since a
token with longer left would have been used) and creates again. The token
lives in memory for the invocation only: **it is never written back to the
secret** (the ingest role has GetSecretValue alone, on purpose).

A token's end comes from its JWT `exp` claim (the payload decoded, no
signature check: we only read the date), else EDL's `expiration_date`
(MM/DD/YYYY in its examples, or ISO). `days_left` feeds the metric.

**Never in a log, a message or an exception:** the token, the password or the
Authorization header. Errors name the endpoint's path and EDL's error code
only; every urllib error is re-raised `from None`, and the revoke URL (which
carries a token) is never named.

A 401 from EDL raises LoginRefused (a polite.StopRun, so imerg.handle marks
the day refused and asks nothing more until the next UTC day: repeated wrong
logins could lock the account). Accounts with multi-factor sign-in may not
take Basic auth at all (EDL's docs don't say); the message says so.

EDL is not CHC: these calls never take the CHC request slot (lease.hold_host).
They are paced at one a second and send the ingest User-Agent.
"""

from __future__ import annotations

import base64
import binascii
import dataclasses
import datetime as dt
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable

import polite

EDL = "https://urs.earthdata.nasa.gov"
EDL_HOST = "urs.earthdata.nasa.gov"
#: Replace a token with fewer than this many days left.
REFRESH_DAYS = 7
METRIC = "EarthdataTokenDaysLeft"
RUNBOOK = "docs/deployment.md § IMERG Late"


class SecretFormatError(RuntimeError):
    """The secret is neither a bare token nor a {"username", "password"} object."""


class LoginRefused(polite.StopRun):
    """Earthdata Login refused the stored username and password (or the account cannot use Basic auth)."""

    def __init__(self, status: int, message: str):
        Exception.__init__(self, message)  # not StopRun's message, which names a URL
        self.url = EDL + "/api/users/tokens"
        self.status = status


class EdlError(RuntimeError):
    """Earthdata Login's token API answered something this job can't use."""


@dataclasses.dataclass(frozen=True)
class Login:
    username: str
    password: str = dataclasses.field(repr=False)

    def __repr__(self) -> str:
        return f"Login(username={self.username!r}, password=<hidden>)"


@dataclasses.dataclass(frozen=True)
class Credential:
    """The token in use, how it was got, and when it ends (None when unknown)."""

    token: str = dataclasses.field(repr=False)
    mode: str  # "token" or "login"
    expires: dt.datetime | None

    def __repr__(self) -> str:
        return f"Credential(mode={self.mode!r}, expires={self.expires!r}, token=<hidden>)"


def parse_secret(value: str | None) -> str | Login:
    """The secret's value as a bare token or a Login. Messages never quote the value."""
    text = (value or "").strip()
    if not text:
        raise SecretFormatError(f"the Earthdata token secret is empty: {RUNBOOK}")
    if not text.startswith("{"):
        return text
    try:
        doc = json.loads(text)
    except ValueError:
        raise SecretFormatError(f'the Earthdata secret starts with "{{" but is not valid JSON; it must be a bare token or {{"username": "…", "password": "…"}}: {RUNBOOK}') from None
    if not isinstance(doc, dict):
        raise SecretFormatError(f'the Earthdata secret must be a bare token or a JSON object {{"username", "password"}}: {RUNBOOK}')
    extra = sorted(set(doc) - {"username", "password"})
    if extra:
        raise SecretFormatError(f"the Earthdata secret has unknown keys {extra}; only username and password: {RUNBOOK}")
    user, password = doc.get("username"), doc.get("password")
    if not isinstance(user, str) or not user.strip():
        raise SecretFormatError(f'the Earthdata secret has no "username" string: {RUNBOOK}')
    if not isinstance(password, str) or not password:
        raise SecretFormatError(f'the Earthdata secret has no "password" string: {RUNBOOK}')
    return Login(user.strip(), password)


# --- a token's end --------------------------------------------------------------------


def jwt_expiry(token: str) -> dt.datetime | None:
    """The JWT `exp` claim as an aware UTC datetime; None when the token is not a JWT or has no exp.
    Only the payload is decoded; the signature is not checked (we read a date, we trust nothing)."""
    parts = token.split(".")
    if len(parts) != 3:
        return None
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload))
    except (ValueError, binascii.Error):
        return None
    exp = claims.get("exp") if isinstance(claims, dict) else None
    if isinstance(exp, bool) or not isinstance(exp, (int, float)):
        return None
    try:
        return dt.datetime.fromtimestamp(exp, dt.UTC)
    except (OverflowError, OSError, ValueError):
        return None


def parse_expiration_date(value) -> dt.datetime | None:
    """EDL's `expiration_date`: MM/DD/YYYY (its examples) or ISO; the start of that day, UTC (the cautious end)."""
    if not isinstance(value, str) or not value.strip():
        return None
    value = value.strip()
    for fmt in ("%m/%d/%Y", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime(value, fmt).replace(tzinfo=dt.UTC)
        except ValueError:
            pass
    try:
        when = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return when if when.tzinfo else when.replace(tzinfo=dt.UTC)


def token_expiry(token: str, expiration_date=None) -> dt.datetime | None:
    return jwt_expiry(token) or parse_expiration_date(expiration_date)


def days_left(expires: dt.datetime | None, now: dt.datetime) -> int | None:
    """Whole days left (rounded down; negative once past), or None when the end is unknown."""
    if expires is None:
        return None
    return int((expires - now).total_seconds() // 86400)


# --- the token API --------------------------------------------------------------------


class EdlClient:
    """Earthdata Login's user token API, Basic auth, polite: the ingest
    User-Agent, a timeout, one request a second. The Authorization header is
    unredirected (never copied onto a redirect), and a redirect off EDL is an
    error. `opener` is injectable for tests (urllib.request.urlopen's shape)."""

    def __init__(
        self,
        login: Login,
        contact: str | None = None,
        opener: Callable | None = None,
        timeout: float = 30.0,
        min_interval: float = 1.0,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self._auth = "Basic " + base64.b64encode(f"{login.username}:{login.password}".encode()).decode("ascii")
        self.user_agent = polite.user_agent(contact)
        self.opener = opener or urllib.request.urlopen
        self.timeout = timeout
        self.min_interval = min_interval
        self.clock = clock
        self.sleep = sleep
        self._last: float | None = None
        self.requests = 0

    def __repr__(self) -> str:
        return "EdlClient(auth=<hidden>)"

    def _pace(self) -> None:
        if self._last is not None:
            wait = self._last + self.min_interval - self.clock()
            if wait > 0:
                self.sleep(wait)
        self._last = self.clock()

    def call(self, method: str, path: str, query: dict | None = None):
        """(status, decoded JSON body or None). Raises LoginRefused on a 401,
        EdlError on any other failure; neither names the query or the auth."""
        url = EDL + path + ("?" + urllib.parse.urlencode(query) if query else "")
        req = urllib.request.Request(url, data=b"" if method == "POST" else None, method=method, headers={"User-Agent": self.user_agent, "Accept": "application/json"})
        req.add_unredirected_header("Authorization", self._auth)
        self._pace()
        self.requests += 1
        try:
            with self.opener(req, timeout=self.timeout) as res:
                landed = res.geturl() if hasattr(res, "geturl") else url
                if urllib.parse.urlparse(landed).hostname != EDL_HOST:
                    raise EdlError(f"Earthdata Login {method} {path} redirected off {EDL_HOST}")
                status = getattr(res, "status", 200)
                body = res.read()
        except urllib.error.HTTPError as e:
            status = e.code
            try:
                body = e.read(4096)
            except Exception:
                body = b""
            finally:
                e.close()
        except EdlError:
            raise
        except Exception as e:  # URLError, a timeout, a reset: the class name only (a reason can't hold the auth, but say nothing extra)
            raise EdlError(f"Earthdata Login {method} {path} failed: {type(e).__name__}") from None
        doc = _json(body)
        if status == 401:
            raise LoginRefused(401, _refusal_message(doc))
        return status, doc

    def list_tokens(self) -> list[dict]:
        status, doc = self.call("GET", "/api/users/tokens")
        if status != 200 or not isinstance(doc, list):
            raise EdlError(f"Earthdata Login GET /api/users/tokens answered HTTP {status}{_code(doc)}")
        return [t for t in doc if isinstance(t, dict) and isinstance(t.get("access_token"), str) and t["access_token"]]

    def create_token(self) -> dict | None:
        """A new token, or None when the account already holds its 2 (max_token_limit)."""
        status, doc = self.call("POST", "/api/users/token")
        if status == 403 and isinstance(doc, dict) and doc.get("error") == "max_token_limit":
            return None
        if status == 403:
            raise LoginRefused(403, f"Earthdata Login refused to create a token (HTTP 403{_code(doc)}): check the account at {EDL} and {RUNBOOK}")
        if status != 200 or not isinstance(doc, dict) or not isinstance(doc.get("access_token"), str) or not doc["access_token"]:
            raise EdlError(f"Earthdata Login POST /api/users/token answered HTTP {status}{_code(doc)}")
        return doc

    def revoke_token(self, token: str) -> None:
        status, doc = self.call("POST", "/api/users/revoke_token", {"token": token})
        if status != 200:
            raise EdlError(f"Earthdata Login POST /api/users/revoke_token answered HTTP {status}{_code(doc)}")


def _json(body: bytes):
    try:
        return json.loads(body) if body else None
    except ValueError:
        return None


def _code(doc) -> str:
    """EDL's error code, for a message: a short identifier or nothing."""
    code = doc.get("error") if isinstance(doc, dict) else None
    if isinstance(code, str) and code.replace("_", "").isalnum() and len(code) <= 64:
        return f", {code}"
    return ""


def _refusal_message(doc) -> str:
    code = doc.get("error") if isinstance(doc, dict) else None
    text = " ".join(str(doc.get(k, "")) for k in ("error", "error_description")).lower() if isinstance(doc, dict) else ""
    if any(w in text for w in ("mfa", "multi-factor", "multifactor", "two-factor", "2fa", "otp", "one-time")):
        return (
            f"Earthdata Login refused Basic auth because the account uses multi-factor sign-in (HTTP 401{_code(doc)}). "
            f"The job can't answer a second factor: store a bare user token in the secret instead, or a login without MFA kept for this job alone ({RUNBOOK})."
        )
    return (
        f"Earthdata Login refused the stored username and password (HTTP 401{_code(doc) if code else ''}). "
        f"Check the login in the secret; if the account has multi-factor sign-in, Basic auth can't work and the secret needs a bare user token instead. "
        f"No more requests this UTC day ({RUNBOOK})."
    )


def _expiry_of(entry: dict) -> dt.datetime | None:
    return token_expiry(entry["access_token"], entry.get("expiration_date"))


def obtain(login: Login, client: EdlClient, now: dt.datetime, refresh_days: int = REFRESH_DAYS) -> Credential:
    """A token with more than `refresh_days` left: the longest-lasting listed one, else a new one."""
    window = now + dt.timedelta(days=refresh_days)
    listed = [(t, _expiry_of(t)) for t in client.list_tokens()]
    good = [(t, e) for t, e in listed if e is None or e > window]
    if good:
        # Known ends first, the latest of them; a token whose end EDL doesn't say is used only when it's all there is.
        good.sort(key=lambda te: (te[1] is not None, te[1] or now), reverse=True)
        token, expires = good[0]
        return Credential(token["access_token"], "login", expires)
    created = client.create_token()
    if created is None:
        # At EDL's limit of 2, and none lasts past the window: revoke the one that ends first, then create.
        if not listed:
            raise EdlError("Earthdata Login says the account holds its maximum of tokens but lists none")
        listed.sort(key=lambda te: te[1] or dt.datetime.min.replace(tzinfo=dt.UTC))
        client.revoke_token(listed[0][0]["access_token"])
        created = client.create_token()
        if created is None:
            raise EdlError("Earthdata Login still says max_token_limit after revoking the token that ends first")
    return Credential(created["access_token"], "login", _expiry_of(created))


def resolve(secret_value: str | None, contact: str | None = None, now: dt.datetime | None = None, opener: Callable | None = None, sleep: Callable[[float], None] | None = None) -> Credential:
    """The secret's value to the token this run uses (see the module header)."""
    now = now or dt.datetime.now(dt.UTC)
    parsed = parse_secret(secret_value)
    if isinstance(parsed, str):
        return Credential(parsed, "token", jwt_expiry(parsed))
    client = EdlClient(parsed, contact, opener=opener, **({"sleep": sleep} if sleep else {}))
    return obtain(parsed, client, now)
