"""WR2012's WRSM2000 (Pitman) network configurations -> monthly S-pan and A-pan per quaternary, as a CSV.

    python scripts/wbt-import/wrsm_evaporation.py <network folder> [more …] --out evaporation.csv

    then: pnpm import:quaternary-evaporation evaporation.csv --dataset <label>

WR2012 (Water Resources of South Africa 2012 Study, WRC 2015) ships its
WRSM2000 network configurations as folders (and zips, sometimes nested) of
module files. Two kinds carry a quaternary's monthly evaporation:

  RU  runoff module      `…RU<n>.DAT`  line 4: 12 monthly Symons-pan (S-pan) depths, mm, October first
  RR  irrigation module  `…RR<n>.DAT`  line 8: 12 monthly Class-A pan (A-pan) depths, mm, October first
                                       (line 7 is a factor row, line 9 crop factors)

Line 1 is `<n> '<label>' …`, and the label names the quaternaries the module
stands for: `'Z40A,B'`, `'Runoff Z22F High MAP'`, `'CR Z24G-K'`, `'DRR Z40A,B'`
(a list after the first, and ranges). Other modules (RV, CR, …) repeat the
S-pan with lake factors and are not read.

Skipped, counted: a module whose row isn't 12 numbers, a flat placeholder row
(all 12 the same, e.g. 100), a total outside 300–4000 mm, a label naming no
quaternary (forestry, alien vegetation sub-modules). The same file met twice
(a zip inside a folder that also holds it unzipped) is read once, by content.
Where several modules name one quaternary and disagree, the row most of them
give is kept (ties: the first by file name) and the others' annual totals are
listed (`*_other_totals`), with how many modules there were and how many agree.

Output columns (what `backend/src/geo/loadQuaternaryEvaporation.ts` reads):
code,wma,span_total_mm,span_oct … span_sep,apan_total_mm,apan_oct … apan_sep,
apan_over_span,span_modules,span_agree,span_other_totals,apan_modules,
apan_agree,apan_other_totals,span_files,apan_files. A quaternary without one
of the two leaves those columns empty. Python stdlib only. Real WR2012 files
and their values are never committed: the repo is public.
"""

import argparse
import csv
import hashlib
import io
import re
import sys
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

MONTHS = ["oct", "nov", "dec", "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep"]
MODULE = re.compile(r"(RU|RR)\d+\.DAT$", re.I)
ROW_LINE = {"RU": 3, "RR": 7}
NAME = {"RU": "span", "RR": "apan"}
TOTAL_RANGE = (300, 4000)
# A drainage region and two digits, then the first quaternary letter and any more after it (lists, ranges), in
# capitals; a lower-case letter after one is a part of it ('Z10Ja', 'forestry Z10Db'), the same quaternary.
QUATS = re.compile(r"([A-Z]\d\d)([A-M](?:\s*[-,&/]\s*[A-M](?![A-Z\d]))*)(?![A-Z\d])")
COLUMNS = (
    ["code", "wma", "span_total_mm"]
    + [f"span_{m}" for m in MONTHS]
    + ["apan_total_mm"]
    + [f"apan_{m}" for m in MONTHS]
    + ["apan_over_span", "span_modules", "span_agree", "span_other_totals", "apan_modules", "apan_agree", "apan_other_totals", "span_files", "apan_files"]
)


def quaternaries(label):
    """The quaternary codes a module's label names: 'Z40A,B' -> Z40A, Z40B; 'CR Z24G-K' -> Z24G … Z24K."""
    out = set()
    # A label all in lower case ('fdam irrg z40b') is read in capitals.
    for m in QUATS.finditer(label) if QUATS.search(label) else QUATS.finditer(label.upper()):
        region, tail = m.group(1), re.sub(r"\s", "", m.group(2))
        toks = re.findall(r"[A-M]|[-,&/]", tail)
        prev = None
        i = 0
        while i < len(toks):
            t = toks[i]
            if t == "-" and prev and i + 1 < len(toks):
                for c in range(ord(prev) + 1, ord(toks[i + 1]) + 1):
                    out.add(region + chr(c))
                prev = toks[i + 1]
                i += 2
                continue
            if t not in "-,&/":
                out.add(region + t)
                prev = t
            i += 1
    return sorted(q for q in out if not q.endswith(("I", "O")))


def twelve(line):
    parts = line.split()
    if len(parts) != 12:
        return None
    try:
        return [float(x) for x in parts]
    except ValueError:
        return None


def module(name, raw):
    """One module file: (kind, label, the 12 values) or (kind, label, why it is skipped)."""
    kind = MODULE.search(name).group(1).upper()
    lines = raw.decode("latin-1").replace("\r", "").split("\n")
    lab = re.search(r"'([^']*)'", lines[0]) if lines else None
    label = lab.group(1) if lab else ""
    row = twelve(lines[ROW_LINE[kind]]) if len(lines) > ROW_LINE[kind] else None
    if row is None:
        return kind, label, "no row of 12 numbers"
    if not quaternaries(label):
        return kind, label, "no quaternary in its label"
    if len(set(row)) == 1:
        return kind, label, "a flat placeholder row"
    if not TOTAL_RANGE[0] < sum(row) < TOTAL_RANGE[1]:
        return kind, label, "an implausible annual total"
    return kind, label, row


def _walk_zip(data, where, out):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            inner = f"{where}/{info.filename}"
            if info.filename.lower().endswith(".zip"):
                _walk_zip(z.read(info), inner, out)
            elif MODULE.search(info.filename):
                out.append((inner, z.read(info)))


def module_files(roots):
    """Every RU/RR module file under the roots (folders, zips, nested zips), as (path, bytes)."""
    out = []
    for root in roots:
        root = Path(root)
        paths = [root] if root.is_file() else sorted(p for p in root.rglob("*") if p.is_file())
        for p in paths:
            if p.suffix.lower() == ".zip":
                _walk_zip(p.read_bytes(), str(p), out)
            elif MODULE.search(p.name):
                out.append((str(p), p.read_bytes()))
    return out


def wma_of(path, roots):
    """The first folder (or zip, without its .zip) under the root the module sits in: the WMA's own, or ''."""
    for r in roots:
        r = str(Path(r))
        if path.startswith(r + "/"):
            rest = path[len(r) + 1 :].split("/")
            return re.sub(r"\.zip$", "", rest[0], flags=re.I) if len(rest) > 1 else ""
    return ""


def summarise(files, roots=()):
    """Per quaternary the majority S-pan and A-pan rows, with their provenance; and the skip counts."""
    seen = set()
    skipped = Counter()
    by = defaultdict(lambda: {"RU": [], "RR": []})
    for path, raw in sorted(files, key=lambda f: f[0]):
        h = hashlib.sha256(raw).hexdigest()
        if h in seen:
            skipped["the same file again"] += 1
            continue
        seen.add(h)
        kind, label, got = module(Path(path).name, raw)
        if isinstance(got, str):
            skipped[f"{kind}: {got}"] += 1
            continue
        for q in quaternaries(label):
            by[q][kind].append({"values": tuple(got), "file": Path(path).name, "wma": wma_of(path, roots)})
    rows = []
    for code in sorted(by):
        rec = {k: "" for k in COLUMNS}
        rec["code"] = code
        rec["wma"] = " ".join(sorted({m["wma"] for k in ("RU", "RR") for m in by[code][k] if m["wma"]}))
        totals = {}
        for kind, name in NAME.items():
            mods = by[code][kind]
            if not mods:
                continue
            counts = Counter(m["values"] for m in mods)
            top, n = max(counts.items(), key=lambda kv: (kv[1], -[m["values"] for m in mods].index(kv[0])))
            totals[name] = sum(top)
            rec[f"{name}_total_mm"] = _fmt(sum(top))
            for m, v in zip(MONTHS, top):
                rec[f"{name}_{m}"] = _fmt(v)
            rec[f"{name}_modules"] = str(len(mods))
            rec[f"{name}_agree"] = str(n)
            rec[f"{name}_other_totals"] = " ".join(_fmt(round(sum(v))) for v in sorted({v for v in counts if v != top}, key=sum))
            rec[f"{name}_files"] = " ".join(sorted({m["file"] for m in mods if m["values"] == top}))
        if "span" in totals and "apan" in totals:
            rec["apan_over_span"] = f"{totals['apan'] / totals['span']:.3f}"
        rows.append(rec)
    return rows, skipped


def _fmt(x):
    return str(int(x)) if float(x).is_integer() else f"{x:.6g}"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("roots", nargs="+", help="WRSM2000 network folders or zips")
    ap.add_argument("--out", required=True, help="the CSV to write")
    a = ap.parse_args(argv)
    files = module_files(a.roots)
    if not files:
        print("no RU or RR module file found", file=sys.stderr)
        return 1
    rows, skipped = summarise(files, a.roots)
    with open(a.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    print(f"{len(rows)} quaternaries written to {a.out}: {sum(1 for r in rows if r['span_oct'])} with S-pan, {sum(1 for r in rows if r['apan_oct'])} with A-pan")
    disagree = [r["code"] for r in rows if r["span_other_totals"] or r["apan_other_totals"]]
    if disagree:
        print(f"  {len(disagree)} with modules that disagree (the majority row kept): {', '.join(disagree)}")
    for why, n in sorted(skipped.items()):
        print(f"  skipped {n} module file(s): {why}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
