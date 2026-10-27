"""The bulk ingest Lambda (issue #604 D11): `lambda_handler.handler`.

Event: {"product": "rnl" | "sat", "mode": "monthly" | "backfill", "month": "YYYY-MM"?}
Env:   MIRROR_URL      file:///abs/path or s3://bucket[/prefix] (required)
       FEED_SOURCE     fixtures (default: the committed synthetic NetCDF,
                       no network) or live (production)
       INGEST_CONTACT  the contact address in the User-Agent (optional)

Round 1 is the skeleton: in fixtures mode it reads `fixtures/chc/*.nc`
(make_chc_fixture.py), writes the region into the product's finals array and
updates its manifest; a re-run with the same values changes nothing but the
file's `fetchedAt`, and changed values bump the revision with a `changes`
entry. Live mode (listing CHC's `byMonth` directory and downloading through
polite.py) arrives with R2-A, so it refuses for now.

Run locally: `pnpm dev:ingest:run` (ingest/README.md).
"""

from __future__ import annotations

import datetime as dt
import os
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import chcnetcdf  # noqa: E402
import grid  # noqa: E402
import manifest  # noqa: E402
import zarrstore  # noqa: E402

PRODUCTS = ("rnl", "sat")
MODES = ("monthly", "backfill")
FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "chc"
_MONTH = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")
_FILE_MONTH = re.compile(r"\.(\d{4})\.(\d{2})\.days_p05\.nc$")


class BadEvent(ValueError):
    pass


def validate_event(event) -> dict:
    """The event, checked: product and mode required, month optional, nothing else."""
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
    return {"product": event["product"], "mode": event["mode"], "month": month}


def fixture_files(month: str | None) -> list[Path]:
    files = sorted(FIXTURE_DIR.glob("*.nc"))
    if month is not None:
        files = [f for f in files if (m := _FILE_MONTH.search(f.name)) and f"{m[1]}-{m[2]}" == month]
        if not files:
            raise BadEvent(f"no fixture file for {month} in {FIXTURE_DIR}")
    return files


def _diff(old: np.ndarray, new: np.ndarray) -> tuple[int, float]:
    """(cells whose series changed, the largest absolute difference where both have a value)."""
    both_nan = np.isnan(old) & np.isnan(new)
    changed = ~both_nan & ((old != new) | (np.isnan(old) != np.isnan(new)))
    cells = int(np.any(changed, axis=0).sum())
    finite = ~np.isnan(old) & ~np.isnan(new)
    max_abs = float(np.max(np.abs(old[finite] - new[finite]), initial=0.0))
    return cells, max_abs


def ingest_file(mirror: zarrstore.Mirror, product: str, url: str, path: Path, etag=None, last_modified=None, now=manifest.utc_now) -> dict:
    """Copy one CHC NetCDF file's region into `product` and record it in the manifest."""
    region = chcnetcdf.read_region(str(path))
    days = region.values.shape[0]
    last_day = region.first_day + dt.timedelta(days=days - 1)
    sha = manifest.values_sha256(region.values)
    m = manifest.read(mirror, product) or manifest.new(product)
    previous = manifest.file_entry(m, url)

    outcome = "unchanged"
    if previous is None or previous["valuesSha256"] != sha:
        prefixes = zarrstore.finals_year_prefixes(product, region.first_day, days)
        with mirror.stage(prefixes) as root:
            old = zarrstore.read_finals(root, product, region.first_day, days)
            zarrstore.write_finals(root, product, region.first_day, region.values)
        if previous is None:
            outcome = "added"
        else:
            m["revision"] += 1
            cells, max_abs = _diff(old, region.values)
            m["changes"].append({"revision": m["revision"], "days": [region.first_day.isoformat(), last_day.isoformat()], "cellsChanged": cells, "maxAbsDiff": max_abs})
            outcome = "changed"

    manifest.upsert_file(
        m,
        {
            "url": url,
            "etag": etag,
            "lastModified": last_modified,
            "size": path.stat().st_size,
            "valuesSha256": sha,
            "revision": m["revision"],
            "fetchedAt": now(),
        },
    )
    first, last = m["years"]["first"], m["years"]["last"]
    m["years"] = {"first": min(filter(None, [first, region.first_day.year])), "last": max(filter(None, [last, last_day.year]))}
    if m["finalThrough"] is None or last_day.isoformat() > m["finalThrough"]:
        m["finalThrough"] = last_day.isoformat()
    manifest.write(mirror, m)
    return {"url": url, "outcome": outcome, "days": [region.first_day.isoformat(), last_day.isoformat()], "revision": m["revision"]}


def handler(event, context=None, s3_client=None):
    ev = validate_event(event)
    source = os.environ.get("FEED_SOURCE", "fixtures")
    mirror_url = os.environ.get("MIRROR_URL")
    if not mirror_url:
        raise RuntimeError("MIRROR_URL is not set (file:///abs/path or s3://bucket)")
    mirror = zarrstore.Mirror.from_url(mirror_url, s3_client=s3_client)

    if source == "live":
        raise NotImplementedError("live fetching from CHC is not built yet (issue #604 R2-A); use FEED_SOURCE=fixtures")
    if source != "fixtures":
        raise RuntimeError(f"FEED_SOURCE must be fixtures or live, got {source!r}")

    files = fixture_files(ev["month"])
    if ev["mode"] == "monthly" and ev["month"] is None:
        files = files[-1:]
    results = [ingest_file(mirror, ev["product"], f"fixture:chc/{f.name}", f) for f in files]
    m = manifest.read(mirror, ev["product"])
    return {"product": ev["product"], "mode": ev["mode"], "source": source, "revision": m["revision"] if m else None, "finalThrough": m["finalThrough"] if m else None, "files": results}


if __name__ == "__main__":
    import json

    product = sys.argv[1] if len(sys.argv) > 1 else "rnl"
    print(json.dumps(handler({"product": product, "mode": "backfill"}), indent=2))
