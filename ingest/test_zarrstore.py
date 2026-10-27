"""zarrstore.py: the D2 layouts' metadata and where a cell-day lands, locally and through S3 staging.

    ingest/.venv/bin/python -m unittest discover -s ingest
"""

import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import grid  # noqa: E402
import zarrstore  # noqa: E402
from fakes3 import FakeS3  # noqa: E402


def zeros(days):
    return np.full((days, grid.ROWS, grid.COLS), np.nan, dtype=np.float32)


def open_array(root, product):
    import zarr

    return zarr.open_array(store=zarr.storage.LocalStore(root), path=product, mode="r", zarr_format=3)


class Grid(unittest.TestCase):
    def test_region_is_550_by_620_from_the_south_west(self):
        self.assertEqual((grid.row_index(-35.475), grid.col_index(10.025)), (0, 0))
        self.assertEqual((grid.row_index(-8.025), grid.col_index(40.975)), (549, 619))
        # CHC's float32 coordinates still land on the right cell.
        self.assertEqual(grid.col_index(float(np.float32(10.024994))), 0)
        self.assertEqual(grid.row_index(-33.925), 31)
        with self.assertRaises(ValueError):
            grid.row_index(-35.53)
        with self.assertRaises(ValueError):
            grid.col_index(41.02)

    def test_doy_leap_and_non_leap(self):
        self.assertEqual(grid.doy_index(dt.date(2024, 1, 1)), 0)
        self.assertEqual(grid.doy_index(dt.date(2023, 3, 1)), 59)
        self.assertEqual(grid.doy_index(dt.date(2024, 2, 29)), 59)
        self.assertEqual(grid.doy_index(dt.date(2024, 3, 1)), 60)
        self.assertEqual(grid.doy_index(dt.date(2023, 12, 31)), 364)
        self.assertEqual(grid.doy_index(dt.date(2024, 12, 31)), 365)

    def test_spans_split_at_the_year_boundary(self):
        self.assertEqual(zarrstore.finals_spans(dt.date(2023, 12, 30), 4), [(2023, 363, 365, 0), (2024, 0, 2, 2)])
        self.assertEqual(
            zarrstore.finals_year_prefixes("rnl", dt.date(2023, 12, 30), 4), ["rnl/zarr.json", "rnl/c/42/", "rnl/c/43/"]
        )


class Finals(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_metadata_is_exactly_d2(self):
        zarrstore.write_finals(self.root, "rnl", dt.date(1981, 1, 1), zeros(1) + 1)
        meta = json.loads((self.root / "rnl" / "zarr.json").read_text())
        self.assertEqual(meta["shape"], [1, 366, 550, 620])
        self.assertEqual(meta["data_type"], "float32")
        self.assertEqual(meta["chunk_grid"]["configuration"]["chunk_shape"], [1, 366, 20, 20])
        self.assertEqual(meta["chunk_key_encoding"], {"name": "default", "configuration": {"separator": "/"}})
        self.assertEqual(meta["fill_value"], "NaN")
        self.assertEqual(meta["codecs"], [{"name": "bytes", "configuration": {"endian": "little"}}, {"name": "gzip", "configuration": {"level": 6}}])
        self.assertEqual(meta["dimension_names"], ["year", "doy", "lat", "lon"])
        self.assertEqual(
            meta["attributes"],
            {"firstYear": 1981, "region": {"w": 10.0, "s": -35.5, "e": 41.0, "n": -8.0}, "grid": {"origin": {"lat": -35.475, "lon": 10.025}, "step": 0.05}},
        )
        self.assertTrue((self.root / "zarr.json").exists())  # the hierarchy's root group

    def test_a_known_cell_day_lands_at_its_index_leap_and_non_leap(self):
        # Two days across New Year 2023/24, then 29 Feb 2024.
        v = zeros(2)
        v[0, 31, 177] = 4.5  # 2023-12-31, lat -33.925 lon 18.875
        v[1, 549, 619] = 2.0  # 2024-01-01, the north-east corner
        zarrstore.write_finals(self.root, "rnl", dt.date(2023, 12, 31), v)
        leap = zeros(1)
        leap[0, 0, 0] = 7.25
        zarrstore.write_finals(self.root, "rnl", dt.date(2024, 2, 29), leap)

        a = open_array(self.root, "rnl")
        self.assertEqual(a.shape, (44, 366, 550, 620))
        self.assertEqual(a[42, 364, 31, 177], np.float32(4.5))
        self.assertEqual(a[43, 0, 549, 619], np.float32(2.0))
        self.assertEqual(a[43, 59, 0, 0], np.float32(7.25))
        self.assertTrue(np.isnan(a[42, 365, 31, 177]))  # no 366th day in 2023
        self.assertTrue(np.isnan(a[43, 60, 0, 0]))
        # The chunk files sit where the D2 key says: c/<year>/0/<lat chunk>/<lon chunk>.
        self.assertTrue((self.root / "rnl/c/42/0/1/8").exists())  # row 31 -> 1, col 177 -> 8
        self.assertTrue((self.root / "rnl/c/43/0/27/30").exists())
        self.assertTrue((self.root / "rnl/c/43/0/0/0").exists())

    def test_all_nan_chunks_are_not_written_and_other_days_are_kept(self):
        v = zeros(1)
        v[0, 0, 0] = 1.0
        zarrstore.write_finals(self.root, "rnl", dt.date(2000, 6, 1), v)
        v2 = zeros(1)
        v2[0, 0, 1] = 3.0
        zarrstore.write_finals(self.root, "rnl", dt.date(2000, 6, 2), v2)
        chunks = sorted(p.relative_to(self.root).as_posix() for p in (self.root / "rnl" / "c").rglob("*") if p.is_file())
        self.assertEqual(chunks, ["rnl/c/19/0/0/0"])
        a = open_array(self.root, "rnl")
        self.assertEqual(a[19, zarrstore.grid.doy_index(dt.date(2000, 6, 1)), 0, 0], np.float32(1.0))
        self.assertEqual(a[19, zarrstore.grid.doy_index(dt.date(2000, 6, 2)), 0, 1], np.float32(3.0))

    def test_read_finals_returns_what_was_written(self):
        self.assertIsNone(zarrstore.read_finals(self.root, "rnl", dt.date(2024, 1, 1), 1))
        v = zeros(3)
        v[:, 10, 10] = [1, 2, 3]
        zarrstore.write_finals(self.root, "sat", dt.date(2023, 12, 31), v)
        back = zarrstore.read_finals(self.root, "sat", dt.date(2023, 12, 31), 3)
        np.testing.assert_array_equal(back, v)

    def test_refuses_the_wrong_shape(self):
        with self.assertRaises(ValueError):
            zarrstore.write_finals(self.root, "rnl", dt.date(2024, 1, 1), np.zeros((1, 10, 10), np.float32))


class Daily(unittest.TestCase):
    def test_daily_layout_and_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            v = zeros(2)
            v[1, 109, 123] = 5.0
            zarrstore.write_daily(root, "prelim", dt.date(2026, 10, 2), v, array_first_day=dt.date(2026, 10, 1))
            meta = json.loads((root / "prelim" / "zarr.json").read_text())
            self.assertEqual(meta["shape"], [3, 550, 620])
            self.assertEqual(meta["chunk_grid"]["configuration"]["chunk_shape"], [1, 110, 124])
            self.assertEqual(meta["dimension_names"], ["day", "lat", "lon"])
            self.assertEqual(meta["attributes"]["firstDay"], "2026-10-01")
            self.assertTrue((root / "prelim/c/2/0/0").exists())
            zarrstore.write_daily(root, "prelim", dt.date(2026, 10, 5), zeros(1) + 1)
            self.assertEqual(open_array(root, "prelim").shape, (5, 550, 620))
            with self.assertRaises(ValueError):
                zarrstore.write_daily(root, "prelim", dt.date(2026, 9, 30), zeros(1))


class ProductGrids(unittest.TestCase):
    """Each product's grid (grid.for_product), as backend/src/mirror/grid.ts PRODUCT_GRIDS has it."""

    def test_the_registry(self):
        self.assertIs(grid.for_product("rnl"), grid.CHC)
        self.assertIs(grid.for_product("prelim"), grid.CHC)
        self.assertIs(grid.for_product("gefs/2026-02-09"), grid.CHC)
        self.assertEqual((grid.CHC.step, grid.CHC.origin, grid.CHC.rows, grid.CHC.cols), (grid.STEP, grid.ORIGIN, grid.ROWS, grid.COLS))
        for product in ("era5l", "imerg_late", "ecmwf/2026-02-09"):
            g = grid.for_product(product)
            self.assertEqual((g.step, g.origin, g.rows, g.cols, g.daily_chunks), (0.1, {"lat": -35.45, "lon": 10.05}, 275, 310, (1, 55, 62)), product)
        self.assertEqual(grid.for_product("era5l").first_year, 1950)
        self.assertEqual(grid.for_product("sat").first_year, 1981)
        for bad in ("nope", "gefs/latest", "ecmwf/"):
            with self.assertRaises(ValueError, msg=bad):
                grid.for_product(bad)
        # 25 daily chunks a day on either grid.
        for g in (grid.CHC, grid.TENTH):
            self.assertEqual(-(-g.rows // g.daily_chunks[1]) * -(-g.cols // g.daily_chunks[2]), 25)

    def test_tenth_indices_corners(self):
        g = grid.TENTH
        self.assertEqual((g.row_index(-35.45), g.col_index(10.05)), (0, 0))
        self.assertEqual((g.row_index(-8.05), g.col_index(40.95)), (274, 309))
        with self.assertRaises(ValueError):
            g.row_index(-35.55)
        with self.assertRaises(ValueError):
            g.col_index(41.05)

    def test_era5l_finals_and_imerg_daily_on_the_tenth_grid(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            v = np.full((1, 275, 310), np.nan, dtype=np.float32)
            v[0, 274, 309] = 3.5
            zarrstore.write_finals(root, "era5l", dt.date(2024, 2, 29), v)
            meta = json.loads((root / "era5l" / "zarr.json").read_text())
            self.assertEqual(meta["shape"], [75, 366, 275, 310])
            self.assertEqual(meta["chunk_grid"]["configuration"]["chunk_shape"], [1, 366, 20, 20])
            self.assertEqual(meta["attributes"]["firstYear"], 1950)
            self.assertEqual(meta["attributes"]["grid"], {"origin": {"lat": -35.45, "lon": 10.05}, "step": 0.1})
            self.assertEqual(open_array(root, "era5l")[74, 59, 274, 309], np.float32(3.5))
            np.testing.assert_array_equal(zarrstore.read_finals(root, "era5l", dt.date(2024, 2, 29), 1), v)
            # CHC's shape is refused for a 0.1 deg product.
            with self.assertRaises(ValueError):
                zarrstore.write_finals(root, "era5l", dt.date(2024, 3, 1), zeros(1))

            d = np.full((1, 275, 310), np.nan, dtype=np.float32)
            d[0, 54, 61] = 1.25
            zarrstore.write_daily(root, "imerg_late", dt.date(2026, 2, 8), d, array_first_day=dt.date(2026, 2, 1))
            meta = json.loads((root / "imerg_late" / "zarr.json").read_text())
            self.assertEqual(meta["shape"], [8, 275, 310])
            self.assertEqual(meta["chunk_grid"]["configuration"]["chunk_shape"], [1, 55, 62])
            self.assertEqual(meta["attributes"]["grid"]["step"], 0.1)
            self.assertTrue((root / "imerg_late/c/7/0/0").exists())
            zarrstore.write_daily(root, "imerg_late", dt.date(2026, 2, 9), d)
            self.assertEqual(open_array(root, "imerg_late").shape, (9, 275, 310))

    def test_an_array_on_another_grid_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            zarrstore.write_daily(root, "prelim", dt.date(2026, 2, 1), zeros(1))
            # prelim's 0.05 deg array where imerg_late's should be.
            (root / "imerg_late").mkdir()
            (root / "imerg_late" / "zarr.json").write_text((root / "prelim" / "zarr.json").read_text())
            with self.assertRaises(ValueError):
                zarrstore.write_daily(root, "imerg_late", dt.date(2026, 2, 1), np.zeros((1, 275, 310), np.float32))


class S3Staging(unittest.TestCase):
    def test_writes_go_up_and_only_changed_objects_move(self):
        s3 = FakeS3()
        mirror = zarrstore.Mirror.from_url("s3://bucket/env", s3_client=s3)
        v = zeros(1)
        v[0, 0, 0] = 1.0
        v[0, 100, 100] = 2.0
        day = dt.date(2024, 2, 29)
        with mirror.stage(zarrstore.finals_year_prefixes("rnl", day, 1)) as root:
            zarrstore.write_finals(root, "rnl", day, v)
        self.assertEqual(s3.keys("bucket"), ["env/rnl/c/43/0/0/0", "env/rnl/c/43/0/5/5", "env/rnl/zarr.json", "env/zarr.json"])

        # Rewrite one cell and clear the other: one chunk changes, one is deleted, metadata stays.
        s3.calls.clear()
        v2 = zeros(1)
        v2[0, 0, 0] = 9.0
        with mirror.stage(zarrstore.finals_year_prefixes("rnl", day, 1)) as root:
            zarrstore.write_finals(root, "rnl", day, v2)
        writes = [c for c in s3.calls if c[0] != "get"]
        self.assertEqual(writes, [("put", "env/rnl/c/43/0/0/0"), ("delete", "env/rnl/c/43/0/5/5")])

    def test_json_documents(self):
        s3 = FakeS3()
        mirror = zarrstore.Mirror.from_url("s3://bucket", s3_client=s3)
        self.assertIsNone(mirror.read_json("rnl/manifest.json"))
        mirror.write_json("rnl/manifest.json", {"a": 1})
        self.assertEqual(mirror.read_json("rnl/manifest.json"), {"a": 1})
        self.assertEqual(s3.keys("bucket"), ["rnl/manifest.json"])

    def test_mirror_urls(self):
        self.assertIsInstance(zarrstore.Mirror.from_url("file:///tmp/x"), zarrstore.LocalMirror)
        for bad in ["file://relative/x", "s3://", "https://x", "/tmp/x"]:
            with self.assertRaises(ValueError, msg=bad):
                zarrstore.Mirror.from_url(bad, s3_client=FakeS3())


if __name__ == "__main__":
    unittest.main()
