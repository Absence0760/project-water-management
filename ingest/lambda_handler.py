"""The bulk ingest Lambda (issue #604 D11): `lambda_handler.handler`.

Event: {"product": "rnl" | "sat", "mode": "monthly"}
       {"product": "era5l", "mode": "monthly" | "backfill", "month"?}  (era5land.py)
       {"product": "rnl" | "sat", "mode": "backfill", "month": "YYYY-MM"}
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
import lease  # noqa: E402
import manifest  # noqa: E402
import polite  # noqa: E402
import zarrstore  # noqa: E402

# --- era5l (issue #604 R4-A): ERA5-Land, era5land.py -------------------------
import era5land  # noqa: E402

# --- end era5l ---------------------------------------------------------------

# Round 1's names for the single-file path, which now lives in chirps_final.
ingest_file = chirps_final.ingest_file
_diff = chirps_final._diff
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
    extra = set(event) - {"product", "mode", "month"}
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
    if month is not None:
        first = chirps_final.FIRST_MONTH[event["product"]]
        if (int(month[:4]), int(month[5:])) < first:
            raise BadEvent(f"CHC's {event['product']} byMonth files start at {first[0]:04d}-{first[1]:02d}, not {month}")
    return {"product": event["product"], "mode": event["mode"], "month": month}


def _publish_lag(mirror, product: str, metrics, today: dt.date) -> int:
    m = manifest.read(mirror, product)
    value = cloudwatch.lag_days(product, m["finalThrough"] if m else None, today)
    metrics.publish(product, value)
    return value


def handler(event, context=None, s3_client=None, opener=None, metrics=None, clock=None, sleep=None, today=None):
    """Run one event. `s3_client`, `opener` (polite's), `metrics` (a cloudwatch
    sink), `clock`/`sleep` (pacing) and `today` (the lag's date) are for tests."""
    # --- era5l (issue #604 R4-A): its own submit-then-collect run, era5land.handler.
    # Event {"product": "era5l", "mode": "monthly" | "backfill", "month"?}.
    if isinstance(event, dict) and event.get("product") == era5land.PRODUCT:
        return era5land.handler(event, context, s3_client=s3_client, metrics=metrics, **({"clock": clock} if clock else {}), **({"today": today} if today else {}))
    # --- end era5l ---
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
        if ev["mode"] == "monthly":
            out = chirps_final.run_monthly(mirror, product, run)
        else:
            out = chirps_final.run_backfill(mirror, product, ev["month"], run)
    except lease.MirrorBusy as e:
        lag = _publish_lag(mirror, product, metrics, today())
        if ev["mode"] == "backfill":
            raise
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
    print(json.dumps(handler({"product": product, "mode": "monthly"}), indent=2))
