"""Zero-rain-run note (issue #2), the importer's copy of the engine's zeroRainRuns.

    .venv/bin/python -m unittest discover -s scripts/wbt-import
"""

import datetime as dt
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extract_project import zero_rain_note, zero_rain_runs  # noqa: E402

START = "2010-01-01"
DAYS = 6 * 365
WINTER = [4, 5, 6, 7, 8, 9]
SUMMER = [1, 2, 3, 10, 11, 12]


def seasonal(wet_months: list[int]) -> list[float | None]:
    """Synthetic rain: 8 mm every third day in the wet months, 2 mm every ninth day otherwise."""
    d0 = dt.date.fromisoformat(START)
    out: list[float | None] = []
    for i in range(DAYS):
        m = (d0 + dt.timedelta(days=i)).month
        out.append((8.0 if i % 3 == 0 else 0.0) if m in wet_months else (2.0 if i % 9 == 0 else 0.0))
    return out


def gap(v: list[float | None], first: str, last: str) -> None:
    """Zero first..last inclusive, with 5 mm on the day either side."""
    d0 = dt.date.fromisoformat(START)
    a = (dt.date.fromisoformat(first) - d0).days
    b = (dt.date.fromisoformat(last) - d0).days
    for i in range(a, b + 1):
        v[i] = 0.0
    v[a - 1] = v[b + 1] = 5.0


class ZeroRainRuns(unittest.TestCase):
    def test_flags_a_wet_season_run_not_a_longer_dry_season_one(self):
        v = seasonal(WINTER)
        gap(v, "2012-06-01", "2012-08-15")
        gap(v, "2013-11-01", "2014-02-28")
        self.assertEqual(zero_rain_runs(START, v), (WINTER, [("2012-06-01", "2012-08-15", 76)]))

    def test_the_wet_season_comes_from_the_series_itself(self):
        v = seasonal(SUMMER)
        gap(v, "2012-06-01", "2012-08-15")
        gap(v, "2012-12-01", "2013-02-14")
        self.assertEqual(zero_rain_runs(START, v), (SUMMER, [("2012-12-01", "2013-02-14", 76)]))

    def test_counts_only_wet_season_days_toward_60(self):
        v = seasonal(WINTER)
        gap(v, "2012-03-01", "2012-05-29")  # 59 wet days
        self.assertEqual(zero_rain_runs(START, v)[1], [])
        v = seasonal(WINTER)
        gap(v, "2012-03-01", "2012-05-30")  # 60
        self.assertEqual(zero_rain_runs(START, v)[1], [("2012-03-01", "2012-05-30", 91)])

    def test_a_blank_day_ends_a_run(self):
        v = seasonal(WINTER)
        gap(v, "2012-06-01", "2012-08-15")
        v[(dt.date(2012, 7, 10) - dt.date(2010, 1, 1)).days] = None
        self.assertEqual(zero_rain_runs(START, v)[1], [])

    def test_short_series_use_a_plain_180_day_rule(self):
        short = lambda n: [3.0] + [0.0] * n + [3.0] * 201  # noqa: E731
        self.assertEqual(zero_rain_runs(START, short(179)), (None, []))
        self.assertEqual(zero_rain_runs(START, short(180)), (None, [("2010-01-02", "2010-06-30", 180)]))

    def test_note_names_the_dates_and_how_runs_treat_them(self):
        v = seasonal(WINTER)
        gap(v, "2012-06-01", "2012-08-15")
        series = [{"kind": "rain_catchment_mm", "startDate": START, "values": v}]
        note = zero_rain_note(series)
        self.assertIn("2012-06-01 to 2012-08-15 (76 days)", note)
        self.assertIn("months 4,5,6,7,8,9", note)
        # Engine >= 0.15.0 treats a flagged run as missing by default (CR-20);
        # the note must not tell the user to re-export it as blank any more.
        self.assertIn("Runs treat them as missing", note)
        self.assertIn("Zero-rain runs", note)
        self.assertNotIn("re-export", note)
        # Negative controls: no gap, or only CHIRPS has the gap.
        self.assertIsNone(zero_rain_note([{"kind": "rain_catchment_mm", "startDate": START, "values": seasonal(WINTER)}]))
        self.assertIsNone(zero_rain_note([{"kind": "rain_chirps_mm", "startDate": START, "values": v}]))


if __name__ == "__main__":
    unittest.main()
