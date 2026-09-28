// Dynamically Dimensioned Search (Tolson & Shoemaker 2007, "Dynamically
// dimensioned search algorithm for computationally efficient watershed model
// calibration", Water Resour. Res. 43, W01413, doi:10.1029/2005WR004723).
//
// A greedy, single-solution global search built for a fixed budget of model
// runs. Early on it perturbs every parameter; as the budget is spent it
// perturbs fewer (each with probability 1 − ln i / ln m), so it moves from a
// global to a local search on its own. Its one setting, the perturbation size
// r = 0.2, is the paper's recommended value. Candidates are reflected back
// into the bounds, so no evaluated point is ever outside them. Deterministic
// for a seed.
import { Rng } from '../random';

export interface Bounds {
	min: number;
	max: number;
}

export interface DdsOptions {
	/** Objective evaluations, including the initial ones. Default 1 500. */
	budget?: number;
	seed?: number;
	/** Perturbation size as a fraction of each parameter's range. Default 0.2. */
	r?: number;
	/** Starting point; else the best of max(5, 0.5 % of the budget) uniform samples. */
	x0?: ArrayLike<number>;
	/** Called after every evaluation; return true to stop early (cancel). */
	onEvaluation?: (evaluations: number, best: number) => boolean | void;
}

export interface DdsResult {
	/** Best point found. */
	x: number[];
	/** Its objective value (minimised). */
	f: number;
	evaluations: number;
	/** True if onEvaluation asked to stop before the budget was spent. */
	stopped: boolean;
}

/** Reflect a perturbed value back inside [min, max] (Tolson & Shoemaker's rule). */
export function reflect(v: number, { min, max }: Bounds): number {
	if (v < min) {
		const x = min + (min - v);
		return x > max ? min : x;
	}
	if (v > max) {
		const x = max - (v - max);
		return x < min ? max : x;
	}
	return v;
}

/** Minimise `f` over the box `bounds`. A non-finite objective counts as +∞. */
export function dds(f: (x: Float64Array) => number, bounds: Bounds[], opts: DdsOptions = {}): DdsResult {
	const n = bounds.length;
	const budget = Math.max(1, Math.floor(opts.budget ?? 1500));
	const r = opts.r ?? 0.2;
	const rng = new Rng(opts.seed ?? 1);
	const score = (x: Float64Array) => {
		const v = f(x);
		return Number.isFinite(v) ? v : Infinity;
	};

	let evals = 0;
	let stopped = false;
	const tick = (best: number) => {
		evals++;
		if (opts.onEvaluation?.(evals, best)) stopped = true;
	};

	const best = new Float64Array(n);
	let fBest = Infinity;
	const cand = new Float64Array(n);
	if (opts.x0) {
		for (let d = 0; d < n; d++) best[d] = Math.min(bounds[d]!.max, Math.max(bounds[d]!.min, opts.x0[d]!));
		fBest = score(best);
		tick(fBest);
	} else {
		const starts = Math.min(budget, Math.max(5, Math.ceil(0.005 * budget)));
		for (let k = 0; k < starts && !stopped; k++) {
			for (let d = 0; d < n; d++) cand[d] = rng.float(bounds[d]!.min, bounds[d]!.max);
			const fc = score(cand);
			if (fc < fBest || k === 0) {
				fBest = fc;
				best.set(cand);
			}
			tick(fBest);
		}
	}

	const m = budget;
	while (evals < m && !stopped) {
		const i = evals; // 1 … m − 1
		const p = 1 - Math.log(i) / Math.log(m);
		cand.set(best);
		let any = false;
		for (let d = 0; d < n; d++) {
			if (rng.next() < p) {
				cand[d] = reflect(best[d]! + r * (bounds[d]!.max - bounds[d]!.min) * rng.normal(), bounds[d]!);
				any = true;
			}
		}
		if (!any) {
			const d = rng.int(0, n - 1);
			cand[d] = reflect(best[d]! + r * (bounds[d]!.max - bounds[d]!.min) * rng.normal(), bounds[d]!);
		}
		const fc = score(cand);
		if (fc <= fBest) {
			fBest = fc;
			best.set(cand);
		}
		tick(fBest);
	}
	return { x: Array.from(best), f: fBest, evaluations: evals, stopped };
}
