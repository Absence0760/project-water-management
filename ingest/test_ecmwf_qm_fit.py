"""ecmwf_qm_fit.py: the offline quantile-mapping fit, on synthetic data only
(no archive exists yet; issue #604 R4-C).

    ingest/.venv/bin/python -m unittest test_ecmwf_qm_fit
"""

import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import ecmwf_forecast  # noqa: E402
import ecmwf_qm_fit as qm  # noqa: E402
import zarrstore  # noqa: E402


def gamma_rain(rng, n, wet=0.4, shape=0.7, scale=8.0):
    """Synthetic daily rain: dry days, then gamma-distributed totals."""
    return np.where(rng.random(n) < wet, rng.gamma(shape, scale, n), 0.0)


class Pairs(unittest.TestCase):
    def test_maps_a_doubled_forecast_back_to_the_observations(self):
        rng = np.random.default_rng(1)
        obs = gamma_rain(rng, 200_000)
        fc = 2.0 * gamma_rain(rng, 200_000)
        pairs = qm.fit_pairs(fc, obs)
        fs, os_ = [p[0] for p in pairs], [p[1] for p in pairs]
        self.assertTrue(all(b > a for a, b in zip(fs, fs[1:])), "f strictly increasing")
        self.assertTrue(all(b >= a for a, b in zip(os_, os_[1:])), "o non-decreasing")
        self.assertEqual(pairs[0], [0.0, 0.0])  # the dry days collapse into one pair
        for x in (2.0, 10.0, 30.0):
            self.assertAlmostEqual(qm.apply(pairs, x), x / 2, delta=0.06 * x + 0.2)

    def test_identity_when_the_distributions_agree(self):
        rng = np.random.default_rng(2)
        a = gamma_rain(rng, 100_000)
        pairs = qm.fit_pairs(a, a)
        for x in (0.0, 1.0, 5.0, 20.0):
            self.assertAlmostEqual(qm.apply(pairs, x), x, delta=0.01)

    def test_apply_beyond_the_pairs(self):
        pairs = [[0.0, 0.0], [10.0, 6.0], [20.0, 14.0]]
        self.assertAlmostEqual(qm.apply(pairs, 15.0), 10.0)
        self.assertAlmostEqual(qm.apply(pairs, 50.0), 44.0)  # the last offset (-6) carried on
        self.assertAlmostEqual(qm.apply([[2.0, 1.0], [4.0, 3.0]], 1.0), 0.5)  # below the first: scaled towards 0
        self.assertAlmostEqual(qm.apply([[0.0, 0.5], [4.0, 3.0]], 0.0), 0.5)
        self.assertEqual(qm.apply([[0.0, 0.0], [1.0, 0.0]], 0.5), 0.0)
        self.assertEqual(qm.apply([], 7.0), 7.0)  # no pairs: identity
        self.assertEqual(qm.apply([[1.0, 0.0], [2.0, 1.0]], 3.0 - 9.0), 0.0)  # never below 0

    def test_seasons(self):
        self.assertEqual([qm.season_of(m) for m in (12, 1, 3, 6, 9, 11)], ["DJF", "DJF", "MAM", "JJA", "SON", "SON"])


class Fit(unittest.TestCase):
    """A small copy: forecasts archived as their mean, and `sat` finals for the same days, the forecast twice the rain."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        mirror = zarrstore.LocalMirror(self.root)
        rng = np.random.default_rng(3)
        first = dt.date(2026, 1, 5)
        issues = [first + dt.timedelta(days=i) for i in range(3)]
        days = (issues[-1] - first).days + ecmwf_forecast.DAYS
        obs = gamma_rain(rng, days * 550 * 620).reshape(days, 550, 620).astype(np.float32)
        obs[:, 500:, 600:] = np.nan  # sea, as CHIRPS has it
        zarrstore.write_finals(self.root, "sat", first, obs)
        coarse = obs.reshape(days, 275, 2, 310, 2).mean(axis=(2, 4))
        for i, issue in enumerate(issues):
            v = np.zeros((4, ecmwf_forecast.DAYS, ecmwf_forecast.ROWS, ecmwf_forecast.COLS), np.float32)
            v[0] = 2.0 * coarse[i : i + ecmwf_forecast.DAYS]
            ecmwf_forecast.write_issue(mirror, issue, np.nan_to_num(v), 50)
        ecmwf_forecast.write_index(mirror, [issues[-1].isoformat()], [d.isoformat() for d in issues[:-1]])
        self.issues = issues

    def tearDown(self):
        self.tmp.cleanup()

    def test_fits_per_season_with_its_provenance(self):
        doc = qm.fit(self.root, stride=3, min_samples=1000, fitted_at="2026-10-27T10:00:00Z")
        self.assertEqual((doc["v"], doc["product"], doc["stat"], doc["fittedAt"]), (1, "ecmwf", "mean", "2026-10-27T10:00:00Z"))
        self.assertEqual(doc["forecasts"], {"issues": 3, "first": "2026-01-05", "last": "2026-01-07"})
        self.assertEqual([g["id"] for g in doc["groups"]], ["D1-DJF"])  # January only
        g = doc["groups"][0]
        self.assertEqual(g["months"], [12, 1, 2])
        self.assertGreater(g["samples"], 1000)
        # Twice the rain maps back to the rain (the 2x2 mean of gamma days is smoother, so a loose tolerance).
        for x in (2.0, 8.0):
            self.assertAlmostEqual(qm.apply(g["pairs"], x), x / 2, delta=0.15 * x + 0.2)

    def test_min_samples_leaves_a_thin_group_out_and_main_writes_the_file(self):
        self.assertEqual(qm.fit(self.root, stride=3, min_samples=10**9)["groups"], [])
        self.assertEqual(qm.main(["--copy", str(self.root), "--cell-stride", "3", "--min-samples", str(10**9)]), 1)
        self.assertFalse((self.root / ecmwf_forecast.QM_KEY).exists())
        self.assertEqual(qm.main(["--copy", str(self.root), "--cell-stride", "3", "--min-samples", "1000", "--scale", "1.1"]), 0)
        doc = json.loads((self.root / ecmwf_forecast.QM_KEY).read_text())
        self.assertEqual(doc["observed"], {"product": "sat", "fallback": "prelim", "scale": 1.1})
        self.assertEqual(len(doc["groups"]), 1)

    def test_days_with_no_observation_are_skipped(self):
        # With no observed rain in the copy no forecast day has a pair, so nothing is fitted.
        import shutil

        shutil.rmtree(self.root / "sat")
        doc = qm.fit(self.root, stride=3, min_samples=1)
        self.assertEqual((doc["forecasts"]["issues"], doc["groups"]), (0, []))


if __name__ == "__main__":
    unittest.main()
