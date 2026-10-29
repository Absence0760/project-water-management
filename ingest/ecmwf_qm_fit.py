"""The offline quantile-mapping fit for the ECMWF forecast (issue #604 D17,
R4-C): "quantile-mapped to our corrected rain".

Run by the operator, not on a schedule, once the copy has archived a few
months of forecasts (ecmwf_forecast.py keeps every issue's ensemble mean). It pairs
each archived forecast day with our rain for the same 0.1 deg cell and day,
and writes the quantile pairs that map one distribution onto the other, per
region and season, to `ecmwf/qm.json` in the copy. The feed applies them
(backend/src/feeds/fromMirrorEcmwf.ts); with no file it applies none and
labels the forecast "not yet calibrated".

    ingest/.venv/bin/python ingest/ecmwf_qm_fit.py --copy <dir> --mirror <url> [options]

  --copy DIR         a local copy holding `ecmwf/` and the observed product
                     (aws s3 sync of the mirror bucket's `ecmwf/` and `sat/`
                     prefixes, docs/deployment.md § ECMWF)
  --mirror URL       where qm.json goes: file:///abs/path or s3://bucket
                     (default: the --copy directory)
  --observed P       the observed product in the copy: `sat` (default; the
                     CHIRPS v3 finals, else `prelim` on days with no final)
  --scale X          multiply the observed rain by X first (the catchment's
                     CHIRPS bias correction, when the fit is for one; default 1)
  --regions FILE     JSON list of {"id", "region": {w, s, e, n}}; default the
                     whole region D1
  --cell-stride N    use every Nth cell each way (default 5: 1/25 of the cells)
  --min-samples N    a group with fewer pairs is left out (default 2000)
  --dry-run          print the file instead of writing it

**The method.** Empirical quantile mapping of daily totals. Within a group
(a region box and a season, DJF/MAM/JJA/SON, by the forecast day's month),
the forecast's and the observations' quantiles at the same probabilities
(0, 0.01, … 1) make the pairs (f, o). Forecast quantiles that tie (dry
days: many zeros) collapse to one pair with the mean of their observed
quantiles, and o is made non-decreasing, so the mapping is monotone. All
lead days are pooled; the forecasts are the ensemble mean. Applying a
monotone mapping to a quantile of the ensemble is exact (the quantile of the
mapped members); applied to the mean it is the usual approximation.

**Applying it** (the same rule in fromMirrorEcmwf.ts `applyQm`): linear
between pairs; past the last pair, the last pair's offset (o - f) carried
on; below the first, scaled towards 0 (or the first o when f starts at 0);
never below 0.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ecmwf_forecast  # noqa: E402
import zarrstore  # noqa: E402

SEASONS = {"DJF": (12, 1, 2), "MAM": (3, 4, 5), "JJA": (6, 7, 8), "SON": (9, 10, 11)}
PROBABILITIES = np.linspace(0.0, 1.0, 101)
METHOD = "empirical quantile mapping of daily totals: ensemble mean, all lead days pooled, per region and season (ingest/ecmwf_qm_fit.py)"


def fit_pairs(forecast: np.ndarray, observed: np.ndarray, probabilities: np.ndarray = PROBABILITIES) -> list[list[float]]:
    """The (f, o) pairs mapping `forecast`'s distribution onto `observed`'s:
    f strictly increasing, o non-decreasing, both mm to 3 decimals."""
    f = np.asarray(forecast, dtype=np.float64).ravel()
    o = np.asarray(observed, dtype=np.float64).ravel()
    if f.size == 0 or o.size == 0:
        raise ValueError("no samples to fit")
    qf = np.round(np.quantile(f, probabilities), 3)
    qo = np.quantile(o, probabilities)
    pairs: list[list[float]] = []
    for x in np.unique(qf):
        pairs.append([float(x), float(qo[qf == x].mean())])
    ys = np.maximum.accumulate(np.maximum([p[1] for p in pairs], 0.0))
    return [[p[0], round(float(y), 3)] for p, y in zip(pairs, ys)]


def apply(pairs: list[list[float]], x: float) -> float:
    """The mapped value of `x` (see the module docstring)."""
    if not pairs:
        return x
    fs = [p[0] for p in pairs]
    os_ = [p[1] for p in pairs]
    if x >= fs[-1]:
        y = os_[-1] + (x - fs[-1])
    elif x <= fs[0]:
        y = os_[0] if fs[0] <= 0 else os_[0] * (x / fs[0])
    else:
        y = float(np.interp(x, fs, os_))
    return max(0.0, y)


def season_of(month: int) -> str:
    return next(s for s, months in SEASONS.items() if month in months)


def _coarsen(day: np.ndarray) -> np.ndarray:
    """A 0.05 deg day (550, 620) as the 0.1 deg cells (275, 310): the mean of
    the four 0.05 deg cells each holds (NaN if any is)."""
    return day.reshape(ecmwf_forecast.ROWS, 2, ecmwf_forecast.COLS, 2).mean(axis=(1, 3))


def _observed_day(root: Path, product: str, day: dt.date) -> np.ndarray | None:
    import zarr

    got = zarrstore.read_finals(root, product, day, 1) if (root / product / "zarr.json").exists() else None
    v = None if got is None else got[0]
    if (v is None or np.isnan(v).all()) and (root / "prelim" / "zarr.json").exists():
        arr = zarr.open_array(store=zarr.storage.LocalStore(root), path="prelim", mode="r", zarr_format=3)
        i = (day - dt.date.fromisoformat(arr.attrs["firstDay"])).days
        if 0 <= i < arr.shape[0]:
            v = np.asarray(arr[i])
    if v is None or np.isnan(v).all():
        return None
    return _coarsen(v)


def _mask(region: dict, stride: int) -> tuple[np.ndarray, np.ndarray]:
    """The (row, col) indices of the 0.1 deg cells whose centre lies in `region`, every `stride`th."""
    lats = ecmwf_forecast.ORIGIN["lat"] + np.arange(ecmwf_forecast.ROWS) * ecmwf_forecast.STEP_DEG
    lons = ecmwf_forecast.ORIGIN["lon"] + np.arange(ecmwf_forecast.COLS) * ecmwf_forecast.STEP_DEG
    rows = np.nonzero((lats >= region["s"]) & (lats <= region["n"]))[0][::stride]
    cols = np.nonzero((lons >= region["w"]) & (lons <= region["e"]))[0][::stride]
    return rows, cols


def fit(root: Path, observed: str = "sat", regions: list[dict] | None = None, stride: int = 5, min_samples: int = 2000, scale: float = 1.0, fitted_at: str | None = None) -> dict:
    """qm.json's document from a local copy (see the module docstring)."""
    regions = regions or [{"id": "D1", "region": dict(ecmwf_forecast.REGION)}]
    doc = json.loads((root / ecmwf_forecast.INDEX_KEY).read_text()) if (root / ecmwf_forecast.INDEX_KEY).exists() else {"issues": [], "archived": []}
    issues = sorted(set(doc.get("issues", [])) | set(doc.get("archived", [])))
    samples: dict[tuple[str, str], tuple[list, list]] = {}
    obs_cache: dict[dt.date, np.ndarray | None] = {}
    used: list[str] = []
    for iso in issues:
        issue = dt.date.fromisoformat(iso)
        mean = ecmwf_forecast.read_issue(root, iso, "mean")
        any_day = False
        for d in range(ecmwf_forecast.DAYS):
            day = issue + dt.timedelta(days=d)
            if day not in obs_cache:
                o = _observed_day(root, observed, day)
                obs_cache[day] = None if o is None else o * scale
            o = obs_cache[day]
            if o is None:
                continue
            for r in regions:
                rows, cols = _mask(r["region"], stride)
                fv = mean[d][np.ix_(rows, cols)].ravel()
                ov = o[np.ix_(rows, cols)].ravel()
                ok = np.isfinite(fv) & np.isfinite(ov)
                if ok.any():
                    any_day = True
                    bucket = samples.setdefault((r["id"], season_of(day.month)), ([], []))
                    bucket[0].append(fv[ok])
                    bucket[1].append(ov[ok])
        if any_day:
            used.append(iso)
    groups = []
    for r in regions:
        for season, months in SEASONS.items():
            got = samples.get((r["id"], season))
            if not got:
                continue
            f, o = np.concatenate(got[0]), np.concatenate(got[1])
            if f.size < min_samples:
                continue
            pairs = fit_pairs(f, o)
            if len(pairs) < 2:  # a forecast that never varies (all dry) maps nothing
                continue
            groups.append({"id": f"{r['id']}-{season}", "region": dict(r["region"]), "months": list(months), "samples": int(f.size), "pairs": pairs})
    return {
        "v": 1,
        "product": "ecmwf",
        "stat": "mean",
        "fittedAt": fitted_at or dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "method": METHOD,
        "observed": {"product": observed, "fallback": "prelim", "scale": scale},
        "forecasts": {"issues": len(used), "first": used[0] if used else None, "last": used[-1] if used else None},
        "groups": groups,
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Fit ECMWF forecast quantile mapping to our rain; writes ecmwf/qm.json.")
    p.add_argument("--copy", required=True, type=Path)
    p.add_argument("--mirror")
    p.add_argument("--observed", default="sat", choices=["sat", "rnl", "prelim"])
    p.add_argument("--scale", type=float, default=1.0)
    p.add_argument("--regions", type=Path)
    p.add_argument("--cell-stride", type=int, default=5)
    p.add_argument("--min-samples", type=int, default=2000)
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)
    if not 0 < a.scale <= 5:
        p.error("--scale must be in (0, 5]")
    regions = json.loads(a.regions.read_text()) if a.regions else None
    doc = fit(a.copy.resolve(), a.observed, regions, a.cell_stride, a.min_samples, a.scale)
    if not doc["groups"]:
        print("no group had enough forecast days with observed rain; nothing written", file=sys.stderr)
        return 1
    if a.dry_run:
        print(json.dumps(doc, indent=2))
        return 0
    mirror = zarrstore.Mirror.from_url(a.mirror or a.copy.resolve().as_uri())
    mirror.write_json(ecmwf_forecast.QM_KEY, doc)
    print(f"wrote {ecmwf_forecast.QM_KEY}: {len(doc['groups'])} groups from {doc['forecasts']['issues']} issues", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
