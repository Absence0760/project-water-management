"""The month list the backfill state machine walks (issue #604 R2-B, D4;
infra/ingest_backfill.tf, docs/deployment.md § The data mirror → Backfill).

    python3 ingest/backfill_plan.py rnl --to 2026-08 [--from 1981-01] [--manifest rnl-manifest.json]

prints the state machine's input,

    {"items": [{"product": "rnl", "mode": "backfill", "month": "1981-01"}, …]}

one item per month from `--from` (default: the product's first month, rnl
1981-01, sat 1998-01) through `--to`, oldest first, leaving out every month
the product's manifest already holds (a file of that month in `files`). So a
backfill that stopped part way (a 403, a timeout) is resumed by fetching the
manifest again and re-running this: only the months still missing are asked
for.

The manifest is a local file (`-` reads stdin), e.g. from
`aws s3 cp s3://<mirror bucket>/rnl/manifest.json -`; without one, every
month is listed. Standard library only, so it runs with any Python 3.
"""

from __future__ import annotations

import argparse
import json
import re
import sys

PRODUCTS = ("rnl", "sat")
# The first month CHC publishes each daily product (backend/src/feeds/sources/chirps.ts).
FIRST_MONTH = {"rnl": "1981-01", "sat": "1998-01"}
# A CHC byMonth file's URL names its month: the same pattern as manifest.py file_month.
_FILE_MONTH = re.compile(r"\.(\d{4})\.(0[1-9]|1[0-2])\.days_p05\.nc$")
_MONTH = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")
# A Standard execution's history holds 25,000 events; a month takes ~10.
MAX_ITEMS = 2000


class PlanError(ValueError):
    pass


def _month(s: str, what: str) -> tuple[int, int]:
    m = _MONTH.match(s or "")
    if not m:
        raise PlanError(f'{what} must be "YYYY-MM", got {s!r}')
    return int(m[1]), int(m[2])


def held_months(manifest: dict | None, product: str) -> set[str]:
    """The months (YYYY-MM) the product's manifest already holds."""
    if manifest is None:
        return set()
    if not isinstance(manifest, dict) or manifest.get("product") != product:
        raise PlanError(f"the manifest is not {product}'s (product {manifest.get('product') if isinstance(manifest, dict) else None!r})")
    out = set()
    for f in manifest.get("files", []):
        m = _FILE_MONTH.search(f.get("url", "") if isinstance(f, dict) else "")
        if m:
            out.add(f"{m[1]}-{m[2]}")
    return out


def plan(product: str, last: str, first: str | None = None, manifest: dict | None = None) -> list[dict]:
    """The state machine's items: each month first..last not in the manifest, oldest first."""
    if product not in PRODUCTS:
        raise PlanError(f"product must be one of {PRODUCTS}, got {product!r}")
    first = first or FIRST_MONTH[product]
    y, m = _month(first, "--from")
    ly, lm = _month(last, "--to")
    if (y, m) < _month(FIRST_MONTH[product], "first"):
        raise PlanError(f"{product} starts in {FIRST_MONTH[product]}; --from {first} is before it")
    if (y, m) > (ly, lm):
        raise PlanError(f"--from {first} is after --to {last}")
    held = held_months(manifest, product)
    items = []
    while (y, m) <= (ly, lm):
        month = f"{y:04d}-{m:02d}"
        if month not in held:
            items.append({"product": product, "mode": "backfill", "month": month})
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    if len(items) > MAX_ITEMS:
        raise PlanError(f"{len(items)} months is more than one execution's history holds ({MAX_ITEMS}); split the range with --from/--to")
    return items


def main(argv: list[str] | None = None, stdin=sys.stdin, stdout=sys.stdout) -> int:
    p = argparse.ArgumentParser(description="Print the mirror backfill state machine's input (issue #604).")
    p.add_argument("product", choices=PRODUCTS)
    p.add_argument("--to", required=True, help="the last month to backfill, YYYY-MM")
    p.add_argument("--from", dest="first", help="the first month, YYYY-MM (default: the product's first)")
    p.add_argument("--manifest", help="the product's manifest.json (a path, or - for stdin), to skip the months it holds")
    a = p.parse_args(argv)
    manifest = None
    if a.manifest:
        text = stdin.read() if a.manifest == "-" else open(a.manifest, encoding="utf-8").read()
        manifest = json.loads(text)
    try:
        items = plan(a.product, a.to, a.first, manifest)
    except PlanError as e:
        print(f"backfill_plan: {e}", file=sys.stderr)
        return 2
    json.dump({"items": items}, stdout)
    stdout.write("\n")
    print(f"backfill_plan: {len(items)} months", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
