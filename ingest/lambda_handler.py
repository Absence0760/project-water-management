"""The bulk ingest Lambda (issue #604 D11): `lambda_handler.handler`.

Event: {"product": "rnl" | "sat", "mode": "monthly"}
       {"product": "era5l", "mode": "monthly" | "backfill", "month"?}  (era5land.py)
       {"product": "rnl" | "sat", "mode": "backfill", "month": "YYYY-MM",
        "hold"?: {"execution": "<execution id>", "pauseSeconds": n}}
       {"mode": "release_hold", "hold": {"execution": "<execution id>"}}
       {"product": "imerg_late", "mode": "recent", "days": 1-30?}   (imerg.py)
       {"product": "ecmwf", "mode": "daily"}   (ecmwf_forecast.py, its own run)
       {"product": "agera5_et0", "mode": "monthly" | "backfill", "month"?}  (agera5.py)
       {"product": "power_et0", "mode": "recent", "days": 1-60?}  (nasapower.py)
       {"product": "c3s", "mode": "monthly" | "backfill", "month"?: "MM", "system"?}  (c3s_seasonal.py)
Env:   MIRROR_URL      file:///abs/path or s3://bucket[/prefix] (required)
       FEED_SOURCE     fixtures (default: the synthetic byMonth directory in
                       fixtures/chirps/, served by fixturehttp.py, no
                       network) or live (CHC itself, production)
       INGEST_CONTACT  the contact address in the User-Agent (optional)
       INGEST_FIXTURE_VARIANT  fixtures mode only: `rewritten` or `changed`
                       serves that variant of the synthetic directory

Both sources run the same code (chirps_final.py): the listing, its diff
against the manifest, the paced whole-file downloads, the region subset, the
hash and the write. Fixtures mode differs only in its opener, no pacing, and
a local metric sink.

**MirrorLagDays on every exit** (cloudwatch.py): once the event is valid and
the copy is reachable, every way out of the handler publishes the product's
lag: a 304, a run that copied files or was cut short by the time budget, a
monthly run another writer held off, and any failure (published before the
error is re-raised). An invalid event, or a missing MIRROR_URL, can't name a
product or read its manifest, so it publishes nothing: the errors alarm and
the lag alarm's missing-data rule both see that run.

**A 403 (polite.StopRun), an implausible value, a listing that doesn't match
its files**: the error propagates, so the Lambda errors and the event lands
in the DLQ. infra/ingest.tf sets no retries. A backfill whose product is
held by another run raises lease.MirrorBusy (the Step Functions map retries
that); the daily monthly run just ends.

**CHC's request slot** (lease.hold_host): rnl and sat take the one slot this
job shares with the fetcher Lambda before they ask CHC anything, so at most
one of our processes asks CHC at a time. Held by the other side, a backfill
month raises lease.HostBusy (the state machine retries it) and a daily run
ends quietly with `busy` in its answer, as for a held product lease.

**A backfill execution's hold** (lease.hold_host_for_backfill, issue #618
step 4): the state machine names its execution in each month's `hold`, and
every month of that execution takes the slot as the same owner, keeps it
through the pause after (`pauseSeconds`) and never releases it; the
execution's last step sends `{"mode": "release_hold"}`, which does. A
backfill event without `hold` (sent by hand) takes the slot for its own
invocation only, as before.

Run locally: `pnpm dev:ingest:run` (ingest/README.md).
"""

from __future__ import annotations

import datetime as dt
import logging
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import chirps_final  # noqa: E402
import cloudwatch  # noqa: E402
import imerg  # noqa: E402  (R4-D: IMERG Late, its own event)
import lease  # noqa: E402
import manifest  # noqa: E402
import polite  # noqa: E402
import zarrstore  # noqa: E402

# --- era5l (issue #604 R4-A): ERA5-Land, era5land.py -------------------------
import era5land  # noqa: E402

# --- end era5l ---------------------------------------------------------------

# --- reference evaporation (issue #604 R5-E): agera5.py, nasapower.py ----------
import agera5  # noqa: E402
import nasapower  # noqa: E402

# --- end reference evaporation -------------------------------------------------

# --- C3S seasonal forecasts (issue #620): c3s_seasonal.py ------------------------
import c3s_seasonal  # noqa: E402

# --- end C3S seasonal ------------------------------------------------------------

# Round 1's names for the single-file path, which now lives in chirps_final.
ingest_file = chirps_final.ingest_file
REGION_CELLS = chirps_final.REGION_CELLS

PRODUCTS = ("rnl", "sat")
MODES = ("monthly", "backfill")
_MONTH = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")

log = logging.getLogger("ingest")
log.setLevel(logging.INFO)


class BadEvent(ValueError):
    pass


def validate_event(event) -> dict:
    """The event, checked: product and mode required; month required for a backfill and refused otherwise; nothing else."""
    if not isinstance(event, dict):
        raise BadEvent("the event must be a JSON object")
    extra = set(event) - {"product", "mode", "month", "hold"}
    if extra:
        raise BadEvent(f"unknown event keys: {sorted(extra)}")
    if event.get("product") not in PRODUCTS:
        raise BadEvent(f"product must be one of {PRODUCTS}, got {event.get('product')!r}")
    if event.get("mode") not in MODES:
        raise BadEvent(f"mode must be one of {MODES}, got {event.get('mode')!r}")
    month = event.get("month")
    if month is not None and not (isinstance(month, str) and _MONTH.match(month)):
        raise BadEvent(f'month must be "YYYY-MM", got {month!r}')
    if event["mode"] == "backfill" and month is None:
        raise BadEvent('a backfill names its month ("month": "YYYY-MM")')
    if event["mode"] == "monthly" and month is not None:
        raise BadEvent("a monthly run takes no month: it copies whatever the listing has that the copy doesn't")
    hold = event.get("hold")
    if hold is not None:
        if event["mode"] != "backfill":
            raise BadEvent('only a backfill month keeps the CHC slot for its execution ("hold")')
        hold = _validate_hold(hold, pause=True)
    if month is not None:
        first = chirps_final.FIRST_MONTH[event["product"]]
        if (int(month[:4]), int(month[5:])) < first:
            raise BadEvent(f"CHC's {event['product']} byMonth files start at {first[0]:04d}-{first[1]:02d}, not {month}")
    return {"product": event["product"], "mode": event["mode"], "month": month, "hold": hold}


MAX_PAUSE_S = 3600


def _validate_hold(hold, pause: bool) -> dict:
    """A backfill execution's hold: {"execution": its id, "pauseSeconds": the wait after each month}; the release names only the execution."""
    keys = {"execution", "pauseSeconds"} if pause else {"execution"}
    if not isinstance(hold, dict) or set(hold) != keys:
        raise BadEvent(f"hold must be an object with exactly {sorted(keys)}")
    if not lease.valid_execution(hold["execution"]):
        raise BadEvent(f"hold.execution must be an execution id, got {hold['execution']!r}")
    if pause:
        p = hold["pauseSeconds"]
        if isinstance(p, bool) or not isinstance(p, int) or not 0 <= p <= MAX_PAUSE_S:
            raise BadEvent(f"hold.pauseSeconds must be whole seconds from 0 to {MAX_PAUSE_S}, got {p!r}")
    return dict(hold)


def validate_release(event) -> dict:
    """The backfill's last step: exactly {"mode": "release_hold", "hold": {"execution"}}."""
    if not isinstance(event, dict) or set(event) != {"mode", "hold"} or event["mode"] != "release_hold":
        raise BadEvent('a release is exactly {"mode": "release_hold", "hold": {"execution": ...}}')
    return _validate_hold(event["hold"], pause=False)


def _release_hold(event, s3_client=None) -> dict:
    """End a backfill execution's hold on CHC's slot (and its reservation), only ever its own. It names no product, so it publishes no lag."""
    hold = validate_release(event)
    mirror_url = os.environ.get("MIRROR_URL")
    if not mirror_url:
        raise RuntimeError("MIRROR_URL is not set (file:///abs/path or s3://bucket)")
    mirror = zarrstore.Mirror.from_url(mirror_url, s3_client=s3_client)
    released = lease.release_backfill_hold(mirror, "chc", hold["execution"])
    return {"mode": "release_hold", "holder": lease.backfill_holder(hold["execution"]), "released": released}


def _publish_lag(mirror, product: str, metrics, today: dt.date) -> int:
    m = manifest.read(mirror, product)
    value = cloudwatch.lag_days(product, m["finalThrough"] if m else None, today)
    metrics.publish(product, value)
    return value


def handler(event, context=None, s3_client=None, opener=None, metrics=None, clock=None, sleep=None, today=None):
    """Run one event. `s3_client`, `opener` (polite's), `metrics` (a cloudwatch
    sink), `clock`/`sleep` (pacing) and `today` (the lag's date) are for tests."""
    # The backfill's last step: release its execution's hold on CHC's slot.
    if isinstance(event, dict) and event.get("mode") == "release_hold":
        return _release_hold(event, s3_client)
    # --- IMERG Late (issue #604 R4-D): {"product": "imerg_late", "mode": "recent"}, imerg.py ---
    if isinstance(event, dict) and event.get("product") == imerg.PRODUCT:
        return imerg.handle(event, context, s3_client=s3_client, opener=opener, metrics=metrics, today=today, clock=clock, sleep=sleep)
    # --- end IMERG Late ---
    # --- era5l (issue #604 R4-A): its own submit-then-collect run, era5land.handler.
    # Event {"product": "era5l", "mode": "monthly" | "backfill", "month"?}.
    if isinstance(event, dict) and event.get("product") == era5land.PRODUCT:
        return era5land.handler(event, context, s3_client=s3_client, metrics=metrics, **({"clock": clock} if clock else {}), **({"today": today} if today else {}))
    # --- end era5l ---
    # --- reference evaporation (issue #604 R5-E): AgERA5 (cdsjob, like era5l) and its NASA POWER fallback ---
    if isinstance(event, dict) and event.get("product") == agera5.PRODUCT:
        return agera5.handler(event, context, s3_client=s3_client, metrics=metrics, **({"clock": clock} if clock else {}), **({"today": today} if today else {}))
    if isinstance(event, dict) and event.get("product") == nasapower.PRODUCT:
        return nasapower.handle(event, context, s3_client=s3_client, opener=opener, metrics=metrics, today=today, clock=clock, sleep=sleep)
    # --- end reference evaporation ---
    # --- C3S seasonal forecasts (issue #620): submit-then-collect like era5l, keyed by system and init ---
    if isinstance(event, dict) and event.get("product") == c3s_seasonal.PRODUCT:
        return c3s_seasonal.handler(event, context, s3_client=s3_client, metrics=metrics, **({"clock": clock} if clock else {}), **({"today": today} if today else {}))
    # --- end C3S seasonal ---
    # --- ECMWF ENS forecast (issue #604 R4-C): {"product": "ecmwf", "mode": "daily"}, ecmwf_forecast.py ---
    if isinstance(event, dict) and event.get("product") == "ecmwf":
        return _handle_ecmwf(event, context, s3_client, opener, metrics, clock, sleep, today)
    # --- end ECMWF ---
    ev = validate_event(event)
    source = os.environ.get("FEED_SOURCE", "fixtures")
    if source not in ("fixtures", "live"):
        raise RuntimeError(f"FEED_SOURCE must be fixtures or live, got {source!r}")
    mirror_url = os.environ.get("MIRROR_URL")
    if not mirror_url:
        raise RuntimeError("MIRROR_URL is not set (file:///abs/path or s3://bucket)")
    mirror = zarrstore.Mirror.from_url(mirror_url, s3_client=s3_client)
    product = ev["product"]
    live = source == "live"
    if metrics is None:
        metrics = cloudwatch.CloudWatchSink() if live else cloudwatch.LocalSink()
    if opener is None and not live:
        import fixturehttp

        opener = fixturehttp.FixtureOpener(variant=os.environ.get("INGEST_FIXTURE_VARIANT") or None)
    client_kw = {"opener": opener} if opener is not None else {}
    run = chirps_final.Run(
        # Fixtures mode has no upstream to be polite to: no pacing, same code.
        client=polite.PoliteClient(
            contact=os.environ.get("INGEST_CONTACT"),
            min_interval=1.0 if live else 0.0,
            **client_kw,
            **({"sleep": sleep} if sleep else {}),
            **({"clock": clock} if clock else {}),
        ),
        budget=chirps_final.Budget(context),
        interval=chirps_final.DOWNLOAD_INTERVAL_S if live else 0.0,
        **({"clock": clock} if clock else {}),
        **({"sleep": sleep} if sleep else {}),
    )
    today = today or (lambda: dt.datetime.now(dt.UTC).date())

    # Every exit from here on publishes MirrorLagDays (the lag alarms treat
    # no datapoint as breaching), a failure before re-raising it.
    try:
        # CHC's one request slot, shared with the fetcher Lambda (lease.hold_host),
        # taken before the product's own lease and before anything is asked; a
        # backfill execution's month keeps it through the pause after.
        if ev["hold"]:
            slot = lease.hold_host_for_backfill(mirror, "chc", run.budget.remaining_s(), ev["hold"]["execution"], ev["hold"]["pauseSeconds"])
        else:
            slot = lease.hold_host(mirror, "chc", run.budget.remaining_s(), holder=f"ingest:{product}:{ev['mode']}")
        with slot:
            if ev["mode"] == "monthly":
                out = chirps_final.run_monthly(mirror, product, run)
            else:
                out = chirps_final.run_backfill(mirror, product, ev["month"], run)
    except lease.MirrorBusy as e:
        lag = _publish_lag(mirror, product, metrics, today())
        if ev["mode"] == "backfill":
            raise
        if isinstance(e, lease.HostBusy):
            log.info("%s: %s; tomorrow's run catches up", product, e)
        else:
            log.info("%s: %s; the run holding it does this work", product, e)
        out = {"busy": str(e), "files": [], "pending": None}
        return _result(ev, source, mirror, out, lag)
    except BaseException:
        try:
            _publish_lag(mirror, product, metrics, today())
        except Exception:
            log.exception("%s: could not publish %s while failing", product, cloudwatch.METRIC)
        raise
    lag = _publish_lag(mirror, product, metrics, today())
    return _result(ev, source, mirror, out, lag)


# --- ECMWF ENS forecast (issue #604 R4-C) ---
def _handle_ecmwf(event, context, s3_client, opener, metrics, clock, sleep, today) -> dict:
    import ecmwf_forecast

    ecmwf_forecast.validate_event(event)
    source = os.environ.get("FEED_SOURCE", "fixtures")
    if source not in ("fixtures", "live"):
        raise RuntimeError(f"FEED_SOURCE must be fixtures or live, got {source!r}")
    mirror_url = os.environ.get("MIRROR_URL")
    if not mirror_url:
        raise RuntimeError("MIRROR_URL is not set (file:///abs/path or s3://bucket)")
    live = source == "live"
    if metrics is None:
        metrics = cloudwatch.CloudWatchSink() if live else cloudwatch.LocalSink()
    if opener is None and not live:
        import ecmwf_fixturehttp

        opener = ecmwf_fixturehttp.EcmwfFixtureOpener()
    return ecmwf_forecast.handle(
        event,
        context,
        mirror=zarrstore.Mirror.from_url(mirror_url, s3_client=s3_client),
        live=live,
        opener=opener,
        metrics=metrics,
        today=(today or (lambda: dt.datetime.now(dt.UTC).date()))(),
        contact=os.environ.get("INGEST_CONTACT"),
        clock=clock,
        sleep=sleep,
    )
# --- end ECMWF ---


def _result(ev, source, mirror, out, lag) -> dict:
    m = manifest.read(mirror, ev["product"])
    return {
        "product": ev["product"],
        "mode": ev["mode"],
        "source": source,
        "revision": m["revision"] if m else None,
        "finalThrough": m["finalThrough"] if m else None,
        "lagDays": lag,
        **out,
    }


if __name__ == "__main__":
    import json

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    product = sys.argv[1] if len(sys.argv) > 1 else "rnl"
    mode = {"ecmwf": "daily", "imerg_late": "recent", "power_et0": "recent"}.get(product, "monthly")
    print(json.dumps(handler({"product": product, "mode": mode}), indent=2))
