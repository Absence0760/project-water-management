"""fao56.py against FAO-56's own worked examples (Allen et al. 1998).

    ingest/.venv/bin/python -m unittest test_fao56   (from ingest/)
"""

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fao56  # noqa: E402


class Pieces(unittest.TestCase):
    def test_example_8_extraterrestrial_radiation(self):
        # 20° S on 3 September (day 246): Ra = 32.2 MJ m-2 day-1.
        self.assertAlmostEqual(float(fao56.extraterrestrial_radiation(-20.0, 246)), 32.2, places=1)

    def test_example_18_ra_and_the_elevation_from_pressure(self):
        # Uccle, 50°48' N, 6 July (day 187): Ra = 41.09; 100 m is 100.1 kPa (eq. 7).
        self.assertAlmostEqual(float(fao56.extraterrestrial_radiation(50.8, 187)), 41.09, places=1)
        p100 = 101.3 * ((293 - 0.0065 * 100) / 293) ** 5.26  # eq. 7 at 100 m: 100.1 kPa as FAO-56 rounds it
        self.assertAlmostEqual(p100, 100.1, places=1)
        self.assertAlmostEqual(float(fao56.elevation_from_pressure(p100)), 100.0, places=6)
        self.assertAlmostEqual(float(fao56.elevation_from_pressure(101.3)), 0.0, places=6)

    def test_vapour_pressure(self):
        # Example 3: e°(24.5) = 3.075; e°(15) = 1.705.
        self.assertAlmostEqual(float(fao56.sat_vapour_pressure(24.5)), 3.075, places=3)
        self.assertAlmostEqual(float(fao56.sat_vapour_pressure(15.0)), 1.705, places=3)


def dew_point(ea_kpa: float) -> float:
    """The Tdew whose e° is `ea` (eq. 11 inverted)."""
    x = np.log(ea_kpa / 0.6108)
    return float(237.3 * x / (17.27 - x))


class Example18(unittest.TestCase):
    """Uccle (Brussels), 6 July: Tmax 21.5, Tmin 12.3, ea 1.409 kPa, u2 2.078
    m/s, Rs 22.07 MJ m-2 day-1, 100 m: Rn = 13.28 and ET0 = 3.9 mm/day."""

    ARGS = dict(tmax_c=21.5, tmin_c=12.3, u2_ms=2.078, rs=22.07, p_kpa=100.1, lat_deg=50.8, doy=187)

    def test_net_radiation(self):
        ra = fao56.extraterrestrial_radiation(50.8, 187)
        rn = fao56.net_radiation(21.5, 12.3, 1.409, 22.07, ra, 100.0)
        self.assertAlmostEqual(float(rn), 13.28, delta=0.05)

    def test_et0_from_ea_and_from_the_dew_point(self):
        self.assertAlmostEqual(float(fao56.et0_from_ea(ea_kpa=1.409, **self.ARGS)), 3.9, delta=0.05)
        self.assertAlmostEqual(float(fao56.et0(tdew_c=dew_point(1.409), **self.ARGS)), 3.9, delta=0.05)


class Arrays(unittest.TestCase):
    def test_vectorised_with_nan_passing_through_and_no_negative(self):
        tmax = np.array([21.5, np.nan, 2.0])
        out = fao56.et0(tmax, np.array([12.3, 12.3, 1.0]), np.array([dew_point(1.409)] * 2 + [1.9]), np.array([2.078, 2.078, 0.0]), np.array([22.07, 22.07, 0.5]), 100.1, np.array([50.8, 50.8, 60.0]), 355)
        self.assertEqual(out.shape, (3,))
        self.assertTrue(np.isnan(out[1]))
        self.assertGreaterEqual(float(out[2]), 0.0, "a dark, humid winter day never goes negative")


if __name__ == "__main__":
    unittest.main()
