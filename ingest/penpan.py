"""PenPan: a modelled US Class-A pan's evaporation from weather (issue #646
item 7; docs/maps.md § The evaporation grid, docs/model.md §2.3a).

Standard library only. Operator-run (apan_grid.py), never by the app or the
ingest Lambda.

**The model** is PenPan (Rotstayn, L.D., Roderick, M.L., Farquhar, G.D.
2006, *A simple pan-evaporation model for analysis of climate simulations:
evaluation over Australia*, Geophys. Res. Lett. 33, L17715,
doi:10.1029/2006GL027114): Penman's combination equation set up for the pan
itself, with Linacre's (1994) radiation on a Class-A pan (its walls catch
radiation the ground doesn't) and Thom et al.'s (1981) vapour transfer for
it. We follow it step by step as McMahon, T.A., Peel, M.C., Lowe, L.,
Srikanthan, R., McVicar, T.R. (2013), *Estimating actual, potential,
reference crop and pan evaporation using standard meteorological data: a
pragmatic synthesis*, HESS 17, 1331-1363, Supplement S6 (equations S6.1 to
S6.6, the net longwave by S3.3 to S3.8) write it, and check against its
Worked example 9 (Alice Springs, 20 July 1980: 3.6587 mm/day, test_penpan.py):

    E = Δ/(Δ + a γ) × Rn,pan/λ + a γ/(Δ + a γ) × f_pan(u2) × (es - ea)        (S6.1)
    f_pan(u2) = 1.201 + 1.621 u2   (mm day-1 kPa-1)                              (S6.2)
    Rn,pan = (1 - α_A) Rs,pan - Rnl                                              (S6.3)
    Rs,pan = [f_dir P_rad + 1.42 (1 - f_dir) + 0.42 α_s] Rs                      (S6.4)
    f_dir = -0.11 + 1.31 Rs/Ra                                                   (S6.5)
    P_rad = 1.32 + 4e-4 |lat| + 8e-5 lat²                                        (S6.6)

with a = 2.4 (the ratio of the pan's effective areas for heat and vapour
transfer), α_A = 0.14 (the pan's albedo, Linacre 1992), α_s the albedo of the
ground round the pan, λ = 2.45 MJ kg-1, Δ at the mean temperature and Rnl
FAO-56's net outgoing longwave (S3.3, FAO-56 eq. 39). Roderick et al. (2007,
GRL 34, L17403, eqs. 1-3) give the same model in SI units: f_q(u) = 1.39e-8
(1 + 1.35 u) kg m-2 s-1 Pa-1, which is S6.2 once multiplied by 86 400 s and
1 000 Pa/kPa (`test_f_pan_is_thoms_function_in_si_units`).

**Our choices, beyond the papers** (each one recorded in the grid's method
text, apan_grid.METHOD):
- f_dir is kept within 0-1. S6.5 leaves it open; a month whose Rs/Ra is below
  0.084 or above 0.847 would otherwise have a negative or more-than-whole
  direct share.
- The output is the **unscreened** pan (S6.1's E). A pan under a bird screen
  loses about 7 % less (McMahon S16: × 0.93); `screen` applies a factor when
  the stations it stands in for are screened.
- The default ground albedo is 0.23, FAO-56's reference grass, the surface a
  pan station stands on (McMahon's worked example takes 0.26 for short grass,
  their Table S3).
- A negative result (a dark, humid, cold month) is 0.

**Time step.** PenPan assumes a steady energy balance, which a Class-A pan
reaches over about a week (Roderick et al. 2007 § 2; McMahon S6: "carried out
on a monthly time-step"): `monthly_mm` takes a month's mean daily weather and
returns the month's total. PenPan-V2 (Lim, Roderick, Farquhar 2016, J. Hydrol.
540, 641-658), which adds the pan's wall heat exchange for monthly
steady-state use, is **not** implemented: its equations could not be confirmed
from a readable copy of the paper (docs/followups.md, issue #646).
"""

from __future__ import annotations

import calendar
import math

#: The ratio of the pan's effective surface areas for heat and vapour transfer (S6.1; Roderick et al. 2007 eq. 1).
A_P = 2.4
#: A Class-A pan's albedo (S6.3; Linacre 1992, as Rotstayn et al. 2006 take it).
ALBEDO_PAN = 0.14
#: The albedo of the ground round the pan (S6.4): FAO-56's reference grass.
ALBEDO_GROUND = 0.23
#: Latent heat of vaporisation, MJ kg-1 (McMahon S19's constant).
LAMBDA = 2.45
#: Stefan-Boltzmann, MJ K-4 m-2 day-1 (S3.3).
SIGMA = 4.903e-9
#: Solar constant, MJ m-2 min-1 (S3.5).
GSC = 0.0820
#: McMahon S16's bird-screen factor, for a screened pan.
SCREEN_FACTOR = 0.93


def sat_vapour_pressure(t_c: float) -> float:
    """e°(T) in kPa (FAO-56 eq. 11; McMahon S2.5)."""
    return 0.6108 * math.exp(17.27 * t_c / (t_c + 237.3))


def slope_vapour_pressure(t_c: float) -> float:
    """Δ in kPa °C-1 at T (FAO-56 eq. 13; McMahon S2.4)."""
    return 4098.0 * sat_vapour_pressure(t_c) / (t_c + 237.3) ** 2


def psychrometric(p_kpa: float) -> float:
    """γ in kPa °C-1 (McMahon S2.9: 0.00163 P/λ, FAO-56 eq. 8's 0.665e-3 P)."""
    return 0.00163 * p_kpa / LAMBDA


def pressure_from_elevation(z_m: float) -> float:
    """P in kPa at z m (FAO-56 eq. 7; McMahon S2.10)."""
    return 101.3 * ((293.0 - 0.0065 * z_m) / 293.0) ** 5.26


def elevation_from_pressure(p_kpa: float) -> float:
    """z in m from P: FAO-56 eq. 7 solved for z (as fao56.elevation_from_pressure)."""
    return 293.0 / 0.0065 * (1.0 - (p_kpa / 101.3) ** (1.0 / 5.26))


def wind_2m(u_z: float, z_m: float) -> float:
    """The wind at 2 m from a wind measured at z m (FAO-56 eq. 47)."""
    return u_z * 4.87 / math.log(67.8 * z_m - 5.42)


def extraterrestrial_radiation(lat_deg: float, doy: int) -> float:
    """Ra in MJ m-2 day-1 (S3.5-S3.8; FAO-56 eqs. 21-25), latitude south negative."""
    phi = math.radians(lat_deg)
    dr = 1.0 + 0.033 * math.cos(2.0 * math.pi * doy / 365.0)
    delta = 0.409 * math.sin(2.0 * math.pi * doy / 365.0 - 1.39)
    ws = math.acos(max(-1.0, min(1.0, -math.tan(phi) * math.tan(delta))))
    return 24.0 * 60.0 / math.pi * GSC * dr * (ws * math.sin(phi) * math.sin(delta) + math.cos(phi) * math.cos(delta) * math.sin(ws))


def month_ra(lat_deg: float, year: int, month: int) -> float:
    """The month's mean daily Ra, MJ m-2 day-1 (the mean of its days' S3.5)."""
    first = (calendar.timegm((year, month, 1, 0, 0, 0)) - calendar.timegm((year, 1, 1, 0, 0, 0))) // 86400 + 1
    days = calendar.monthrange(year, month)[1]
    return sum(extraterrestrial_radiation(lat_deg, first + k) for k in range(days)) / days


def net_longwave(tmax_c: float, tmin_c: float, ea_kpa: float, rs: float, rso: float) -> float:
    """Rnl, the net outgoing longwave, MJ m-2 day-1 (S3.3; FAO-56 eq. 39), Rs/Rso at most 1."""
    ratio = min(rs / rso, 1.0) if rso > 0 else 1.0
    tk4 = ((tmax_c + 273.16) ** 4 + (tmin_c + 273.16) ** 4) / 2.0
    return SIGMA * tk4 * (0.34 - 0.14 * math.sqrt(max(ea_kpa, 0.0))) * (1.35 * ratio - 0.35)


def pan_radiation_factor(lat_deg: float) -> float:
    """P_rad (S6.6), |lat| in degrees."""
    a = abs(lat_deg)
    return 1.32 + 4e-4 * a + 8e-5 * a * a


def direct_fraction(rs: float, ra: float) -> float:
    """f_dir (S6.5), kept within 0-1 (ours: S6.5 leaves it open)."""
    if ra <= 0:
        return 0.0
    return max(0.0, min(1.0, -0.11 + 1.31 * rs / ra))


def pan_shortwave(rs: float, ra: float, lat_deg: float, ground_albedo: float = ALBEDO_GROUND) -> float:
    """Rs,pan, the shortwave the pan and its walls receive, MJ m-2 day-1 (S6.4)."""
    f = direct_fraction(rs, ra)
    return (f * pan_radiation_factor(lat_deg) + 1.42 * (1.0 - f) + 0.42 * ground_albedo) * rs


def f_pan(u2: float) -> float:
    """Thom et al.'s vapour transfer function for the pan, mm day-1 kPa-1 (S6.2)."""
    return 1.201 + 1.621 * u2


def penpan_day(
    *,
    tmax_c: float,
    tmin_c: float,
    ea_kpa: float,
    u2_ms: float,
    rs: float,
    ra: float,
    p_kpa: float,
    lat_deg: float,
    z_m: float | None = None,
    ground_albedo: float = ALBEDO_GROUND,
) -> float:
    """PenPan's unscreened Class-A pan evaporation, mm/day (S6.1), for a
    day's (or a month's mean daily) weather: Tmax, Tmin (°C), the actual
    vapour pressure ea (kPa), the wind at 2 m (m/s), Rs and Ra (MJ m-2 day-1),
    the surface pressure (kPa), the latitude and the elevation (m; from the
    pressure when None, for Rso only). Any NaN input gives NaN."""
    vals = (tmax_c, tmin_c, ea_kpa, u2_ms, rs, ra, p_kpa, lat_deg)
    if any(not math.isfinite(v) for v in vals):
        return math.nan
    z = elevation_from_pressure(p_kpa) if z_m is None else z_m
    t = (tmax_c + tmin_c) / 2.0
    es = (sat_vapour_pressure(tmax_c) + sat_vapour_pressure(tmin_c)) / 2.0
    delta = slope_vapour_pressure(t)
    gamma = psychrometric(p_kpa)
    rso = (0.75 + 2e-5 * z) * ra
    rn = (1.0 - ALBEDO_PAN) * pan_shortwave(rs, ra, lat_deg, ground_albedo) - net_longwave(tmax_c, tmin_c, ea_kpa, rs, rso)
    radiative = delta / (delta + A_P * gamma) * rn / LAMBDA
    aerodynamic = A_P * gamma / (delta + A_P * gamma) * f_pan(max(u2_ms, 0.0)) * max(es - ea_kpa, 0.0)
    return max(radiative + aerodynamic, 0.0)


def monthly_mm(
    year: int,
    month: int,
    *,
    tmax_c: float,
    tmin_c: float,
    ea_kpa: float,
    u2_ms: float,
    rs: float,
    p_kpa: float,
    lat_deg: float,
    ground_albedo: float = ALBEDO_GROUND,
    screen: float = 1.0,
) -> float:
    """A month's PenPan total, mm, from its mean daily weather (the steady-state
    monthly use, Roderick et al. 2007 § 2): S6.1 at the means, Ra the month's
    mean daily Ra, times the month's days and `screen` (1: unscreened)."""
    ra = month_ra(lat_deg, year, month)
    e = penpan_day(tmax_c=tmax_c, tmin_c=tmin_c, ea_kpa=ea_kpa, u2_ms=u2_ms, rs=rs, ra=ra, p_kpa=p_kpa, lat_deg=lat_deg, ground_albedo=ground_albedo)
    return e * calendar.monthrange(year, month)[1] * screen
