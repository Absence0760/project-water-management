"""--gauge-as-reference: the workbook's gauge column as a reference gauge on another river.

    .venv/bin/python -m unittest discover -s scripts/wbt-import

Synthetic series only (no workbook): gauge_as_reference() works on the
extracted series list and settings, and parse_args() on the command line.
"""

import contextlib
import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extract_project import duplicate_logger_note, gauge_as_reference, parse_args  # noqa: E402


def flow_series() -> list[dict]:
    return [
        {"kind": "rain_catchment_mm", "name": "Rain", "unit": "mm", "startDate": "2006-06-29", "values": [1.0] * 5},
        {"kind": "flow_observed_m3s", "name": "Gauge", "unit": "m3/s", "startDate": "2006-06-29", "values": [2.0, None, 4.0, 3.0, 0.0]},
        {"kind": "flow_logger_m3s", "name": "Logger", "unit": "m3/s", "startDate": "2006-06-29", "values": [1.0] * 5},
    ]


class GaugeAsReference(unittest.TestCase):
    def test_relabels_the_gauge_and_leaves_the_other_series_alone(self):
        series, settings = flow_series(), {"calibrationFlowKind": "flow_logger_m3s"}
        notes = gauge_as_reference(series, settings)
        self.assertEqual([s["kind"] for s in series], ["rain_catchment_mm", "flow_reference_m3s", "flow_logger_m3s"])
        self.assertEqual(series[1]["values"], [2.0, None, 4.0, 3.0, 0.0])  # no scaling asked for
        self.assertEqual(series[1]["name"], "Gauge")
        self.assertEqual(settings["calibrationFlowKind"], "flow_logger_m3s")  # a logger choice is kept
        self.assertEqual(len(notes), 1)
        self.assertIn("flow_reference_m3s", notes[0])
        self.assertFalse(any(n.startswith("WARNING") for n in notes))

    def test_undoes_a_scaling_from_the_given_day(self):
        series = flow_series()
        notes = gauge_as_reference(series, {}, "2006-07-01", 0.8)
        # 2006-06-29 and -30 are before the cut-off; blanks stay blank; zeros stay zero.
        self.assertEqual(series[1]["values"], [2.0, None, 5.0, 3.75, 0.0])
        self.assertIn("divided by 0.8 (3 days)", notes[0])
        # The logger is not touched.
        self.assertEqual(series[2]["values"], [1.0] * 5)

    def test_cutoff_before_the_record_scales_every_day(self):
        series = flow_series()
        gauge_as_reference(series, {}, "1990-01-01", 2)
        self.assertEqual(series[1]["values"], [1.0, None, 2.0, 1.5, 0.0])

    def test_rUseFlow_on_the_gauge_is_unset_with_a_warning(self):
        series, settings = flow_series(), {"calibrationFlowKind": "flow_observed_m3s"}
        notes = gauge_as_reference(series, settings)
        self.assertIsNone(settings["calibrationFlowKind"])
        warnings = [n for n in notes if n.startswith("WARNING: ")]
        self.assertEqual(len(warnings), 1)
        self.assertIn("runs use the logger record", warnings[0])

        no_logger = [s for s in flow_series() if s["kind"] != "flow_logger_m3s"]
        settings = {"calibrationFlowKind": "flow_observed_m3s"}
        notes = gauge_as_reference(no_logger, settings)
        self.assertIsNone(settings["calibrationFlowKind"])
        self.assertIn("no observed flow record", [n for n in notes if n.startswith("WARNING: ")][0])

    def test_no_gauge_column_is_a_note_not_an_error(self):
        series = [s for s in flow_series() if s["kind"] != "flow_observed_m3s"]
        notes = gauge_as_reference(series, {})
        self.assertEqual([s["kind"] for s in series], ["rain_catchment_mm", "flow_logger_m3s"])
        self.assertIn("nothing to re-label", notes[0])

    def test_rejects_half_a_scaling_or_a_bad_factor(self):
        for args in (("2006-07-01", None), (None, 0.8), ("2006-07-01", 0), ("2006-07-01", -1), ("2006-07-01", float("nan"))):
            with self.subTest(args=args), self.assertRaises(ValueError):
                gauge_as_reference(flow_series(), {}, *args)


class CommandLine(unittest.TestCase):
    def test_default_keeps_the_gauge_as_observed_flow(self):
        a = parse_args(["x", "wb.xlsm", "out"])
        self.assertFalse(a.gauge_as_reference)
        self.assertIsNone(a.gauge_scaling_from)
        self.assertIsNone(a.gauge_scale_factor)

    def test_reads_the_reference_options(self):
        a = parse_args(["x", "wb.xlsm", "out", "--gauge-as-reference", "--gauge-scaling-from", "2006-07-01", "--gauge-scale-factor", "0.5"])
        self.assertTrue(a.gauge_as_reference)
        self.assertEqual((a.gauge_scaling_from, a.gauge_scale_factor), ("2006-07-01", 0.5))

    def test_rejects_inconsistent_options(self):
        bad = [
            ["--gauge-scaling-from", "2006-07-01", "--gauge-scale-factor", "0.5"],  # without --gauge-as-reference
            ["--gauge-as-reference", "--gauge-scaling-from", "2006-07-01"],
            ["--gauge-as-reference", "--gauge-scale-factor", "0.5"],
            ["--gauge-as-reference", "--gauge-scaling-from", "07/01/2006", "--gauge-scale-factor", "0.5"],
            ["--gauge-as-reference", "--gauge-scaling-from", "2006-07-01", "--gauge-scale-factor", "0"],
        ]
        for extra in bad:
            with self.subTest(extra=extra), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                parse_args(["x", "wb.xlsm", "out", *extra])


if __name__ == "__main__":
    unittest.main()


class DuplicateLogger(unittest.TestCase):
    """A logger column that copies the gauge column is not a second record (issue #54)."""

    def copied(self) -> list[dict]:
        series = flow_series()
        series[2]["values"] = list(series[1]["values"])
        return series

    def test_a_copy_is_dropped_and_a_logger_choice_moves_to_the_gauge(self):
        series, settings = self.copied(), {"calibrationFlowKind": "flow_logger_m3s"}
        note = duplicate_logger_note(series, settings)
        self.assertEqual([s["kind"] for s in series], ["rain_catchment_mm", "flow_observed_m3s"])
        self.assertEqual(settings["calibrationFlowKind"], "flow_observed_m3s")
        self.assertTrue(note.startswith("WARNING: [Flow data] the logger column is a copy of the gauge column"))
        self.assertIn("now names the gauge", note)

    def test_a_gauge_choice_is_kept(self):
        series, settings = self.copied(), {"calibrationFlowKind": None}
        note = duplicate_logger_note(series, settings)
        self.assertIsNone(settings["calibrationFlowKind"])
        self.assertNotIn("now names the gauge", note)

    def test_a_logger_that_differs_on_one_day_or_starts_elsewhere_is_kept(self):
        for change in ("value", "blank", "start"):
            series, settings = self.copied(), {"calibrationFlowKind": "flow_logger_m3s"}
            if change == "value":
                series[2]["values"][4] = 0.001
            elif change == "blank":
                series[2]["values"][0] = None
            else:
                series[2]["startDate"] = "2006-06-30"
            self.assertIsNone(duplicate_logger_note(series, settings), change)
            self.assertEqual(len(series), 3)
            self.assertEqual(settings["calibrationFlowKind"], "flow_logger_m3s")

    def test_nothing_to_compare_without_both(self):
        series = [s for s in flow_series() if s["kind"] != "flow_logger_m3s"]
        self.assertIsNone(duplicate_logger_note(series, {}))
