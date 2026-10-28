"""FAO-56 Penman-Monteith reference evapotranspiration, daily (issue #604 R5-E).

NASA POWER publishes no reference ET, only the daily meteorology it needs, so
the `power_et0` fallback (nasapower.py) computes it here, by the book:
Allen, R.G., Pereira, L.S., Raes, D., Smith, M. (1998), *Crop
evapotranspiration*, FAO Irrigation and Drainage Paper 56, chapter 3 and 4.

    ET0 = (0.408 Δ (Rn - G) + γ 900/(T + 273) u2 (es - ea)) / (Δ + γ (1 + 0.34 u2))   (eq. 6)

with, for one day:
- T the mean of Tmax and Tmin (eq. 9), es the mean of e°(Tmax) and e°(Tmin)
  (eqs. 11–12), ea = e°(Tdew) (eq. 14), Δ at T (eq. 13);
- γ = 0.665e-3 P (eq. 8), P in kPa as POWER gives it (`PS`);
- the elevation z from P, eq. 7 turned round, for Rso only;
- Ra from the latitude and the day of the year (eqs. 21–25), Rso =
  (0.75 + 2e-5 z) Ra (eq. 37), Rns = (1 - 0.23) Rs (eq. 38, the reference
  grass's albedo), Rnl (eq. 39, Rs/Rso capped at 1), Rn = Rns - Rnl (eq. 40);
- G = 0 for a day (eq. 42);
- u2 the wind at 2 m (POWER's `WS2M`), Rs the day's solar radiation in
  MJ m-2 day-1 (POWER's `ALLSKY_SFC_SW_DWN` in the AG community).

A day's ET0 below 0 (a cold, humid, dark day can give a slightly negative
value) is kept at 0: the copy holds a loss, and every consumer treats a
negative as no evaporation anyway. Any NaN input gives NaN.

Pure numpy, vectorised over any common shape. Tested against FAO-56's own
worked examples (test_fao56.py: Example 8's Ra, Example 18's ET0).
"""

from __future__ import annotations

import numpy as np

#: Solar constant, MJ m-2 min-1 (eq. 21).
GSC = 0.0820
#: Stefan-Boltzmann constant, MJ K-4 m-2 day-1 (eq. 39).
SIGMA = 4.903e-9
#: The hypothetical reference grass's albedo (eq. 38).
ALBEDO = 0.23


def sat_vapour_pressure(t_c):
    """e°(T) in kPa (eq. 11)."""
    t = np.asarray(t_c, dtype=np.float64)
    return 0.6108 * np.exp(17.27 * t / (t + 237.3))


def slope_vapour_pressure(t_c):
    """Δ in kPa °C-1 at T (eq. 13)."""
    t = np.asarray(t_c, dtype=np.float64)
    return 4098.0 * sat_vapour_pressure(t) / (t + 237.3) ** 2


def elevation_from_pressure(p_kpa):
    """z in m from the surface pressure: eq. 7, P = 101.3 ((293 - 0.0065 z) / 293)^5.26, solved for z."""
    p = np.asarray(p_kpa, dtype=np.float64)
    return 293.0 / 0.0065 * (1.0 - (p / 101.3) ** (1.0 / 5.26))


def extraterrestrial_radiation(lat_deg, doy):
    """Ra in MJ m-2 day-1 (eqs. 21–25) for a latitude (degrees, south negative) and day of the year (1–366)."""
    phi = np.radians(np.asarray(lat_deg, dtype=np.float64))
    j = np.asarray(doy, dtype=np.float64)
    dr = 1.0 + 0.033 * np.cos(2.0 * np.pi * j / 365.0)
    delta = 0.409 * np.sin(2.0 * np.pi * j / 365.0 - 1.39)
    ws = np.arccos(np.clip(-np.tan(phi) * np.tan(delta), -1.0, 1.0))
    return 24.0 * 60.0 / np.pi * GSC * dr * (ws * np.sin(phi) * np.sin(delta) + np.cos(phi) * np.cos(delta) * np.sin(ws))


def net_radiation(tmax_c, tmin_c, ea_kpa, rs, ra, z_m):
    """Rn in MJ m-2 day-1 (eqs. 37–40)."""
    rso = (0.75 + 2e-5 * np.asarray(z_m, dtype=np.float64)) * ra
    rs = np.asarray(rs, dtype=np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = np.where(rso > 0, np.minimum(rs / rso, 1.0), np.nan)
    tk4 = ((np.asarray(tmax_c, dtype=np.float64) + 273.16) ** 4 + (np.asarray(tmin_c, dtype=np.float64) + 273.16) ** 4) / 2.0
    rnl = SIGMA * tk4 * (0.34 - 0.14 * np.sqrt(np.asarray(ea_kpa, dtype=np.float64))) * (1.35 * ratio - 0.35)
    return (1.0 - ALBEDO) * rs - rnl


def et0_from_ea(tmax_c, tmin_c, ea_kpa, u2_ms, rs, p_kpa, lat_deg, doy):
    """Daily ET0 in mm (eq. 6), with the actual vapour pressure given directly."""
    tmax = np.asarray(tmax_c, dtype=np.float64)
    tmin = np.asarray(tmin_c, dtype=np.float64)
    ea = np.asarray(ea_kpa, dtype=np.float64)
    u2 = np.asarray(u2_ms, dtype=np.float64)
    p = np.asarray(p_kpa, dtype=np.float64)
    t = (tmax + tmin) / 2.0
    es = (sat_vapour_pressure(tmax) + sat_vapour_pressure(tmin)) / 2.0
    delta = slope_vapour_pressure(t)
    gamma = 0.665e-3 * p
    ra = extraterrestrial_radiation(lat_deg, doy)
    rn = net_radiation(tmax, tmin, ea, rs, ra, elevation_from_pressure(p))
    et0 = (0.408 * delta * rn + gamma * 900.0 / (t + 273.0) * u2 * (es - ea)) / (delta + gamma * (1.0 + 0.34 * u2))
    return np.where(np.isnan(et0), np.nan, np.maximum(et0, 0.0))


def et0(tmax_c, tmin_c, tdew_c, u2_ms, rs, p_kpa, lat_deg, doy):
    """Daily ET0 in mm from POWER's daily meteorology: Tmax, Tmin, Tdew (°C),
    u2 (m/s), Rs (MJ m-2 day-1), P (kPa), at a latitude on a day of the year."""
    return et0_from_ea(tmax_c, tmin_c, sat_vapour_pressure(tdew_c), u2_ms, rs, p_kpa, lat_deg, doy)
