"""soils.py: root-zone plant-available water capacity from invented grids
(issue #622 step 2). Standard library only.

    python3 -m unittest test_soils   (from ingest/)
"""

import gzip
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import soils  # noqa: E402


def asc(values, xll=20.0, yll=-34.0, cellsize=0.5, nodata=-9999):
    """An ESRI ASCII grid's text, rows north to south."""
    rows = len(values)
    cols = len(values[0])
    head = f"ncols {cols}\nnrows {rows}\nxllcorner {xll}\nyllcorner {yll}\ncellsize {cellsize}\nNODATA_value {nodata}\n"
    return head + "\n".join(" ".join(str(v) for v in r) for r in values) + "\n"


def grid(values, **kw):
    return soils.read_ascii_grid(asc(values, **kw).splitlines(True))


# Water content (10^-3 cm3/cm3, i.e. mm per m) per layer: field capacity 300, wilting point 150, so 150 mm/m everywhere.
FC = [300] * 6
WP = [150] * 6


class Pieces(unittest.TestCase):
    def test_reads_the_header_and_no_data(self):
        g = grid([[1, -9999], [3, 4]])
        self.assertEqual((g.ncols, g.nrows, g.xll, g.yll, g.cellsize), (2, 2, 20.0, -34.0, 0.5))
        self.assertEqual(g.values, [[1.0, None], [3.0, 4.0]])
        # Centre-registered headers are moved to the corner.
        c = soils.read_ascii_grid("ncols 1\nnrows 1\nxllcenter 20.25\nyllcenter -33.75\ncellsize 0.5\n7\n".splitlines(True))
        self.assertEqual((c.xll, c.yll), (20.0, -34.0))

    def test_refuses_a_grid_whose_values_dont_fit_the_header(self):
        with self.assertRaises(soils.GridError):
            soils.read_ascii_grid("ncols 2\nnrows 2\nxllcorner 0\nyllcorner 0\ncellsize 1\n1 2 3\n".splitlines(True))
        with self.assertRaises(soils.GridError):
            soils.read_ascii_grid("ncols 2\nnrows 1\ncellsize 1\n1 2\n".splitlines(True))

    def test_layer_thickness_inside_the_root_zone(self):
        self.assertEqual(soils.thickness_in_root_zone((30, 60), 200), 30)
        self.assertEqual(soils.thickness_in_root_zone((30, 60), 45), 15)
        self.assertEqual(soils.thickness_in_root_zone((60, 100), 45), 0)

    def test_cell_pawc_by_hand(self):
        # 150 mm/m over 200 cm: 300 mm.
        self.assertAlmostEqual(soils.cell_pawc(FC, WP, 200), 300.0)
        # Bedrock at 45 cm: 0.45 m x 150 = 67.5 mm, the 60-100 and 100-200 layers not read.
        self.assertAlmostEqual(soils.cell_pawc(FC, WP, 45), 67.5)
        self.assertAlmostEqual(soils.cell_pawc(FC[:4] + [None, None], WP, 45), 67.5)
        self.assertIsNone(soils.cell_pawc(FC[:4] + [None, None], WP, 200))
        # Layer by layer: (fc - wp) x thickness / 100, a negative difference counted as 0.
        fc = [350, 340, 330, 320, 310, 140]
        wp = [150, 150, 150, 150, 150, 150]
        expect = (200 * 5 + 190 * 10 + 180 * 15 + 170 * 30 + 160 * 40 + 0 * 100) / 100
        self.assertAlmostEqual(soils.cell_pawc(fc, wp, 200), expect)


class Cells(unittest.TestCase):
    def layers(self, fc_rows, wp_rows):
        return [grid(fc_rows)] * 6, [grid(wp_rows)] * 6

    def test_clips_to_the_region_and_takes_the_bedrock(self):
        # 2 x 2 cells of 0.5 deg from (20, -34): centres 20.25/20.75 E, -33.25/-33.75 S.
        fc, wp = self.layers([[300, 300], [300, 300]], [[150, 150], [150, 150]])
        bed = grid([[200, 45], [-9999, 0]])
        out = soils.soil_cells(fc, wp, bed, region=(20.0, -34.0, 21.0, -33.0))
        self.assertEqual(out.cells, [[20.25, -33.25, 300.0, 200.0], [20.75, -33.25, 67.5, 45.0], [20.25, -33.75, 300.0, 200.0]])
        self.assertEqual((out.no_value, out.at_surface, out.deep_assumed), (0, 1, 1))
        # A region holding only the western column.
        west = soils.soil_cells(fc, wp, bed, region=(20.0, -34.0, 20.5, -33.0))
        self.assertEqual([c[0] for c in west.cells], [20.25, 20.25])
        # Region D1 holds them all (20-21 E, 33-34 S).
        self.assertEqual(len(soils.soil_cells(fc, wp, bed).cells), 3)

    def test_leaves_out_a_cell_missing_a_layer_it_needs(self):
        fc, wp = self.layers([[300, -9999], [300, 300]], [[150, 150], [150, 150]])
        out = soils.soil_cells(fc, wp, grid([[200, 200], [200, 200]]))
        self.assertEqual(len(out.cells), 3)
        self.assertEqual(out.no_value, 1)

    def test_refuses_grids_on_different_frames(self):
        fc, wp = self.layers([[300, 300], [300, 300]], [[150, 150], [150, 150]])
        with self.assertRaises(soils.GridError):
            soils.soil_cells(fc, wp, grid([[200, 200], [200, 200]], xll=20.5))
        with self.assertRaises(soils.GridError):
            soils.soil_cells(fc[:5], wp, grid([[200, 200], [200, 200]]))


class Command(unittest.TestCase):
    def test_writes_the_json_the_backend_reads(self):
        with tempfile.TemporaryDirectory() as d:
            for prop, v in (("wv0033", 300), ("wv1500", 150)):
                os.makedirs(os.path.join(d, prop))
                for layer in soils.LAYERS_CM:
                    with open(soils.layer_file(os.path.join(d, prop), prop, layer), "w", encoding="ascii") as f:
                        f.write(asc([[v, v], [v, v]]))
            with open(os.path.join(d, "bedrock.asc"), "w", encoding="ascii") as f:
                f.write(asc([[200, 100], [50, 300]]))
            out = os.path.join(d, "soils.json.gz")
            code = soils.main(["--wv0033", os.path.join(d, "wv0033"), "--wv1500", os.path.join(d, "wv1500"), "--bedrock", os.path.join(d, "bedrock.asc"), "--out", out])
            self.assertEqual(code, 0)
            with gzip.open(out, "rt", encoding="utf-8") as f:
                doc = json.load(f)
            self.assertEqual(doc["kind"], "pawc")
            self.assertEqual(doc["cellDeg"], 0.5)
            self.assertIn("SoilGrids 2.0", doc["source"])
            self.assertIn("CC BY 4.0", doc["attribution"])
            self.assertEqual(doc["cells"], [[20.25, -33.25, 300.0, 200.0], [20.75, -33.25, 150.0, 100.0], [20.25, -33.75, 75.0, 50.0], [20.75, -33.75, 300.0, 200.0]])

    def test_a_missing_file_fails_with_a_reason(self):
        with tempfile.TemporaryDirectory() as d:
            code = soils.main(["--wv0033", d, "--wv1500", d, "--bedrock", os.path.join(d, "x.asc"), "--out", os.path.join(d, "o.json")])
            self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()
