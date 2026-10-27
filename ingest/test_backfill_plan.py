"""backfill_plan.py: the month list, oldest first, skipping what the manifest holds.

    ingest/.venv/bin/python -m unittest ingest/test_backfill_plan.py
"""

import io
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import backfill_plan  # noqa: E402

BASE = "https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/final/{p}/netcdf/byMonth/chirps-v3.0.{ym}.days_p05.nc"


def manifest(product, months):
    return {"product": product, "files": [{"url": BASE.format(p=product, ym=m.replace("-", "."))} for m in months]}


class Plan(unittest.TestCase):
    def test_every_month_in_order_across_a_year_end(self):
        items = backfill_plan.plan("rnl", "1982-02", "1981-11")
        self.assertEqual([i["month"] for i in items], ["1981-11", "1981-12", "1982-01", "1982-02"])
        self.assertEqual(items[0], {"product": "rnl", "mode": "backfill", "month": "1981-11"})

    def test_starts_at_the_products_first_month_by_default(self):
        self.assertEqual(backfill_plan.plan("rnl", "1981-02")[0]["month"], "1981-01")
        self.assertEqual(backfill_plan.plan("sat", "1998-02")[0]["month"], "1998-01")

    def test_skips_the_months_the_manifest_holds(self):
        m = manifest("sat", ["1998-01", "1998-03"])
        self.assertEqual([i["month"] for i in backfill_plan.plan("sat", "1998-04", manifest=m)], ["1998-02", "1998-04"])

    def test_a_fully_held_range_is_empty(self):
        m = manifest("rnl", ["2024-01", "2024-02"])
        self.assertEqual(backfill_plan.plan("rnl", "2024-02", "2024-01", m), [])

    def test_refuses_another_products_manifest(self):
        with self.assertRaisesRegex(backfill_plan.PlanError, "not rnl's"):
            backfill_plan.plan("rnl", "1981-02", manifest=manifest("sat", []))

    def test_refuses_bad_ranges(self):
        for args, message in [
            (("rnl", "1981-13"), "YYYY-MM"),
            (("rnl", "1981-02", "1981-03"), "after --to"),
            (("sat", "1998-02", "1997-12"), "starts in 1998-01"),
            (("era5", "2000-01"), "product must be"),
        ]:
            with self.subTest(args=args), self.assertRaisesRegex(backfill_plan.PlanError, message):
                backfill_plan.plan(*args)

    def test_refuses_more_months_than_one_execution_holds(self):
        old = backfill_plan.MAX_ITEMS
        backfill_plan.MAX_ITEMS = 3
        try:
            with self.assertRaisesRegex(backfill_plan.PlanError, "split the range"):
                backfill_plan.plan("rnl", "1981-04")
        finally:
            backfill_plan.MAX_ITEMS = old

    def test_matches_manifest_file_month(self):
        # The pattern is duplicated to keep this script stdlib-only; it must agree with manifest.py's.
        import manifest as mf  # needs numpy: run under ingest/.venv, as CI does
        for url in [BASE.format(p="rnl", ym="2024.06"), "https://x/chirps-v3.0.2024.13.days_p05.nc", "https://x/other.nc"]:
            m = backfill_plan._FILE_MONTH.search(url)
            self.assertEqual((int(m[1]), int(m[2])) if m else None, mf.file_month(url))


class Cli(unittest.TestCase):
    def test_prints_the_state_machines_input_from_a_manifest_on_stdin(self):
        out = io.StringIO()
        stdin = io.StringIO(json.dumps(manifest("rnl", ["1981-01"])))
        self.assertEqual(backfill_plan.main(["rnl", "--to", "1981-03", "--manifest", "-"], stdin=stdin, stdout=out), 0)
        self.assertEqual(json.loads(out.getvalue()), {"items": [{"product": "rnl", "mode": "backfill", "month": m} for m in ["1981-02", "1981-03"]]})

    def test_exits_2_on_a_bad_range(self):
        self.assertEqual(backfill_plan.main(["rnl", "--to", "1980-12"], stdout=io.StringIO()), 2)


if __name__ == "__main__":
    unittest.main()
