"""penpan.py against McMahon et al. (2013) Supplement S19's Worked example 9
(PenPan at Alice Springs Airport, 20 July 1980) and its Worked examples 1-2
(the intermediate values), and the model's limits.

    ingest/.venv/bin/python -m unittest test_penpan   (from ingest/)
"""

import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import penpan  # noqa: E402

# Worked examples 1, 2 and 9 (S19): lat 23.7951 S, 546 m, Tmax 21.0, Tmin 2.0, RH 71/25 %,
# 51 km of wind run at 2 m (0.5903 m/s), Rs from 10.7 h of sunshine = 17.1940 MJ m-2 day-1.
LAT = -23.7951
Z = 546.0
EA = (0.7056 * 71 / 100 + 2.4870 * 25 / 100) / 2  # S19.9: 0.5614 kPa
RS = 17.1940
RA = 23.6182
U2 = 51 * 1000 / 86400


class WorkedExample(unittest.TestCase):
    def test_intermediate_values(self):
        self.assertAlmostEqual(penpan.sat_vapour_pressure(21.0), 2.4870, places=4)  # S19.4
        self.assertAlmostEqual(penpan.sat_vapour_pressure(2.0), 0.7056, places=4)  # S19.6
        self.assertAlmostEqual(EA, 0.5614, places=4)  # S19.9
        self.assertAlmostEqual(penpan.slope_vapour_pressure(11.5), 0.0898, places=4)  # S19.11
        self.assertAlmostEqual(penpan.pressure_from_elevation(Z), 95.01027, places=4)  # S19.13
        self.assertAlmostEqual(penpan.psychrometric(95.01027), 0.0632, places=4)  # S19.15
        self.assertAlmostEqual(penpan.extraterrestrial_radiation(LAT, 202), RA, places=3)  # S19.27 (day 202 of 1980)
        self.assertAlmostEqual(U2, 0.5903, places=4)

    def test_pan_radiation(self):
        self.assertAlmostEqual(penpan.pan_radiation_factor(LAT), 1.3748, places=4)  # S19.79
        self.assertAlmostEqual(penpan.direct_fraction(RS, RA), 0.8437, places=4)  # S19.81
        self.assertAlmostEqual(penpan.pan_shortwave(RS, RA, LAT, ground_albedo=0.26), 25.6375, places=3)  # S19.84
        self.assertAlmostEqual(penpan.f_pan(U2), 2.1578, places=4)  # S19.88

    def test_net_longwave(self):
        # S19.33 gives 7.1784 with 273.2 K; FAO-56 eq. 39 (and fao56.py) use 273.16: 7.174.
        rso = (0.75 + 2e-5 * Z) * RA
        self.assertAlmostEqual(rso, 17.9716, places=4)  # S19.29
        self.assertAlmostEqual(penpan.net_longwave(21.0, 2.0, EA, RS, rso), 7.1784, delta=0.005)

    def test_penpan_day(self):
        # S19.90: 2.2570 + 1.4027 = 3.6587 mm/day, unscreened (short grass round the pan, albedo 0.26).
        e = penpan.penpan_day(tmax_c=21.0, tmin_c=2.0, ea_kpa=EA, u2_ms=U2, rs=RS, ra=RA, p_kpa=penpan.pressure_from_elevation(Z), lat_deg=LAT, z_m=Z, ground_albedo=0.26)
        self.assertAlmostEqual(e, 3.6587, delta=0.005)
        # The elevation from the pressure, when not given, is the same 546 m.
        e2 = penpan.penpan_day(tmax_c=21.0, tmin_c=2.0, ea_kpa=EA, u2_ms=U2, rs=RS, ra=RA, p_kpa=penpan.pressure_from_elevation(Z), lat_deg=LAT, ground_albedo=0.26)
        self.assertAlmostEqual(e, e2, places=9)


class Pieces(unittest.TestCase):
    def test_f_pan_is_thoms_function_in_si_units(self):
        # Roderick et al. 2007 eq. 2: 1.39e-8 (1 + 1.35 u) kg m-2 s-1 Pa-1 -> mm day-1 kPa-1.
        for u in (0.0, 1.0, 3.5):
            self.assertAlmostEqual(1.39e-8 * (1 + 1.35 * u) * 86400 * 1000, penpan.f_pan(u), places=2)

    def test_wind_at_2m_fao56_eq47(self):
        # FAO-56 Example 14: 3.2 m/s at 10 m is 2.4 m/s at 2 m.
        self.assertAlmostEqual(penpan.wind_2m(3.2, 10.0), 2.4, places=1)
        self.assertAlmostEqual(penpan.wind_2m(2.0, 2.0), 2.0, places=2)

    def test_direct_fraction_is_kept_within_0_and_1(self):
        self.assertEqual(penpan.direct_fraction(1.0, 30.0), 0.0)
        self.assertEqual(penpan.direct_fraction(29.0, 30.0), 1.0)
        self.assertEqual(penpan.direct_fraction(5.0, 0.0), 0.0)

    def test_the_pan_beats_the_ground(self):
        # The walls catch radiation: Rs,pan > Rs (Roderick et al. 2007 § 2).
        self.assertGreater(penpan.pan_shortwave(25.0, 40.0, -30.0), 25.0)

    def test_nan_in_nan_out_and_no_negative(self):
        kw = dict(tmax_c=21.0, tmin_c=2.0, ea_kpa=EA, u2_ms=U2, rs=RS, ra=RA, p_kpa=95.0, lat_deg=LAT)
        self.assertTrue(math.isnan(penpan.penpan_day(**{**kw, "rs": math.nan})))
        # A clear, cold, saturated polar-winter day: the pan loses more longwave than it absorbs and the air
        # is saturated, so S6.1 is negative; kept at 0, never a negative evaporation.
        cold = dict(tmax_c=10.0, tmin_c=-5.0, u2_ms=0.0, rs=1.5, ra=2.0, p_kpa=95.0, lat_deg=-60.0)
        es = (penpan.sat_vapour_pressure(10.0) + penpan.sat_vapour_pressure(-5.0)) / 2
        self.assertEqual(penpan.penpan_day(**cold, ea_kpa=es), 0.0)


class Monthly(unittest.TestCase):
    def test_month_ra_is_the_mean_of_its_days(self):
        days = [penpan.extraterrestrial_radiation(-30.0, d) for d in range(32, 60)]  # February 2021
        self.assertAlmostEqual(penpan.month_ra(-30.0, 2021, 2), sum(days) / 28, places=9)
        # A leap year's February 29th is day 60.
        days = [penpan.extraterrestrial_radiation(-30.0, d) for d in range(32, 61)]
        self.assertAlmostEqual(penpan.month_ra(-30.0, 2020, 2), sum(days) / 29, places=9)

    def test_monthly_total_is_the_steady_state_day_times_the_days(self):
        kw = dict(tmax_c=30.0, tmin_c=15.0, ea_kpa=1.2, u2_ms=2.0, rs=26.0, p_kpa=90.0, lat_deg=-28.0)
        jan = penpan.monthly_mm(2021, 1, **kw)
        day = penpan.penpan_day(**kw, ra=penpan.month_ra(-28.0, 2021, 1))
        self.assertAlmostEqual(jan, day * 31, places=9)
        # A plausible Highveld-ish summer month: 200-350 mm of Class-A pan.
        self.assertTrue(200 < jan < 350, jan)
        # The bird screen takes 7 %.
        self.assertAlmostEqual(penpan.monthly_mm(2021, 1, **kw, screen=penpan.SCREEN_FACTOR), jan * 0.93, places=9)

    def test_more_wind_drier_air_and_more_sun_evaporate_more(self):
        kw = dict(tmax_c=25.0, tmin_c=10.0, ea_kpa=1.0, u2_ms=2.0, rs=20.0, p_kpa=90.0, lat_deg=-30.0)
        base = penpan.monthly_mm(2021, 3, **kw)
        self.assertGreater(penpan.monthly_mm(2021, 3, **{**kw, "u2_ms": 4.0}), base)
        self.assertGreater(penpan.monthly_mm(2021, 3, **{**kw, "ea_kpa": 0.6}), base)
        self.assertGreater(penpan.monthly_mm(2021, 3, **{**kw, "rs": 24.0}), base)


if __name__ == "__main__":
    unittest.main()
