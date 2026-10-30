"""Run verify/model.py and the engine's `runModel` on the same inputs and
report, per output column, the largest absolute and relative difference.

    python3 verify/diff.py [--random N] [--dense N] [--seed S] [--no-examples] [--keep DIR] [--workers N]

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
import time
import types
from concurrent.futures import ProcessPoolExecutor
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

def default_workers() -> int:
    """VERIFY_WORKERS, else the cores this process may use, at most 4 (CI's
    runner has 4; a shared laptop shouldn't lose all of its cores to a check).
    The results never depend on it: every case is a fixed seed, and the
    results are merged in case order."""
    env = os.environ.get("VERIFY_WORKERS")
    if env:
        return max(1, int(env))
    return max(1, min(4, os.process_cpu_count() or 1))


def run_engine(pairs: list[tuple[Path, Path]], workers: int = 1) -> None:
    """runModel on every (input, output) pair: one tsx process per worker,
    each given every `workers`-th pair, run at once."""
    tsx = ROOT / "backend" / "node_modules" / ".bin" / "tsx"
    procs = []
    for w in range(max(1, min(workers, len(pairs)))):
        args = [str(tsx), str(HERE / "run_engine.ts"), "run"]
        for a, b in pairs[w::workers]:
            args += [str(a), str(b)]
        procs.append(subprocess.Popen(args, cwd=ROOT))
    codes = [p.wait() for p in procs]
    if any(codes):
        raise subprocess.CalledProcessError(next(c for c in codes if c), "tsx verify/run_engine.ts run")


def example_inputs(tmp: Path) -> list[Path]:
    tsx = ROOT / "backend" / "node_modules" / ".bin" / "tsx"
    tmp.mkdir(parents=True, exist_ok=True)
    subprocess.run([str(tsx), str(HERE / "run_engine.ts"), "examples", str(tmp)], check=True, cwd=ROOT)
    return sorted(tmp.glob("*.input.json"))


def _num(v):
    return math.nan if v is None else float(v)


def _dam_noise(node, ps: dict, es: dict):
    """An empty dam's float noise (verify/README.md § Tolerance). A dam whose
    start-of-day storage is within ATOL of 0 on both sides has a noise-level
    area, so its area, the rain on it and its evaporation that day are noise.
    Over a wet spell that rain grows the storage past ATOL (an exponent of
    0.53 turns 8.5e-14 m³ into 1.2e-5 m³ in two days: dense seed 206), and
    the next days' areas follow. So the water that came from a noise area is
    carried as noise, never more than the storage, until the dam lets it go:
    each side's storage net of it decides the next noise day and is what the
    storage comparison reads. Returns (noise days, net storage python,
    net storage engine, and the water the two sides' noise areas gained
    apart: Σ |Δ(rain on the dam − evaporation)| over the noise days)."""
    qa, qb = ps[(node, "dam_storage")], es[(node, "dam_storage")]
    n = len(qa)

    def flow(src, key, d):
        v = src.get((node, key))
        x = _num(v[d]) if v is not None and d < len(v) else 0.0
        return 0.0 if math.isnan(x) else x

    net_a, net_b = [_num(v) for v in qa], [_num(v) for v in qb]
    carry = [0.0, 0.0]
    days = set()
    apart = 0.0
    for d in range(n):
        noise = d > 0 and abs(net_a[d - 1]) <= ATOL and abs(net_b[d - 1]) <= ATOL
        gains = [0.0, 0.0]
        if noise:
            days.add(d)
            gains = [flow(src, "rain_on_dam", d) - flow(src, "dam_evaporation", d) for src in (ps, es)]
            apart += abs(gains[0] - gains[1])
        for j, (q, net) in enumerate(((qa, net_a), (qb, net_b))):
            s_ = _num(q[d])
            c = carry[j] + gains[j]
            c = min(max(c, 0.0), max(s_, 0.0)) if not math.isnan(s_) else 0.0
            carry[j] = c
            net[d] = s_ - c
    return days, net_a, net_b, apart


def compare(py: dict, eng: dict) -> dict:
    """Per (nodeId, key): max abs diff, scale and whether it agrees."""
    res = {"window": None, "columns": {}, "only_python": [], "only_engine": []}
    if (py["startDate"], py["endDate"], py["days"]) != (eng["startDate"], eng["endDate"], eng["days"]):
        res["window"] = f"python {py['startDate']}…{py['endDate']} ({py['days']}) vs engine {eng['startDate']}…{eng['endDate']} ({eng['days']})"
        return res
    ps = {(s["nodeId"], s["key"]): s["values"] for s in py["series"]}
    es = {(s["nodeId"], s["key"]): s["values"] for s in eng["series"]}
    # Each dam's float-noise episodes, and the water they put into the two sides apart (README § Tolerance):
    # whatever a dam then does with that water (draws it for demand, pumps less, spills it), no column of the
    # case can be further apart than it, so it widens this case's tolerance by exactly that amount; 0 in a case
    # with no such episode.
    dam_noise = {nid: _dam_noise(nid, ps, es) for nid, key in ps if key == "dam_storage" and (nid, key) in es}
    noise_water = sum(v[3] for v in dam_noise.values())
    res["noise_water"] = noise_water
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
        if k[1] in ("dam_area", "rain_on_dam", "dam_evaporation", "dam_storage") and (k[0], "dam_storage") in ps and (k[0], "dam_storage") in es:
            noise_days, net_a, net_b, _ = dam_noise[k[0]]
            if k[1] == "dam_storage":
                # The storage is compared net of the water that came from a noise area (README § Tolerance).
                a, b, noise_days = net_a, net_b, set()
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
        tol = ATOL + RTOL * scale + noise_water
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


def compare_summary(py: dict, eng: dict | None) -> tuple[dict, list[str]]:
    """RunSummary.allocations' run-dependent parts (model.md §2.12a): per
    capped unit and source the years the cap bound (`capReached`) and the
    days each limit held use back (`limitBound`); per scaled unit the demand
    and volume of each water year (`scaled`). Returns per-part (worst |Δ|,
    ok) and the disagreements."""
    parts: dict[str, list] = {}
    bad: list[str] = []
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


def build_cases(tmp: Path, n_random: int, seed: int, examples: bool, n_dense: int = 0, workers: int = 1) -> list[tuple[str, Path, Path]]:
    """Write every case's input, run the engine on all of them (`workers` tsx
    processes), and return (name, input path, engine output path)."""
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
    run_engine([(p, e) for _, p, e in out], workers)
    return out


def _case_result(case, impl) -> dict:
    """One case's share of `evaluate`'s result: its column aggregates, coverage
    counts, refusal, failures and notes. `_merge` adds these up in case order,
    so the result is the same whatever process computed each case."""
    name, p, eng_path = case
    per_key: dict[str, dict] = {}
    coverage: dict[str, list[int]] = {}
    failures: list[str] = []
    notes: list[str] = []
    out = {"per_key": per_key, "coverage": coverage, "refused": 0, "failures": failures, "notes": notes}
    doc = json.loads(p.read_text())
    eng = json.loads(eng_path.read_text())
    try:
        py = impl.run(doc)
    except impl.Refused as e:
        if "error" not in eng:
            failures.append(f"{name}: python refuses the run ({e}), the engine runs it")
        out["refused"] = 1
        return out
    if "error" in eng:
        failures.append(f"{name}: the engine refuses the run ({eng['error']}), python runs it")
        return out
    for k, v in py.get("diag", {}).items():
        c = coverage.setdefault(k, [0, 0])
        c[0] += v
        c[1] += 1 if v else 0
    r = compare(py, eng)
    if r["window"]:
        failures.append(f"{name}: run window {r['window']}")
        return out
    for k in r["only_python"]:
        failures.append(f"{name}: {k[1]} ({k[0] or 'catchment'}) only in python")
    for k in r["only_engine"]:
        notes.append(f"{name}: {k[1]} ({k[0] or 'catchment'}) only in the engine's output")
    parts, bad = compare_summary(py.get("summary") or {}, eng.get("allocations"))
    failures.extend(f"{name}: {b}" for b in bad)
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
    return out


def _merge(total: dict, part: dict, notes) -> None:
    for key, a in part["per_key"].items():
        agg = total["per_key"].setdefault(key, {"abs": 0.0, "rel": 0.0, "n": 0, "bad": 0})
        agg["abs"] = max(agg["abs"], a["abs"])
        agg["rel"] = max(agg["rel"], a["rel"])
        agg["n"] += a["n"]
        agg["bad"] += a["bad"]
    for k, (v, any_) in part["coverage"].items():
        c = total["coverage"].setdefault(k, [0, 0])
        c[0] += v
        c[1] += any_
    total["refused"] += part["refused"]
    total["failures"].extend(part["failures"])
    if notes is not None:
        notes.extend(part["notes"])


def _model_case(case) -> dict:
    return _case_result(case, model)


class Progress:
    """A line per batch of cases (and when a group finishes), flushed, so a
    long run shows it is alive and where it is: `random 50/200 ok, 3m05s`."""

    def __init__(self, label: str, cases, every: int = 25):
        self.label, self.every, self.t0 = label, every, time.monotonic()
        self.total: dict[str, int] = {}
        for c in cases:
            g = self.group(c[0])
            self.total[g] = self.total.get(g, 0) + 1
        self.done = {g: 0 for g in self.total}
        self.bad = {g: 0 for g in self.total}

    @staticmethod
    def group(name: str) -> str:
        for g in ("probe", "random", "dense"):
            if name.startswith(g + "-"):
                return g
        return "example"

    def elapsed(self) -> str:
        s = int(time.monotonic() - self.t0)
        return f"{s // 60}m{s % 60:02d}s"

    def __call__(self, name: str, failed: bool) -> None:
        g = self.group(name)
        self.done[g] += 1
        self.bad[g] += 1 if failed else 0
        n, of = self.done[g], self.total[g]
        if n % self.every == 0 or n == of:
            state = "ok" if not self.bad[g] else f"{self.bad[g]} failing"
            print(f"{self.label}: {g} {n}/{of} {state}, {self.elapsed()}", flush=True)


def evaluate(cases, impl=model, notes=None, stop_first=False, workers: int = 1, progress=None) -> dict:
    """Compare `impl` (verify/model.py, or a mutant of it in the self-test)
    with the engine's stored outputs. `stop_first` returns at the first case
    that disagrees (all a mutant needs). `workers` > 1 runs verify/model.py
    (only it, never a mutant: that is `mutants_caught`'s job) on that many
    processes; the result, failures in case order included, is the same.
    `progress(name, failed)` is called after each case."""
    total = {"per_key": {}, "coverage": {}, "refused": 0, "failures": []}
    if workers > 1 and len(cases) > 1 and not stop_first:
        if impl is not model:
            raise ValueError("evaluate runs only verify/model.py on several workers")
        with ProcessPoolExecutor(max_workers=workers) as pool:
            parts = pool.map(_model_case, cases)
            for case, part in zip(cases, parts):
                _merge(total, part, notes)
                if progress:
                    progress(case[0], bool(part["failures"]))
        return total
    for case in cases:
        if stop_first and total["failures"]:
            break
        part = _case_result(case, impl)
        _merge(total, part, notes)
        if progress:
            progress(case[0], bool(part["failures"]))
    return total


def build_mutant(*edits: tuple[str, str]) -> types.ModuleType:
    """verify/model.py with each (text, replacement) edit applied in order;
    each text must occur exactly once when its edit is applied."""
    src = (HERE / "model.py").read_text()
    for old, new in edits:
        if src.count(old) != 1:
            raise AssertionError(f"mutant text found {src.count(old)} times in model.py: {old!r}")
        src = src.replace(old, new)
    mod = types.ModuleType("model_mutant")
    mod.__file__ = str(HERE / "model.py")
    sys.modules["model_mutant"] = mod
    exec(compile(src, "model_mutant", "exec"), mod.__dict__)
    return mod


_mutant_cases: list = []


def _init_mutant_worker(cases) -> None:
    global _mutant_cases
    _mutant_cases = cases


def _mutant_result(edits) -> tuple[str | None, list[str]]:
    """(an error building the mutant, or None; the first disagreement it causes)."""
    try:
        mod = build_mutant(*edits)
    except AssertionError as e:
        return str(e), []
    return None, evaluate(_mutant_cases, mod, stop_first=True)["failures"][:1]


def mutants_caught(cases, mutants: list[list[tuple[str, str]]], workers: int = 1, progress=None) -> list[tuple[str | None, list[str]]]:
    """Per mutant (a list of edits), in order: (an error building it, or None;
    the first case it disagrees on, empty when no case sees it). Each mutant
    runs the cases in order and stops at its first disagreement, on one of
    `workers` processes; `progress(i, caught)` is called after each."""
    out = []
    if workers > 1 and len(mutants) > 1:
        with ProcessPoolExecutor(max_workers=workers, initializer=_init_mutant_worker, initargs=(cases,)) as pool:
            for i, r in enumerate(pool.map(_mutant_result, mutants)):
                out.append(r)
                if progress:
                    progress(i, bool(r[1]))
        return out
    _init_mutant_worker(cases)
    for i, edits in enumerate(mutants):
        r = _mutant_result(edits)
        out.append(r)
        if progress:
            progress(i, bool(r[1]))
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--random", type=int, default=int(os.environ.get("VERIFY_RANDOM", "20")))
    ap.add_argument("--seed", type=int, default=int(os.environ.get("VERIFY_SEED", "1")))
    ap.add_argument("--dense", type=int, default=int(os.environ.get("VERIFY_DENSE", "0")),
                    help="also N dense networks (every phase-2a feature in most)")
    ap.add_argument("--no-examples", action="store_true")
    ap.add_argument("--keep", type=Path, default=None, help="keep inputs and outputs here")
    ap.add_argument("--verbose", action="store_true", help="list series only the engine outputs")
    ap.add_argument("--workers", type=int, default=default_workers(),
                    help="processes for the engine and the Python model (VERIFY_WORKERS; default the cores, at most 4)")
    args = ap.parse_args(argv)

    tmp_ctx = tempfile.TemporaryDirectory(prefix="verify-") if args.keep is None else None
    tmp = Path(tmp_ctx.name) if tmp_ctx else args.keep
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        cases = build_cases(tmp, args.random, args.seed, not args.no_examples, args.dense, args.workers)
        notes: list[str] = []
        r = evaluate(cases, model, notes, workers=args.workers, progress=Progress("verify", cases))
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
    if failures:
        print(f"\n{len(failures)} disagreement(s):")
        for f in failures[:60]:
            print("  " + f)
        if len(failures) > 60:
            print(f"  … and {len(failures) - 60} more")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
