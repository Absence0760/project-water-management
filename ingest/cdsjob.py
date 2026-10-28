"""The CDS submit-then-collect job, shared by every product the copy takes from
the Copernicus Climate Data Store (issue #604): ERA5-Land's `era5l`
(era5land.py, R4-A) and AgERA5's `agera5_et0` (agera5.py, R5-E).

A product describes itself with a `CdsProduct`: its dataset, how a month's
request looks and how to recognise it again, which month is the newest
complete one, how a collected month is written, when a held month is asked
for again, and its limits. Everything else is the same for both and lives
here: the request state (`ingest-state/<product>/requests.json`), the intent
written before each submit, adopting a request a crash left queued, the
backoff and give-up rule for failed requests, the same-day refusal marker,
the lease, the client (`LiveCds`) and the handler that publishes
MirrorLagDays on every exit. era5land.py's module docstring describes the
rules in full; this module is that code, moved, with the product's own
parts read from the spec.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import logging
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Callable

import chirps_final
import cloudwatch
import lease
import manifest
import polite
import zarrstore

log = logging.getLogger("ingest")

CDS_URL = "https://cds.climate.copernicus.eu/api"

MONTH_RE = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")

YearMonth = tuple[int, int]


class BadEvent(ValueError):
    pass


class RequestsFailed(RuntimeError):
    """A month's request failed MAX_ATTEMPTS times: the operator looks (ingest/README.md)."""


class CdsError(RuntimeError):
    """The CDS answered something other than a refusal that this run can't use (a 5xx, a 429)."""


# --- months --------------------------------------------------------------------------


def month_str(ym: YearMonth) -> str:
    return f"{ym[0]:04d}-{ym[1]:02d}"


def parse_month(s: str) -> YearMonth:
    m = MONTH_RE.match(s)
    if not m:
        raise ValueError(f'month must be "YYYY-MM", got {s!r}')
    return int(m[1]), int(m[2])


def next_month(ym):
    y, m = ym
    return (y + 1, 1) if m == 12 else (y, m + 1)


def prev_month(ym):
    y, m = ym
    return (y - 1, 12) if m == 1 else (y, m - 1)


def month_end(ym) -> dt.date:
    return dt.date(*next_month(ym), 1) - dt.timedelta(days=1)


def _iso(t: float) -> str:
    return dt.datetime.fromtimestamp(t, dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _epoch(s: str | None) -> float | None:
    return None if not s else dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.UTC).timestamp()


def backoff_seconds(attempts: int, base_days: float, max_days: float) -> float:
    return min(base_days * 2 ** max(0, attempts - 1), max_days) * 86400.0


def recheck_at(ym, preliminary: bool | None, today: dt.date, after_days: int, every_days: int, unknown_cap_days: int) -> str | None:
    """When to ask for a held month again: never once it is consolidated.
    A preliminary month: from `after_days` after its end, then every
    `every_days`. A month of unknown phase: the same, but not past
    `unknown_cap_days` after its end, when it counts as final."""
    due = month_end(ym) + dt.timedelta(days=after_days)
    if preliminary is False:
        return None
    nxt = max(due, today + dt.timedelta(days=every_days))
    if preliminary is True:
        return nxt.isoformat()
    cap = month_end(ym) + dt.timedelta(days=unknown_cap_days)
    if today >= cap:
        return None
    return min(nxt, cap).isoformat()


# --- what a product brings -------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class CdsProduct:
    """One CDS product's own parts. The callables are looked up at call time
    by the product's module (lambdas over its globals), so a test that patches
    the module's function sees the patch."""

    product: str
    dataset: str
    #: Where an operator reads about the product's key and runs, for messages.
    runbook: str
    newest_complete_month: Callable[[dt.date], YearMonth]
    month_request: Callable[[YearMonth], dict]
    request_month: Callable[[dict], YearMonth | None]
    url_month: Callable[[str], YearMonth | None]
    ingest_month: Callable[..., dict]
    recheck_at: Callable[[YearMonth, bool | None, dt.date], str | None]
    backoff_seconds: Callable[[int], float]
    validate_event: Callable[[object, dt.date], dict]
    lag_days: Callable[[dict | None, dt.date], int]
    fake: Callable[[str | None, dt.date], object]
    max_in_flight: int
    max_attempts: int
    catch_up_months: int
    collect_reserve_s: float


# --- the request state ---------------------------------------------------------------


def state_key(product: str) -> str:
    return f"ingest-state/{product}/requests.json"


def refused_key(product: str) -> str:
    return f"ingest-state/{product}/refused.json"


ENTRY = {
    "requestId": None,  # the CDS job in flight, or None
    "submittedAt": None,  # set before the submit: an id-less entry with it is an intent a crash interrupted
    "purpose": None,  # new | recheck | backfill
    "wanted": False,  # a backfill asked for it and it waits for a slot
    "attempts": 0,  # failures since the last success
    "retryAt": None,  # no resubmit before this (ISO UTC)
    "lastError": None,
    "collectedAt": None,
    "preliminary": None,  # the held file's phase: True (preliminary), False, or None (unknown)
    "recheckAt": None,  # re-request on or after this day (YYYY-MM-DD)
}


def read_state(mirror, product: str) -> tuple[dict, bool]:
    """(the state, whether it existed)."""
    doc = mirror.read_json(state_key(product))
    if doc is None:
        return {"months": {}}, False
    months = {k: {**ENTRY, **v} for k, v in (doc.get("months") or {}).items() if MONTH_RE.match(k)}
    return {"months": months}, True


def write_state(mirror, product: str, st: dict) -> None:
    mirror.write_json(state_key(product), {"months": {k: st["months"][k] for k in sorted(st["months"])}})


# --- the CDS client ------------------------------------------------------------------------


class LiveCds:
    """The CDS through ecmwf-datastores-client, with our User-Agent, no
    client-side retry loop, at most one call a second, and a 401/403 raised as
    polite.StopRun. The result is downloaded through polite.PoliteClient.
    `request_month` recognises the product's own requests among the account's
    jobs (`find`)."""

    def __init__(self, key: str, contact: str | None = None, url: str = CDS_URL, http: polite.PoliteClient | None = None, sleep=time.sleep, clock=time.monotonic, request_month=None):
        import requests
        from ecmwf.datastores import Client

        ua = polite.user_agent(contact)

        class _Session(requests.Session):
            def request(self, method, url, **kw):
                kw["headers"] = {**(kw.get("headers") or {}), "User-Agent": ua}
                return super().request(method, url, **kw)

        self.client = Client(url=url, key=key, progress=False, maximum_tries=1, retry_after=1, sleep_max=1, timeout=60, session=_Session())
        self.http = http or polite.PoliteClient(contact=contact)
        self.sleep = sleep
        self.clock = clock
        self.request_month = request_month
        self._last = None

    def _call(self, what: str, fn):
        import requests

        if self._last is not None and (wait := self._last + 1.0 - self.clock()) > 0:
            self.sleep(wait)
        self._last = self.clock()
        try:
            return fn()
        except requests.HTTPError as e:
            status = getattr(e.response, "status_code", None)
            if status in (401, 403):
                raise polite.StopRun(f"{CDS_URL} ({what})", status) from None
            if status == 404:
                return KeyError(what)
            raise CdsError(f"the CDS answered HTTP {status} to {what}") from None

    def submit(self, dataset: str, request: dict) -> str:
        out = self._call("submit", lambda: self.client.submit(dataset, request).request_id)
        if isinstance(out, KeyError):
            raise CdsError(f"the CDS has no dataset {dataset} (404)")
        return out

    def status(self, request_id: str) -> str:
        """accepted | running | successful | failed | rejected | dismissed | deleted | missing (404)."""
        out = self._call("status", lambda: self.client.get_remote(request_id).status)
        return "missing" if isinstance(out, KeyError) else str(out)

    def find(self, dataset: str, ym) -> str | None:
        """Our own request for `ym` still queued or done among the account's recent jobs (state lost)."""
        jobs = self._call("jobs", lambda: self.client.get_jobs(limit=10, sortby="-created", status=["accepted", "running", "successful"]).request_ids)
        if isinstance(jobs, KeyError):
            return None
        for rid in jobs:
            remote = self._call("job", lambda rid=rid: self.client.get_remote(rid))
            if isinstance(remote, KeyError):
                continue
            meta = self._call("job", lambda: (remote.collection_id, remote.request))
            if not isinstance(meta, KeyError) and meta[0] == dataset and self.request_month is not None and self.request_month(meta[1]) == tuple(ym):
                return rid
        return None

    def download(self, request_id: str, dest: str) -> int:
        results = self._call("results", lambda: self.client.get_results(request_id))
        if isinstance(results, KeyError):
            raise CdsError(f"request {request_id} has no results (404)")
        res = self.http.get(results.location, dest=dest)
        if res.size is not None and res.size != results.content_length:
            raise CdsError(f"request {request_id}: downloaded {res.size} bytes of {results.content_length}")
        return Path(dest).stat().st_size


def read_cds_key(arn: str, client=None, product: str = "era5l", runbook: str = "docs/deployment.md § ERA5-Land") -> str:
    """The CDS API key from Secrets Manager (live mode only). Never logged."""
    if not arn:
        raise RuntimeError(f"CDS_KEY_SECRET_ARN is not set: live {product} needs the CDS key's secret ({runbook})")
    if client is None:
        import boto3

        client = boto3.client("secretsmanager")
    value = client.get_secret_value(SecretId=arn).get("SecretString") or ""
    value = value.strip()
    if not value:
        raise RuntimeError(f"the CDS key's secret has no value yet: the operator puts it in ({runbook})")
    return value


class LazyLiveCds:
    """Reads the key (and builds the client) only when the run first needs the CDS."""

    def __init__(self, make):
        self._make = make
        self._cds = None

    def __getattr__(self, name):
        if self._cds is None:
            self._cds = self._make()
        return getattr(self._cds, name)


# --- one run -------------------------------------------------------------------------------


@dataclasses.dataclass
class Run:
    cds: object
    budget: chirps_final.Budget
    today: dt.date
    clock: Callable[[], float] = time.time
    now: Callable[[], str] = manifest.utc_now
    workdir: str | None = None


def _refused_today(mirror, product: str, today: dt.date) -> dict | None:
    doc = mirror.read_json(refused_key(product))
    return doc if doc and doc.get("date") == today.isoformat() else None


def _held_months(spec: CdsProduct, m: dict | None) -> dict[YearMonth, dict]:
    return {ym: f for f in (m or {}).get("files", []) if (ym := spec.url_month(f["url"]))}


def run(spec: CdsProduct, mirror: zarrstore.Mirror, mode: str, month: str | None, r: Run) -> dict:
    with lease.hold(mirror, spec.product, r.clock):
        refused = _refused_today(mirror, spec.product, r.today)
        if refused:
            raise polite.StopRun(f"{CDS_URL} (refused earlier today, {refused.get('status')})", refused.get("status") or 403)
        try:
            return _run(spec, mirror, mode, month, r)
        except polite.StopRun as e:
            mirror.write_json(refused_key(spec.product), {"date": r.today.isoformat(), "status": e.status, "at": _iso(r.clock())})
            raise


def _run(spec: CdsProduct, mirror, mode, month, r: Run) -> dict:
    product = spec.product
    st, existed = read_state(mirror, product)
    months = st["months"]
    held = _held_months(spec, manifest.read(mirror, product))
    now = r.clock()
    out = {"collected": [], "submitted": [], "failed": [], "inFlight": 0, "gaveUp": []}

    # A held month the state has no entry for (state lost, or a copy written
    # elsewhere): rebuild its recheck from the manifest.
    for ym, f in held.items():
        e = months.setdefault(month_str(ym), dict(ENTRY))
        if e["collectedAt"] is None and e["requestId"] is None and e["submittedAt"] is None:
            e["collectedAt"] = f["fetchedAt"]
            e["recheckAt"] = spec.recheck_at(ym, None, dt.datetime.strptime(f["fetchedAt"][:10], "%Y-%m-%d").date())

    # 1. Collect: every request in flight, oldest month first.
    for key in sorted(k for k, e in months.items() if e["requestId"]):
        e = months[key]
        ym = parse_month(key)
        status = r.cds.status(e["requestId"])
        if status in ("accepted", "running"):
            continue
        if status == "successful":
            if not r.budget.allows(0):
                log.info("%s: %s is ready, but too little time is left; the next run collects it", product, key)
                continue
            with tempfile.TemporaryDirectory(prefix=f"{product}-", dir=r.workdir) as tmp:
                path = Path(tmp) / f"{product}-{key}.download"
                r.cds.download(e["requestId"], str(path))
                res = spec.ingest_month(mirror, ym, path, r.now)
            log.info("%s: %s %s (%s), revision %s", product, res["outcome"], key, e["purpose"], res["revision"])
            res["purpose"] = e["purpose"]
            out["collected"].append(res)
            e.update(requestId=None, submittedAt=None, wanted=False, attempts=0, retryAt=None, lastError=None, collectedAt=r.now(), preliminary=res["preliminary"], recheckAt=spec.recheck_at(ym, res["preliminary"], r.today), purpose=None)
            held[ym] = {}
        else:
            e["attempts"] += 1
            e.update(requestId=None, submittedAt=None, lastError=f"the request ended {status}", retryAt=_iso(now + spec.backoff_seconds(e["attempts"])))
            log.warning("%s: the %s request ended %s (attempt %d); resubmitting after %s", product, key, status, e["attempts"], e["retryAt"])
            out["failed"].append({"month": key, "status": status, "attempts": e["attempts"], "retryAt": e["retryAt"]})
        write_state(mirror, product, st)

    # 2. What this run wants, in priority order.
    wanted: list[tuple[YearMonth, str]] = []
    if mode == "monthly":
        newest = spec.newest_complete_month(r.today)
        # Catch up at most catch_up_months after a gap: older months are the backfill's.
        floor = newest
        for _ in range(spec.catch_up_months - 1):
            floor = prev_month(floor)
        start = max(next_month(max(held)), floor) if held else newest
        ym = start
        while ym <= newest:
            if ym not in held:
                wanted.append((ym, "new"))
            ym = next_month(ym)
        for key in sorted(months):
            e = months[key]
            if parse_month(key) in held and e["recheckAt"] and e["recheckAt"] <= r.today.isoformat():
                wanted.append((parse_month(key), "recheck"))
    else:
        ym = parse_month(month)
        e = months.setdefault(month, dict(ENTRY))
        if ym not in held:
            e["wanted"] = True
    for key in sorted((k for k, e in months.items() if e["wanted"]), reverse=True):
        if parse_month(key) not in held and (parse_month(key), "new") not in wanted:
            wanted.append((parse_month(key), "backfill"))

    # 3. Submit while slots are free: at most one request per month in flight.
    in_flight = sum(1 for e in months.values() if e["requestId"])
    for ym, purpose in wanted:
        key = month_str(ym)
        e = months.setdefault(key, dict(ENTRY))
        if e["requestId"]:
            continue
        if e["attempts"] >= spec.max_attempts:
            out["gaveUp"].append(key)
            continue
        if e["retryAt"] and _epoch(e["retryAt"]) > now:
            continue
        if in_flight >= spec.max_in_flight:
            break
        rid = None
        if e["submittedAt"] or not existed:
            # An intent a crash interrupted, or the state was lost: is our request already queued?
            rid = r.cds.find(spec.dataset, ym)
            if rid:
                log.info("%s: adopting the CDS request %s already queued for %s", product, rid, key)
        if rid is None:
            e.update(submittedAt=_iso(now), purpose=purpose)
            write_state(mirror, product, st)  # the intent, before the submit
            try:
                rid = r.cds.submit(spec.dataset, spec.month_request(ym))
            except CdsError as err:
                e["attempts"] += 1
                e.update(submittedAt=None, lastError=str(err), retryAt=_iso(now + spec.backoff_seconds(e["attempts"])))
                write_state(mirror, product, st)
                out["failed"].append({"month": key, "status": "submit-error", "attempts": e["attempts"], "retryAt": e["retryAt"]})
                continue
            log.info("%s: submitted %s (%s) as %s", product, key, purpose, rid)
        e.update(requestId=rid, submittedAt=e["submittedAt"] or _iso(now), purpose=purpose)
        out["submitted"].append({"month": key, "purpose": purpose, "requestId": rid})
        in_flight += 1
        write_state(mirror, product, st)

    out["inFlight"] = in_flight
    write_state(mirror, product, st)
    if out["gaveUp"]:
        raise RequestsFailed(f"{product}: the requests for {', '.join(out['gaveUp'])} failed {spec.max_attempts} times; clear their entries in {state_key(product)} to try again (ingest/README.md)")
    return out


# --- the handler ------------------------------------------------------------------------------


def validate_month_event(event, today: dt.date, product: str, first_month: YearMonth, newest_complete_month, label: str) -> dict:
    """{"product", "mode": "monthly" | "backfill", "month"?}, checked; BadEvent otherwise."""
    if not isinstance(event, dict):
        raise BadEvent("the event must be a JSON object")
    extra = set(event) - {"product", "mode", "month"}
    if extra:
        raise BadEvent(f"unknown event keys: {sorted(extra)}")
    if event.get("product") != product:
        raise BadEvent(f"product must be {product!r}")
    mode, month = event.get("mode"), event.get("month")
    if mode not in ("monthly", "backfill"):
        raise BadEvent(f"mode must be monthly or backfill, got {mode!r}")
    if mode == "monthly" and month is not None:
        raise BadEvent("a monthly run takes no month")
    if mode == "backfill":
        if not (isinstance(month, str) and MONTH_RE.match(month)):
            raise BadEvent(f'a backfill names its month ("month": "YYYY-MM"), got {month!r}')
        ym = parse_month(month)
        if ym < first_month:
            raise BadEvent(f"{label} starts at {month_str(first_month)}, not {month}")
        if ym > newest_complete_month(today):
            raise BadEvent(f"{month} is not complete on the CDS yet (newest {month_str(newest_complete_month(today))})")
    return {"product": product, "mode": mode, "month": month}


def handle(spec: CdsProduct, event, context=None, s3_client=None, metrics=None, cds=None, clock=None, today=None, secrets_client=None) -> dict:
    """Run one event of `spec`'s product; MirrorLagDays{Product} on every exit once the event is valid and the copy known."""
    today_d = (today or (lambda: dt.datetime.now(dt.UTC).date()))()
    ev = spec.validate_event(event, today_d)
    source = os.environ.get("FEED_SOURCE", "fixtures")
    if source not in ("fixtures", "live"):
        raise RuntimeError(f"FEED_SOURCE must be fixtures or live, got {source!r}")
    mirror_url = os.environ.get("MIRROR_URL")
    if not mirror_url:
        raise RuntimeError("MIRROR_URL is not set (file:///abs/path or s3://bucket)")
    mirror = zarrstore.Mirror.from_url(mirror_url, s3_client=s3_client)
    live = source == "live"
    if metrics is None:
        metrics = cloudwatch.CloudWatchSink() if live else cloudwatch.LocalSink()

    def publish() -> int:
        value = spec.lag_days(manifest.read(mirror, spec.product), today_d)
        metrics.publish(spec.product, value)
        return value

    try:
        if cds is None:
            if live:
                cds = LazyLiveCds(
                    lambda: LiveCds(
                        read_cds_key(os.environ.get("CDS_KEY_SECRET_ARN", ""), secrets_client, spec.product, spec.runbook),
                        contact=os.environ.get("INGEST_CONTACT"),
                        request_month=spec.request_month,
                    )
                )
            else:
                cds = spec.fake(os.environ.get("INGEST_FIXTURE_VARIANT") or None, today_d)
        r = Run(cds=cds, budget=chirps_final.Budget(context, spec.collect_reserve_s), today=today_d, **({"clock": clock} if clock else {}))
        out = run(spec, mirror, ev["mode"], ev["month"], r)
    except lease.MirrorBusy as e:
        lag = publish()
        if ev["mode"] == "backfill":
            raise
        log.info("%s: %s; the run holding it does this work", spec.product, e)
        return _result(spec, ev, source, mirror, {"busy": str(e)}, lag)
    except BaseException:
        try:
            publish()
        except Exception:
            log.exception("%s: could not publish %s while failing", spec.product, cloudwatch.METRIC)
        raise
    lag = publish()
    return _result(spec, ev, source, mirror, out, lag)


def _result(spec, ev, source, mirror, out, lag) -> dict:
    m = manifest.read(mirror, spec.product)
    return {"product": spec.product, "mode": ev["mode"], "source": source, "revision": m["revision"] if m else None, "finalThrough": m["finalThrough"] if m else None, "lagDays": lag, **out}
