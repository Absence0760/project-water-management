"""[Flow data] series' sources and the logger's name (issue #556).

    .venv/bin/python -m unittest discover -s scripts/wbt-import

Synthetic series only (no workbook). The browser importer's twin is
frontend/src/lib/spreadsheet/import/flowData.test.ts; the synthetic workbook's
parity test checks the two agree on a whole workbook.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extract_project import flow_data_origin, name_logger_after_outlet, outlet_name  # noqa: E402


def flow_series() -> list[dict]:
    return [
        {"kind": "flow_observed_m3s", "name": "Gauge", "unit": "m3/s", **flow_data_origin("Gauge", "G", "m3/s")},
        {"kind": "flow_logger_m3s", "name": "Logger A1 (Curr. Day)", "unit": "m3/s", **flow_data_origin("Logger A1 (Curr. Day)", "H", "m3/s")},
    ]


class SeriesNamingTest(unittest.TestCase):
    def test_source_is_the_workbook_column_read_as_it_stands(self) -> None:
        self.assertEqual(
            flow_series()[1],
            {
                "kind": "flow_logger_m3s",
                "name": "Logger A1 (Curr. Day)",
                "unit": "m3/s",
                "source": "Workbook column 'Logger A1 (Curr. Day)'",
                "sourceUnit": "m³/s",
                "sourceUnitFactor": 1,
            },
        )
        # A column with no heading is named by its letter; rain is read in mm.
        self.assertEqual(flow_data_origin("", "J", "mm"), {"source": "Workbook [Flow data] column J", "sourceUnit": "mm", "sourceUnitFactor": 1})

    def test_logger_named_after_the_outlet(self) -> None:
        series = flow_series()
        name_logger_after_outlet(series, "Drift")
        self.assertEqual([s["name"] for s in series], ["Gauge", "Drift logger"])
        series = flow_series()
        name_logger_after_outlet(series, None)
        self.assertEqual(series[1]["name"], "Outlet logger")

    def test_outlet_is_the_outflow_gauge_else_the_only_root(self) -> None:
        elements = [{"name": "Farm"}, {"name": "Weir"}]
        self.assertEqual(outlet_name(elements, "Weir", ["Weir"]), "Weir")
        self.assertEqual(outlet_name(elements, "Missing", ["Weir"]), "Weir")
        self.assertIsNone(outlet_name(elements, None, ["Farm", "Weir"]))


if __name__ == "__main__":
    unittest.main()
