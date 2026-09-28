// −dQ/dt against Q on recession segments, and the power law −dQ/dt = a·Q^b
// fitted to the whole point cloud (engine ≥ 1.18.0, docs/model.md §2.10d
// "Recession diagnostics"; calibration-research.md CR-13).
//
// A port of TOSSH (Gnann et al. 2021): util_dQdt.m for the rate of change and
// util_FitPowerLaw.m, fitting_type 'linear', for the fit, with
// sig_RecessionAnalysis.m's defaults: dQdt_method 'ETS', fit_individual false
// (one curve through every segment's points). Time is in days, flow in m³/s,
// so −dQ/dt is in m³/s per day and a in (m³/s)^(1−b) per day.
//
// Methods (util_dQdt):
//   BN        Brutsaert & Nieber (1977): −dQ/dt = Q(t−1) − Q(t), at the mean
//             of the pair, (Q(t−1) + Q(t)) ÷ 2;
//   backwards the same difference at the measured Q(t) (Thomas et al. 2015);
//   ETS       exponential time stepping (Roques et al. 2017), TOSSH's default:
//             from each day i of a segment of L days, the slope of a straight
//             line through Q(i … i + m) (least squares), at their mean, with
//             m = 1 + ⌈0.1·L·exp(−1 ÷ (γ·k))⌉ for the k-th day (1-based) and
//             γ the segment's exponential decay rate, fitted in semilog space
//             through its first day; each point weighted by that line's R².
// Points whose −dQ/dt is not positive are dropped, as TOSSH does.
//
// The fit (util_FitPowerLaw 'linear'): least squares of log(−dQ/dt) on
// log(Q), each row multiplied by its weight (1 for BN and backwards; R² for
// ETS, floored at 1e−18 like TOSSH). The fit's uncertainty, per-segment fits
// and seasonal tags are CR-15, not this.
import type { RecessionDqdtMethod, RecessionSegment } from './segments';

/** One −dQ/dt, Q pair. */
export interface RecessionPoint {
	/** The segment (index into the segment list) the point comes from. */
	segment: number;
	/** Flow, m³/s (the mean of the pair or the window, or Q(t) for 'backwards'). */
	qM3s: number;
	/** −dQ/dt, m³/s per day (> 0). */
	rate: number;
	/** The point's weight in the fit (R² of the ETS window; 1 otherwise). */
	weight: number;
}

/** The power law −dQ/dt = a·Q^b fitted to a point cloud. */
export interface RecessionFit {
	/** Scale, (m³/s)^(1−b) per day. */
	a: number;
	/** Non-linearity: 1 = a linear reservoir (exponential recession). */
	b: number;
	/** Points behind the fit. */
	points: number;
	/** Segments with at least one point. */
	segments: number;
	/** The range of Q the points span, m³/s. */
	minQM3s: number;
	maxQM3s: number;
}

/** A fit needs at least this many points. */
export const RECESSION_MIN_POINTS = 3;
/**
 * …and flows spanning at least this factor (max ÷ min). Not in TOSSH: across a
 * narrower range the slope b isn't identifiable (a simulated flow that barely
 * moves gave b ≈ 127 in the fuzz tests) and floating-point noise decides it.
 */
export const RECESSION_MIN_Q_RANGE = 1.2;

const WEIGHT_FLOOR = 1e-18;

/** Least-squares line y = a + b·x through (x, y), with its R² (TOSSH util_FitLinear). */
function fitLinear(x: readonly number[], y: readonly number[]): { slope: number; r2: number } {
	const n = x.length;
	let sx = 0;
	let sy = 0;
	let sxy = 0;
	let sxx = 0;
	for (let i = 0; i < n; i++) {
		sx += x[i]!;
		sy += y[i]!;
		sxy += x[i]! * y[i]!;
		sxx += x[i]! * x[i]!;
	}
	const slope = (sxy - (sx * sy) / n) / (sxx - (sx * sx) / n);
	const icpt = sy / n - slope * (sx / n);
	const my = sy / n;
	let ssr = 0;
	let sst = 0;
	for (let i = 0; i < n; i++) {
		ssr += (y[i]! - (icpt + slope * x[i]!)) ** 2;
		sst += (y[i]! - my) ** 2;
	}
	return { slope, r2: 1 - ssr / sst };
}

/** The segment's exponential decay rate γ, semilog through its first day (TOSSH util_FitExponential 'semilog'). */
function decayRate(q: readonly number[]): number {
	let num = 0;
	let den = 0;
	const q0 = Math.log(q[0]!);
	for (let k = 0; k < q.length; k++) {
		num += k * (Math.log(q[k]!) - q0);
		den += k * k;
	}
	return -num / den;
}

/**
 * The −dQ/dt, Q points of `flowM3s` on `segments` by `method` (TOSSH
 * util_dQdt). A segment with a day that is missing or not above zero gives no
 * points (the simulated flow on the observed record's segments can have one).
 */
export function recessionPoints(flowM3s: ArrayLike<number | null>, segments: readonly RecessionSegment[], method: RecessionDqdtMethod): RecessionPoint[] {
	const out: RecessionPoint[] = [];
	segments.forEach(([s, e], seg) => {
		const q: number[] = [];
		for (let t = s; t <= e; t++) {
			const v = flowM3s[t];
			if (v == null || !Number.isFinite(v) || v <= 0) return;
			q.push(v);
		}
		const push = (qM3s: number, dqdt: number, weight: number) => {
			if (!(dqdt < 0) || !Number.isFinite(dqdt)) return;
			out.push({ segment: seg, qM3s, rate: -dqdt, weight: weight > 0 ? weight : WEIGHT_FLOOR });
		};
		if (method !== 'ETS') {
			for (let k = 1; k < q.length; k++) push(method === 'BN' ? (q[k]! + q[k - 1]!) / 2 : q[k]!, q[k]! - q[k - 1]!, 1);
			return;
		}
		const len = q.length;
		const nw = 0.1 * len; // 10 % of the recession's length, as Roques et al. (2017) found best
		const gamma = Math.max(0, decayRate(q));
		const m = (k: number) => 1 + Math.ceil(nw * Math.exp(-1 / (gamma * (k + 1)))); // k 0-based; γ = 0 → exp(−∞) = 0 → m = 1
		for (let k = 0; k + m(k) < len; k++) {
			const w = m(k);
			const xs: number[] = [];
			const ys: number[] = [];
			for (let j = k; j <= k + w; j++) {
				xs.push(j);
				ys.push(q[j]!);
			}
			const { slope, r2 } = fitLinear(xs, ys);
			push(ys.reduce((a, b) => a + b, 0) / ys.length, slope, Number.isNaN(r2) ? WEIGHT_FLOOR : r2);
		}
	});
	return out;
}

/** −dQ/dt = a·Q^b by weighted least squares in log–log space (TOSSH util_FitPowerLaw 'linear'); null with too few points, flows spanning less than RECESSION_MIN_Q_RANGE, or a fit that isn't finite. */
export function fitRecession(points: readonly RecessionPoint[]): RecessionFit | null {
	if (points.length < RECESSION_MIN_POINTS) return null;
	// Rows scaled by w: minimise Σ w²·(log r − c − b·log Q)².
	let sw = 0;
	let sx = 0;
	let sy = 0;
	let sxx = 0;
	let sxy = 0;
	let minQ = Infinity;
	let maxQ = -Infinity;
	for (const p of points) {
		const w = p.weight * p.weight;
		const x = Math.log(p.qM3s);
		const y = Math.log(p.rate);
		sw += w;
		sx += w * x;
		sy += w * y;
		sxx += w * x * x;
		sxy += w * x * y;
		minQ = Math.min(minQ, p.qM3s);
		maxQ = Math.max(maxQ, p.qM3s);
	}
	const det = sw * sxx - sx * sx;
	if (!(det > 1e-12 * sw * sw) || !(maxQ >= RECESSION_MIN_Q_RANGE * minQ)) return null;
	const b = (sw * sxy - sx * sy) / det;
	const a = Math.exp((sy - b * sx) / sw);
	// A near-degenerate cloud (flows a hair apart, rates spanning hundreds of decades) can overflow; a summary holds only finite numbers (JSON has no Infinity).
	if (!Number.isFinite(a) || !(a > 0) || !Number.isFinite(b)) return null;
	return { a, b, points: points.length, segments: new Set(points.map((p) => p.segment)).size, minQM3s: minQ, maxQM3s: maxQ };
}

/** −dQ/dt ÷ Q at flow `qM3s` on a fitted curve: the recession rate, per day (a·Q^(b−1)). */
export const recessionRateAt = (f: Pick<RecessionFit, 'a' | 'b'>, qM3s: number) => f.a * qM3s ** (f.b - 1);
