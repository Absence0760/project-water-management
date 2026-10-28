"""A modelled Class-A pan grid (PenPan) for Evaporation from the map (issue
#646 item 7; docs/maps.md § The evaporation grid, docs/deployment.md §
Reference datasets). Operator-run, offline; never by the app or the ingest
Lambda (not in the image).

Three steps, each its own command:

    python3 ingest/apan_grid.py fetch --years 1991 2020 --dir <dir> [--bbox w,s,e,n] [--fixtures]
    python3 ingest/apan_grid.py grid --dir <dir> --years 1991 2020 --out apan.json[.gz] [--bbox …] [--screen 1] [--ground-albedo 0.23]
    python3 ingest/apan_grid.py validate --grid apan.json[.gz] --stations stations.csv --out report.md

**Where the weather comes from: NASA POWER, not the copy.** The copy holds
AgERA5's and POWER's reference ET only (agera5.py stores one variable,
`reference_evapotranspiration`; nasapower.py stores the ET₀ it computes and
keeps 120 days), not the weather PenPan needs. Adding AgERA5's other
variables would be five more CDS products (each its own request, manifest
and array in cdsjob's machinery), not a small change, so this script asks
NASA POWER's daily regional API for the same six parameters `power_et0`
reads (nasapower.PARAMETERS: Tmax, Tmin, dew point, 2 m wind, all-sky
shortwave, surface pressure; community AG, CC BY 4.0), one year at a time:
for each tile of the box (nasapower.tiles, at most 10° a side) and each
parameter one request through polite.PoliteClient (one a second, our
User-Agent with INGEST_CONTACT, a 403/401 stops the run, never retried).
South Africa's box is 4 tiles: 24 requests a year, 720 for a 30-year normal.

**fetch** reduces each year to its monthly means at every POWER point (a
month with any day missing is null for that point) and writes
`<dir>/<year>.power-monthly.json`; a year already there is skipped, so a run
cut short resumes. `--fixtures` answers from power_fixture.FakePower's
synthetic weather (no network; dev and the tests).

**grid** turns each point's month into PenPan's total (penpan.monthly_mm:
the month's mean daily Tmax, Tmin, actual vapour pressure (the mean of the
days' e°(Tdew)), wind, Rs and pressure, steady state), averages each
calendar month over the years (a point needs every month of every year),
and places it on 0.1° cells centred on x.x5° (the copy's grid) inside the
box, each cell the nearest point's (25 cells share one 0.5° point, as
`power_et0`'s do), in the `apan` form `pnpm import:evaporation` loads, with
`model` (name, ground albedo, screen factor, inputs) so the method text says
what the values are: **modelled Class-A pan (PenPan), never a measured pan**.

**validate** compares the grid with Class-A pan station records (a CSV:
`station,lat,lon,jan,…,dec`, each the station's mean monthly mm over its
record) at each station's cell and writes a Markdown report: per station,
per month (the mean ratio grid/station, the mean bias, the RMSE) and overall.
It decides nothing: production waits for the report and the hydrologist's
sign-off (docs/data-sources.md § penpan-apan).
"""

from __future__ import annotations

import argparse
import calendar
import csv
import gzip
import json
import math
import os
import sys
from typing import Callable, Iterable, Sequence

import numpy as np

import nasapower
import penpan
import polite

#: South Africa, Lesotho and eSwatini with a margin (backend/src/geo/loadEvaporation.ts SOUTH_AFRICA_BBOX): west, south, east, north.
SOUTH_AFRICA_BBOX = (16.0, -35.2, 33.2, -22.0)
CELL_DEG = 0.1
REDUCED_PRODUCT = "power-monthly"
#: The reduced file's variables: (name, POWER parameter or None when derived).
VARIABLES = ("tmax", "tmin", "ea", "u2", "rs", "p")
#: A month's PenPan total this large is a broken input, not a pan (evaporationFromJson's own bound).
MAX_MONTH_MM = 1000.0

SOURCE = (
    "Modelled Class-A pan (PenPan): Rotstayn, Roderick and Farquhar 2006 (GRL 33, L17715), as McMahon et al. 2013 "
    "(HESS 17, 1331, Supplement S6) set it out, from NASA POWER daily meteorology (AG community, 0.5°); not a measured pan"
)
VERSION = "PenPan (penpan.py); NASA POWER daily regional API"
ATTRIBUTION = (
    "NASA Prediction of Worldwide Energy Resources (POWER) Project, CC BY 4.0; Class-A pan evaporation modelled by us "
    "with PenPan (Rotstayn et al. 2006) from its daily meteorology"
)
INPUTS = "each 0.5° NASA POWER point's monthly mean daily Tmax, Tmin, dew point (as actual vapour pressure), 2 m wind, all-sky solar radiation and surface pressure"


class GridError(ValueError):
    pass


# --- fetch ----------------------------------------------------------------------------


def year_days(year: int) -> list:
    import datetime as dt

    d0 = dt.date(year, 1, 1)
    return [d0 + dt.timedelta(days=k) for k in range(366 if calendar.isleap(year) else 365)]


def _region(bbox) -> dict:
    w, s, e, n = bbox
    return {"w": w, "s": s, "e": e, "n": n}


def fetch_year(client: polite.PoliteClient, year: int, bbox=SOUTH_AFRICA_BBOX) -> dict:
    """One year of POWER's daily weather over `bbox`, reduced to each point's monthly means (the reduced file's content)."""
    days = year_days(year)
    fields: dict[str, dict] = {p: {} for p in nasapower.PARAMETERS}
    for t in nasapower.tiles(_region(bbox)):
        for p in nasapower.PARAMETERS:
            res = nasapower._get(client, nasapower.request_url(p, t, days[0], days[-1]))
            for k, v in nasapower.parse_response(res.body or b"", p, days).items():
                fields[p].setdefault(k, v)  # a point on a shared tile edge: the first answer stands
    points = set.intersection(*(set(f) for f in fields.values()))
    months = np.array([d.month for d in days])
    masks = [months == m for m in range(1, 13)]
    out = []
    for lat, lon in sorted(points):
        g = {p: np.asarray(fields[p][(lat, lon)], dtype=np.float64) for p in nasapower.PARAMETERS}
        daily = {
            "tmax": g["T2M_MAX"],
            "tmin": g["T2M_MIN"],
            "ea": 0.6108 * np.exp(17.27 * g["T2MDEW"] / (g["T2MDEW"] + 237.3)),  # e°(Tdew), FAO-56 eqs. 11 and 14 (NaN stays NaN)
            "u2": g["WS2M"],
            "rs": g["ALLSKY_SFC_SW_DWN"],
            "p": g["PS"],
        }
        means = {}
        for name in VARIABLES:
            row = []
            for mask in masks:
                vs = daily[name][mask]
                row.append(round(float(vs.mean()), 4) if np.isfinite(vs).all() else None)
            means[name] = row
        out.append([lat, lon, means])
    return {"product": REDUCED_PRODUCT, "year": year, "bbox": list(bbox), "variables": list(VARIABLES), "points": out}


def reduced_path(directory: str, year: int) -> str:
    return os.path.join(directory, f"{year}.power-monthly.json")


def fetch(client: polite.PoliteClient, years: Iterable[int], directory: str, bbox=SOUTH_AFRICA_BBOX, log: Callable[[str], None] = print) -> list[str]:
    """Reduce each year not already in `directory`; returns the files written."""
    os.makedirs(directory, exist_ok=True)
    written = []
    for y in years:
        path = reduced_path(directory, y)
        if os.path.exists(path):
            log(f"{y}: already reduced ({path})")
            continue
        doc = fetch_year(client, y, bbox)
        tmp = path + ".part"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(doc, f)
        os.replace(tmp, path)
        log(f"{y}: {len(doc['points'])} points -> {path}")
        written.append(path)
    return written


# --- grid -----------------------------------------------------------------------------


def read_reduced(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    if not isinstance(doc, dict) or doc.get("product") != REDUCED_PRODUCT or not isinstance(doc.get("year"), int) or not isinstance(doc.get("points"), list):
        raise GridError(f"{path} is not a year apan_grid.py fetch wrote")
    if doc.get("variables") != list(VARIABLES):
        raise GridError(f"{path} holds {doc.get('variables')}, not {list(VARIABLES)}")
    return doc


def point_climatology(years: Sequence[dict], ground_albedo: float = penpan.ALBEDO_GROUND, screen: float = 1.0) -> dict[tuple[float, float], list[float]]:
    """{(lat, lon): 12 mean monthly PenPan totals, Jan … Dec} for the points with every month of every year."""
    ys = sorted(years, key=lambda d: d["year"])
    for a, b in zip(ys, ys[1:]):
        if b["year"] == a["year"]:
            raise GridError(f"{b['year']} is given twice")
        if b["year"] != a["year"] + 1:
            raise GridError(f"the years skip from {a['year']} to {b['year']}: give a continuous run")
    sums: dict[tuple[float, float], list[float]] = {}
    counts: dict[tuple[float, float], int] = {}
    for doc in ys:
        year = doc["year"]
        for lat, lon, means in doc["points"]:
            key = (round(float(lat), 4), round(float(lon), 4))
            totals = []
            for m in range(12):
                v = {k: means[k][m] for k in VARIABLES}
                if any(x is None for x in v.values()):
                    break
                mm = penpan.monthly_mm(year, m + 1, tmax_c=v["tmax"], tmin_c=v["tmin"], ea_kpa=v["ea"], u2_ms=v["u2"], rs=v["rs"], p_kpa=v["p"], lat_deg=key[0], ground_albedo=ground_albedo, screen=screen)
                if not math.isfinite(mm) or mm > MAX_MONTH_MM:
                    raise GridError(f"{year}-{m + 1:02d} at {key}: PenPan gives {mm} mm, outside 0–{MAX_MONTH_MM:g}: check the inputs")
                totals.append(mm)
            if len(totals) != 12:
                continue
            s = sums.setdefault(key, [0.0] * 12)
            for m in range(12):
                s[m] += totals[m]
            counts[key] = counts.get(key, 0) + 1
    return {k: [x / len(ys) for x in s] for k, s in sums.items() if counts[k] == len(ys)}


def _nearest(axis: Sequence[float], x: float) -> int | None:
    """Index of the axis point nearest x; None beyond half a spacing past either end."""
    i = min(range(len(axis)), key=lambda k: abs(axis[k] - x))
    half = (min(b - a for a, b in zip(axis, axis[1:])) / 2.0 if len(axis) > 1 else 0.25) + 1e-6
    return i if abs(axis[i] - x) <= half else None


def place(points: dict[tuple[float, float], list[float]], bbox=SOUTH_AFRICA_BBOX) -> list[list]:
    """0.1° cells centred on x.x5° inside `bbox`, each the nearest point's 12 values: [[lon, lat, [Oct … Sep]], …]."""
    if not points:
        return []
    lats = sorted({p[0] for p in points})
    lons = sorted({p[1] for p in points})
    w, s, e, n = bbox
    # Cell k is centred on (k + 0.5) x 0.1 deg: every centre inside the box, by whole indices (no float drift).
    k0 = lambda lo: math.ceil(round(lo / CELL_DEG - 0.5, 6))  # noqa: E731
    k1 = lambda hi: math.floor(round(hi / CELL_DEG - 0.5, 6))  # noqa: E731
    cells = []
    for r in range(k0(s), k1(n) + 1):
        lat = round((r + 0.5) * CELL_DEG, 6)
        ri = _nearest(lats, lat)
        if ri is None:
            continue
        for c in range(k0(w), k1(e) + 1):
            lon = round((c + 0.5) * CELL_DEG, 6)
            ci = _nearest(lons, lon)
            if ci is not None and (lats[ri], lons[ci]) in points:
                cal = points[(lats[ri], lons[ci])]
                cells.append([round(lon, 4), round(lat, 4), [round(x, 1) for x in cal[9:] + cal[:9]]])
    return cells


def method_model(ground_albedo: float, screen: float) -> dict:
    return {"name": "penpan", "groundAlbedo": ground_albedo, "screen": screen, "inputs": INPUTS}


def grid_doc(years: Sequence[dict], bbox=SOUTH_AFRICA_BBOX, ground_albedo: float = penpan.ALBEDO_GROUND, screen: float = 1.0) -> dict:
    """The `apan` grid in the form backend/src/geo/evaporationGrid.ts evaporationFromJson reads."""
    if not years:
        raise GridError("no years to average")
    cells = place(point_climatology(years, ground_albedo, screen), bbox)
    if not cells:
        raise GridError("no cell has a value for every month of every year: check the years and --bbox")
    ys = sorted(d["year"] for d in years)
    return {
        "kind": "apan",
        "cellDeg": CELL_DEG,
        "firstYear": ys[0],
        "lastYear": ys[-1],
        "source": SOURCE,
        "version": VERSION,
        "attribution": ATTRIBUTION,
        "model": method_model(ground_albedo, screen),
        "cells": cells,
    }


def _write(path: str, text: str) -> None:
    if path.endswith(".gz"):
        with gzip.open(path, "wt", encoding="utf-8") as f:
            f.write(text)
    else:
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)


def _read_text(path: str) -> str:
    if path.endswith(".gz"):
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return f.read()
    with open(path, encoding="utf-8") as f:
        return f.read()


# --- validate -------------------------------------------------------------------------

MONTHS = ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")


def read_stations(path: str) -> list[dict]:
    """`station,lat,lon,jan,…,dec`: each station's mean monthly Class-A pan, mm."""
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    out = []
    for i, r in enumerate(rows, start=2):
        try:
            out.append({"station": r["station"].strip(), "lat": float(r["lat"]), "lon": float(r["lon"]), "monthly": [float(r[m]) for m in MONTHS]})
        except (KeyError, TypeError, ValueError):
            raise GridError(f"{path} line {i}: not station,lat,lon and 12 monthly means (jan … dec)") from None
        if any(not math.isfinite(v) or v < 0 for v in out[-1]["monthly"]):
            raise GridError(f"{path} line {i}: a monthly mean is negative or not a number")
    if not out:
        raise GridError(f"{path} has no station")
    return out


def grid_lookup(doc: dict) -> Callable[[float, float], list[float] | None]:
    """(lat, lon) -> the cell's 12 values Jan … Dec, or None when no cell holds the point."""
    if doc.get("kind") != "apan" or not isinstance(doc.get("cells"), list) or not doc["cells"]:
        raise GridError("the grid is not an apan grid with cells")
    cell = float(doc["cellDeg"])
    lon0, lat0 = float(doc["cells"][0][0]), float(doc["cells"][0][1])
    olon = (lon0 - cell / 2) % cell
    olat = (lat0 - cell / 2) % cell
    idx = lambda x, o: math.floor((x - o) / cell + 1e-6)  # noqa: E731
    table = {(idx(c[1], olat), idx(c[0], olon)): c[2] for c in doc["cells"]}

    def at(lat: float, lon: float):
        v = table.get((idx(lat, olat), idx(lon, olon)))
        return None if v is None else list(v[3:]) + list(v[:3])  # Oct … Sep -> Jan … Dec

    return at


def validate(doc: dict, stations: Sequence[dict]) -> dict:
    """The comparison's numbers: per station, per month and overall."""
    at = grid_lookup(doc)
    per, missing = [], []
    for s in stations:
        g = at(s["lat"], s["lon"])
        if g is None:
            missing.append(s["station"])
            continue
        per.append({**s, "grid": g})
    months = []
    for m in range(12):
        pairs = [(p["grid"][m], p["monthly"][m]) for p in per]
        ratios = [g / o for g, o in pairs if o > 0]
        months.append(
            {
                "month": m,
                "n": len(pairs),
                "ratio": sum(ratios) / len(ratios) if ratios else math.nan,
                "bias": sum(g - o for g, o in pairs) / len(pairs) if pairs else math.nan,
                "rmse": math.sqrt(sum((g - o) ** 2 for g, o in pairs) / len(pairs)) if pairs else math.nan,
            }
        )
    allp = [(p["grid"][m], p["monthly"][m]) for p in per for m in range(12)]
    overall = {
        "stations": len(per),
        "outside": missing,
        "ratio": sum(g for g, _ in allp) / sum(o for _, o in allp) if allp and sum(o for _, o in allp) > 0 else math.nan,
        "bias": sum(g - o for g, o in allp) / len(allp) if allp else math.nan,
        "rmse": math.sqrt(sum((g - o) ** 2 for g, o in allp) / len(allp)) if allp else math.nan,
    }
    return {"stations": per, "months": months, "overall": overall}


def _f(x: float, d: int = 1) -> str:
    return "–" if not math.isfinite(x) else f"{x:.{d}f}"


def report_markdown(doc: dict, result: dict, grid_name: str, stations_name: str) -> str:
    o = result["overall"]
    lines = [
        "# PenPan Class-A pan grid against station pans",
        "",
        f"Grid: `{grid_name}` ({doc.get('firstYear')}–{doc.get('lastYear')}, model {json.dumps(doc.get('model'))}).",
        f"Stations: `{stations_name}`, {o['stations']} inside the grid" + (f", {len(o['outside'])} outside it ({', '.join(o['outside'])})." if o["outside"] else "."),
        "",
        "Each station's 12 monthly means against its 0.1° cell's. Ratio is grid ÷ station (above 1: the grid evaporates more);",
        "bias and RMSE are grid − station, mm a month. For scale: McMahon et al. (2013, S6) found PenPan ÷ Class-A pan of 1.078",
        "over 68 Australian stations (screened, after the 0.93 bird-screen factor), and Roderick et al. (2007) an RMSE of 24 mm a month.",
        "This report decides nothing: the hydrologist signs off (docs/data-sources.md § penpan-apan).",
        "",
        "## Overall",
        "",
        "| Stations | Ratio (Σ grid ÷ Σ station) | Mean bias (mm/month) | RMSE (mm/month) |",
        "| --- | --- | --- | --- |",
        f"| {o['stations']} | {_f(o['ratio'], 3)} | {_f(o['bias'])} | {_f(o['rmse'])} |",
        "",
        "## By month",
        "",
        "| Month | Stations | Mean ratio | Mean bias (mm) | RMSE (mm) |",
        "| --- | --- | --- | --- | --- |",
    ]
    for m in result["months"]:
        lines.append(f"| {calendar.month_abbr[m['month'] + 1]} | {m['n']} | {_f(m['ratio'], 3)} | {_f(m['bias'])} | {_f(m['rmse'])} |")
    lines += ["", "## By station", "", "| Station | Lat | Lon | Station (mm/yr) | Grid (mm/yr) | Ratio | RMSE (mm/month) |", "| --- | --- | --- | --- | --- | --- | --- |"]
    for p in result["stations"]:
        obs, g = sum(p["monthly"]), sum(p["grid"])
        rmse = math.sqrt(sum((a - b) ** 2 for a, b in zip(p["grid"], p["monthly"])) / 12)
        lines.append(f"| {p['station']} | {p['lat']:.3f} | {p['lon']:.3f} | {obs:.0f} | {g:.0f} | {_f(g / obs, 3) if obs > 0 else '–'} | {_f(rmse)} |")
    return "\n".join(lines) + "\n"


# --- the command ----------------------------------------------------------------------


def _bbox(text: str):
    try:
        w, s, e, n = (float(x) for x in text.split(","))
    except ValueError as err:
        raise argparse.ArgumentTypeError("--bbox is west,south,east,north in degrees") from err
    if not (w < e and s < n):
        raise argparse.ArgumentTypeError("--bbox is west,south,east,north in degrees")
    return (w, s, e, n)


def _years(p: argparse.ArgumentParser, a) -> range:
    first, last = a.years
    if not (1981 <= first <= last):
        p.error("--years is first last, from 1981 (POWER's daily meteorology starts then)")
    return range(first, last + 1)


def main(argv: Sequence[str] | None = None, opener=None) -> int:
    p = argparse.ArgumentParser(description="A modelled Class-A pan grid (PenPan) from NASA POWER, and its validation against station pans.")
    sub = p.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch", help="reduce POWER's daily weather to monthly means, a year a file")
    f.add_argument("--years", nargs=2, type=int, required=True, metavar=("FIRST", "LAST"))
    f.add_argument("--dir", required=True)
    f.add_argument("--bbox", type=_bbox, default=SOUTH_AFRICA_BBOX)
    f.add_argument("--fixtures", action="store_true", help="answer from power_fixture's synthetic weather (no network)")
    g = sub.add_parser("grid", help="PenPan's monthly climatology on 0.1° cells, the apan form")
    g.add_argument("--dir", required=True)
    g.add_argument("--years", nargs=2, type=int, required=True, metavar=("FIRST", "LAST"))
    g.add_argument("--out", required=True)
    g.add_argument("--bbox", type=_bbox, default=SOUTH_AFRICA_BBOX)
    g.add_argument("--screen", type=float, default=1.0, help="1 for an unscreened pan (default); 0.93 for a bird-screened one (McMahon S16)")
    g.add_argument("--ground-albedo", type=float, default=penpan.ALBEDO_GROUND)
    v = sub.add_parser("validate", help="compare the grid with Class-A pan stations")
    v.add_argument("--grid", required=True)
    v.add_argument("--stations", required=True)
    v.add_argument("--out", required=True)
    a = p.parse_args(argv)
    try:
        if a.cmd == "fetch":
            years = _years(p, a)
            if a.fixtures and opener is None:
                import power_fixture

                opener = power_fixture.FakePower()
            client = polite.PoliteClient(contact=os.environ.get("INGEST_CONTACT"), min_interval=0.0 if opener else 1.0, **({"opener": opener} if opener else {}))
            fetch(client, years, a.dir, a.bbox)
            return 0
        if a.cmd == "grid":
            if not (a.out.endswith(".json") or a.out.endswith(".json.gz")):
                p.error("--out is a .json or .json.gz file")
            if not (0.5 <= a.screen <= 1.0):
                p.error("--screen is a factor from 0.5 to 1 (1: unscreened)")
            if not (0.0 <= a.ground_albedo <= 1.0):
                p.error("--ground-albedo is 0 to 1")
            years = []
            for y in _years(p, a):
                path = reduced_path(a.dir, y)
                if not os.path.exists(path):
                    raise GridError(f"{path} is missing: run fetch for {y} first")
                years.append(read_reduced(path))
            doc = grid_doc(years, a.bbox, a.ground_albedo, a.screen)
            _write(a.out, json.dumps(doc))
            print(f"{len(doc['cells'])} cells written to {a.out} ({doc['firstYear']}–{doc['lastYear']}, modelled Class-A pan, PenPan)")
            return 0
        doc = json.loads(_read_text(a.grid))
        result = validate(doc, read_stations(a.stations))
        _write(a.out, report_markdown(doc, result, os.path.basename(a.grid), os.path.basename(a.stations)))
        o = result["overall"]
        print(f"{o['stations']} stations compared; ratio {_f(o['ratio'], 3)}, RMSE {_f(o['rmse'])} mm a month -> {a.out}")
        return 0
    except (OSError, GridError, ValueError, nasapower.PowerFormatError, polite.StopRun, nasapower.Refused) as e:
        print(f"apan_grid.py: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
