"""Run verify/model.py and the engine's `runModel` on the same inputs and
report, per output column, the largest absolute and relative difference.

    python3 verify/diff.py [--random N] [--dense N] [--seed S] [--no-examples] [--keep DIR]

Inputs: (a) the three invented example catchments `pnpm seed:examples`
builds (their inputs come from verify/run_engine.ts, without the automatic
fit), (b) the probes (verify/probes.py), (c) N random networks from
verify/generate.py (seeded, this harness's own generator, not the engine's
fuzz generator) and (d) N dense ones, with every phase-2a feature in most.

A column agrees when, on every day, |python − engine| ≤ ATOL + RTOL × the
column's largest magnitude in the engine's output (both sides float64, but
not the same operations in the same order, and GR4J's stores carry a last-bit
difference forward; see verify/README.md § Tolerance). A column listed in
KNOWN_DIFFERENCES is reported but does not fail the run: each entry names the
docs/followups.md item that tracks it. Exit status 1 when any other column
disagrees, a series exists on one side only, or the run windows differ.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

import generate  # noqa: E402
import model  # noqa: E402
import probes  # noqa: E402

ATOL = 1e-6  # m³/day or mm
RTOL = 1e-9  # of the column's largest magnitude

# Engine series phase 1 does not model (not a disagreement): calibration,
# observed records and the rain diagnostics outside the chain compared here.
NOT_COMPARED = {
    "observed_flow", "observed_flow_other", "rain_chirps", "rain_source", "rain_catchment_missing",
    "rain_catchment_spread",
}

# (column key, reason and followup) — reported, never failing. Keep empty
# unless an engine behaviour is recorded in docs/followups.md.
KNOWN_DIFFERENCES: dict[str, str] = {}

# Engine behaviours that depart from the docs on a few inputs, recognised by
# their symptom (below) rather than by column: the case's disagreements are
# reported as known, never failing. Each names its docs/followups.md item.
KNOWN_CASES: dict[str, str] = {
    "noise-demand": (
        "a float-noise demand (≤ 1e-9 m³, or the rest after off-take water) switches on a primary or emergency "
        "dam-target borehole, and a noise-demand day drops out of limitBound (docs/followups.md § Verification, "
        "\"a float-noise demand switches on a dam-target borehole\")"
    ),
}


def run_engine(pairs: list[tuple[Path, Path]]) -> None:
    tsx = ROOT / "backend" / "node_modules" / ".bin" / "tsx"
    args = [str(tsx), str(HERE / "run_engine.ts"), "run"]
    for a, b in pairs:
        args += [str(a), str(b)]
    subprocess.run(args, check=True, cwd=ROOT)


def example_inputs(tmp: Path) -> list[Path]:
    tsx = ROOT / "backend" / "node_modules" / ".bin" / "tsx"
    tmp.mkdir(parents=True, exist_ok=True)
    subprocess.run([str(tsx), str(HERE / "run_engine.ts"), "examples", str(tmp)], check=True, cwd=ROOT)
    return sorted(tmp.glob("*.input.json"))


def _num(v):
    return math.nan if v is None else float(v)


def compare(py: dict, eng: dict) -> dict:
    """Per (nodeId, key): max abs diff, scale and whether it agrees."""
    res = {"window": None, "columns": {}, "only_python": [], "only_engine": []}
    if (py["startDate"], py["endDate"], py["days"]) != (eng["startDate"], eng["endDate"], eng["days"]):
        res["window"] = f"python {py['startDate']}…{py['endDate']} ({py['days']}) vs engine {eng['startDate']}…{eng['endDate']} ({eng['days']})"
        return res
    ps = {(s["nodeId"], s["key"]): s["values"] for s in py["series"]}
    es = {(s["nodeId"], s["key"]): s["values"] for s in eng["series"]}
    for k in sorted(set(ps) | set(es), key=lambda k: (k[1], k[0] or "")):
        if k[1] in NOT_COMPARED:
            continue
        if k not in es:
            # A series the engine leaves out when it is all zeros is not a
            # disagreement (e.g. dam_seepage_lost with every share at 1).
            if all(_num(v) == 0 for v in ps[k]):
                continue
            res["only_python"].append(k)
            continue
        if k not in ps:
            res["only_engine"].append(k)
            continue
        a = [_num(v) for v in ps[k]]
        b = [_num(v) for v in es[k]]
        scale = max((abs(v) for v in b if not math.isnan(v)), default=0.0)
        worst = 0.0
        worst_day = None
        mism_nan = False
        # A dam's area is a power (or curve) of its start-of-day storage, so
        # float noise in an empty dam (≤ ATOL m³) becomes a visible area: an
        # exponent of 0.62 turns 1e-13 m³ into 4e-4 m², and the rain on it
        # and its evaporation follow. Days both sides started with a
        # noise-level storage don't compare those three (the storage itself
        # is compared, README § Tolerance).
        noise_days = set()
        if k[1] in ("dam_area", "rain_on_dam", "dam_evaporation") and (k[0], "dam_storage") in ps and (k[0], "dam_storage") in es:
            qa, qb = ps[(k[0], "dam_storage")], es[(k[0], "dam_storage")]
            noise_days = {d for d in range(1, len(qa)) if abs(_num(qa[d - 1])) <= ATOL and abs(_num(qb[d - 1])) <= ATOL}
        # The binding site is a label of a day with a charge: a charge both
        # sides put within ATOL of 0 (float noise either side of the
        # attribution's 1e-12 cut-off) says nothing about which site binds.
        if k[1] == "ewr_binding_site" and (k[0], "ewr_charge") in ps and (k[0], "ewr_charge") in es:
            ca, cb = ps[(k[0], "ewr_charge")], es[(k[0], "ewr_charge")]
            noise_days |= {d for d in range(len(ca)) if abs(_num(ca[d])) <= ATOL and abs(_num(cb[d])) <= ATOL}
        for d, (x, y) in enumerate(zip(a, b)):
            if d in noise_days:
                continue
            if math.isnan(x) or math.isnan(y):
                if math.isnan(x) != math.isnan(y):
                    mism_nan = True
                    worst_day = worst_day if worst_day is not None else d
                continue
            diff = abs(x - y)
            if diff > worst:
                worst = diff
                worst_day = d
        tol = ATOL + RTOL * scale
        res["columns"][k] = {
            "abs": worst,
            "rel": worst / scale if scale > 0 else (0.0 if worst == 0 else math.inf),
            "scale": scale,
            "ok": (not mism_nan) and worst <= tol and len(a) == len(b),
            "day": worst_day,
            "nan": mism_nan,
        }
    return res


def _close(a: float, b: float) -> bool:
    return abs(a - b) <= ATOL + RTOL * max(abs(a), abs(b))


def _public(rows: list[dict]) -> list[dict]:
    return [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows]


def _limit_bound_less_noise(rows: list[dict]) -> list[dict]:
    """Python's limitBound rows less its noise-demand days (KNOWN_CASES)."""
    out = []
    for r in rows:
        nz = r.get("_noise") or {}
        q = {k: v - nz.get(k, 0) for k, v in r.items() if not k.startswith("_") and k != "waterYear"}
        if q["days"] > 0:
            out.append({"waterYear": r["waterYear"], **q})
    return out


def compare_summary(py: dict, eng: dict | None, known: list[str] | None = None) -> tuple[dict, list[str]]:
    """RunSummary.allocations' run-dependent parts (model.md §2.12a): per
    capped unit and source the years the cap bound (`capReached`) and the
    days each limit held use back (`limitBound`); per scaled unit the demand
    and volume of each water year (`scaled`). Returns per-part (worst |Δ|,
    ok) and the disagreements."""
    parts: dict[str, list] = {}
    bad: list[str] = []
    known = known if known is not None else []
    mode = (eng or {}).get("mode")
    if mode not in ("cap", "fullAllocation"):
        if py:
            bad.append("python has an allocation summary, the engine none")
        return parts, bad
    seen = set()
    for node in eng.get("nodes", []):
        nid = node["nodeId"]
        if mode == "cap":
            for src in node.get("sources", []):
                key = (nid, src["waterSource"])
                seen.add(key)
                mine = py.get(key, {"capReached": [], "limitBound": []})
                for part, fields in (("capReached", ("budgetM3", "usedM3")), ("limitBound", ("days", "volumeDays", "rateDays", "monthsDays"))):
                    a = mine[part]
                    b = src.get(part) or []
                    worst = 0.0
                    ok = [r["waterYear"] for r in a] == [r["waterYear"] for r in b]
                    if ok:
                        for ra, rb in zip(a, b):
                            for f in fields:
                                worst = max(worst, abs(ra[f] - rb[f]))
                                ok = ok and _close(ra[f], rb[f])
                    if not ok and part == "limitBound" and _limit_bound_less_noise(a) == b:
                        known.append(f"allocations.limitBound ({nid}, {src['waterSource']}): the engine leaves out python's noise-demand days")
                        ok = True
                    parts.setdefault(part, []).append((worst, ok))
                    if not ok:
                        bad.append(f"allocations.{part} ({nid}, {src['waterSource']}): python {_public(a)} vs engine {b}")
        else:
            key = (nid, "scaled")
            seen.add(key)
            a = py.get(key, [])
            b = node.get("scaled") or []
            worst = 0.0
            ok = [r["waterYear"] for r in a] == [r["waterYear"] for r in b]
            if ok:
                for ra, rb in zip(a, b):
                    for f in ("demandM3", "registeredM3"):
                        worst = max(worst, abs(ra[f] - rb[f]))
                        ok = ok and _close(ra[f], rb[f])
            parts.setdefault("scaled", []).append((worst, ok))
            if not ok:
                bad.append(f"allocations.scaled ({nid}): python {a} vs engine {b}")
    for key, v in py.items():
        if key not in seen and (v if isinstance(v, list) else (v["capReached"] or v["limitBound"])):
            bad.append(f"allocations {key}: only in python")
    return parts, bad


def known_case(py: dict, eng: dict, r: dict) -> str | None:
    """The KNOWN_CASES entry a case's disagreement is, if any: on the first
    day any column disagrees, a farm's groundwater_to_dam differs while the
    engine's demand left for the dam and boreholes (demand − off-take water
    used) is float noise, ≤ 1e-9 of the demand (or ≤ 1e-9 m³)."""
    bad = [(c["day"], k) for k, c in r["columns"].items() if not c["ok"] and c["day"] is not None]
    if not bad:
        return None
    ps = {(s["nodeId"], s["key"]): s["values"] for s in py["series"]}
    es = {(s["nodeId"], s["key"]): s["values"] for s in eng["series"]}
    d0 = min(_first_bad_day(ps[k], es[k]) for _, k in bad)
    for (node, key) in es:
        if key != "groundwater_to_dam" or (node, key) not in ps:
            continue
        a, b = _num(ps[(node, key)][d0]), _num(es[(node, key)][d0])
        if abs(a - b) <= ATOL:
            continue
        dem = _num(es[(node, "demand")][d0])
        used = _num(es[(node, "offtake_used")][d0]) if (node, "offtake_used") in es else 0.0
        rest = dem - used
        if 0 < rest <= 1e-9 * max(dem, 1.0):
            return "noise-demand"
    return None


def _first_bad_day(a: list, b: list) -> int:
    scale = max((abs(_num(v)) for v in b if v is not None), default=0.0)
    for d, (x, y) in enumerate(zip(a, b)):
        x, y = _num(x), _num(y)
        if math.isnan(x) != math.isnan(y) or (not math.isnan(x) and abs(x - y) > ATOL + RTOL * scale):
            return d
    return len(a)


def build_cases(tmp: Path, n_random: int, seed: int, examples: bool, n_dense: int = 0) -> list[tuple[str, Path, Path]]:
    """Write every case's input, run the engine on all of them in one process,
    and return (name, input path, engine output path)."""
    cases: list[tuple[str, Path]] = []
    if examples:
        for p in example_inputs(tmp / "examples"):
            cases.append((p.name.replace(".input.json", ""), p))
    (tmp / "probes").mkdir(parents=True, exist_ok=True)
    for name, doc in probes.PROBES.items():
        p = tmp / "probes" / f"probe-{name}.input.json"
        p.write_text(json.dumps(doc))
        cases.append((f"probe-{name}", p))
    for k in range(n_random):
        doc = generate.random_input(seed + k)
        p = tmp / f"random-{seed + k}.input.json"
        p.write_text(json.dumps(doc))
        cases.append((f"random-{seed + k}", p))
    # Dense networks: every phase-2a feature in most of them (generate.py).
    for k in range(n_dense):
        doc = generate.random_input(seed + k, dense=True)
        p = tmp / f"dense-{seed + k}.input.json"
        p.write_text(json.dumps(doc))
        cases.append((f"dense-{seed + k}", p))
    for name, p in cases:
        extra = model.unsupported(json.loads(p.read_text()))
        if extra:
            raise SystemExit(f"{name}: uses features outside phases 1 and 2a: {', '.join(extra)}")
    out = [(name, p, p.with_name(f"{name}.engine.json")) for name, p in cases]
    run_engine([(p, e) for _, p, e in out])
    return out


def evaluate(cases, impl=model, notes=None, stop_first=False) -> dict:
    """Compare `impl` (verify/model.py, or a mutant of it in the self-test)
    with the engine's stored outputs. `stop_first` returns at the first case
    that disagrees (all a mutant needs)."""
    per_key: dict[str, dict] = {}
    coverage: dict[str, list[int]] = {}
    refused = 0
    failures: list[str] = []
    known: list[str] = []
    for name, p, eng_path in cases:
        if stop_first and failures:
            break
        doc = json.loads(p.read_text())
        eng = json.loads(eng_path.read_text())
        try:
            py = impl.run(doc)
        except impl.Refused as e:
            if "error" not in eng:
                failures.append(f"{name}: python refuses the run ({e}), the engine runs it")
            refused += 1
            continue
        if "error" in eng:
            failures.append(f"{name}: the engine refuses the run ({eng['error']}), python runs it")
            continue
        for k, v in py.get("diag", {}).items():
            c = coverage.setdefault(k, [0, 0])
            c[0] += v
            c[1] += 1 if v else 0
        r = compare(py, eng)
        if r["window"]:
            failures.append(f"{name}: run window {r['window']}")
            continue
        why = known_case(py, eng, r)
        if why:
            known.append(f"{name}: {why}: {KNOWN_CASES[why]}")
            continue
        for k in r["only_python"]:
            failures.append(f"{name}: {k[1]} ({k[0] or 'catchment'}) only in python")
        for k in r["only_engine"]:
            if notes is not None:
                notes.append(f"{name}: {k[1]} ({k[0] or 'catchment'}) only in the engine's output")
        kn: list[str] = []
        parts, bad = compare_summary(py.get("summary") or {}, eng.get("allocations"), kn)
        failures.extend(f"{name}: {b}" for b in bad)
        known.extend(f"{name}: noise-demand: {b}" for b in kn)
        for part, rows in parts.items():
            agg = per_key.setdefault(f"allocations.{part}", {"abs": 0.0, "rel": 0.0, "n": 0, "bad": 0})
            for worst, ok in rows:
                agg["n"] += 1
                agg["abs"] = max(agg["abs"], worst)
                agg["bad"] += 0 if ok else 1
        for (node, key), c in r["columns"].items():
            if "@" in key:
                key = key.split("@")[0] + "@<id>"
            agg = per_key.setdefault(key, {"abs": 0.0, "rel": 0.0, "n": 0, "bad": 0})
            agg["n"] += 1
            agg["abs"] = max(agg["abs"], c["abs"])
            agg["rel"] = max(agg["rel"], c["rel"])
            if not c["ok"]:
                agg["bad"] += 1
                if key not in KNOWN_DIFFERENCES:
                    failures.append(
                        f"{name}: {key} ({node or 'catchment'}) max |Δ| {c['abs']:.3g} (rel {c['rel']:.3g}) on day {c['day']}"
                        + (" (NaN on one side)" if c["nan"] else "")
                    )
    return {"per_key": per_key, "coverage": coverage, "refused": refused, "failures": failures, "known": known}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--random", type=int, default=int(os.environ.get("VERIFY_RANDOM", "20")))
    ap.add_argument("--seed", type=int, default=int(os.environ.get("VERIFY_SEED", "1")))
    ap.add_argument("--dense", type=int, default=int(os.environ.get("VERIFY_DENSE", "0")),
                    help="also N dense networks (every phase-2a feature in most)")
    ap.add_argument("--no-examples", action="store_true")
    ap.add_argument("--keep", type=Path, default=None, help="keep inputs and outputs here")
    ap.add_argument("--verbose", action="store_true", help="list series only the engine outputs")
    args = ap.parse_args(argv)

    tmp_ctx = tempfile.TemporaryDirectory(prefix="verify-") if args.keep is None else None
    tmp = Path(tmp_ctx.name) if tmp_ctx else args.keep
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        cases = build_cases(tmp, args.random, args.seed, not args.no_examples, args.dense)
        notes: list[str] = []
        r = evaluate(cases, model, notes)
    finally:
        if tmp_ctx:
            tmp_ctx.cleanup()

    per_key, failures = r["per_key"], r["failures"]
    print(
        f"verify: {len(cases)} cases ({'3 examples + ' if not args.no_examples else ''}{len(probes.PROBES)} probes + "
        f"{args.random} random + {args.dense} dense from seed {args.seed})"
    )
    if r["refused"]:
        print(f"{r['refused']} case(s) refused by both sides")
    print(f"tolerance: |Δ| ≤ {ATOL:g} + {RTOL:g} × column max")
    print(f"{'column':<30} {'series':>6} {'max |Δ|':>11} {'max rel':>10}  status")
    for key in sorted(per_key):
        a = per_key[key]
        status = "ok" if a["bad"] == 0 else (f"KNOWN ({KNOWN_DIFFERENCES[key]})" if key in KNOWN_DIFFERENCES else f"DIFF in {a['bad']}")
        print(f"{key:<30} {a['n']:>6} {a['abs']:>11.3g} {a['rel']:>10.3g}  {status}")
    print("\ncoverage (python side; total, cases with any):")
    print("  " + ", ".join(f"{k} {v[0]} ({v[1]})" for k, v in sorted(r["coverage"].items())))
    if args.verbose:
        for n_ in notes:
            print("note: " + n_)
    if r["known"]:
        print(f"\n{len(r['known'])} known difference(s), not failing:")
        for k_ in r["known"][:20]:
            print("  " + k_[:300])
    if failures:
        print(f"\n{len(failures)} disagreement(s):")
        for f in failures[:60]:
            print("  " + f)
        if len(failures) > 60:
            print(f"  … and {len(failures) - 60} more")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
