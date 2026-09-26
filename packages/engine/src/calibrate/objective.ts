// Goodness-of-fit scores for automatic calibration, on paired daily flows
// (observed, simulated; same length, only days both exist). Higher is better
// for every efficiency; the optimiser minimises 1 − score.
//
// - KGE′: Kling–Gupta efficiency with the variability term as a ratio of
//   coefficients of variation (Kling, Fuchs & Paulin 2012), so bias and
//   variability don't overlap. The default objective. Simulating the mean
//   observed flow every day scores 1 − √2 ≈ −0.41 (Knoben, Freer & Woods
//   2019), the benchmark a calibrated model should clearly beat.
// - KGE-np: non-parametric KGE (Pool, Vis & Seibert 2018): Spearman rank
//   correlation, and variability from the normalised flow-duration curves.
// - Year-balanced KGE′: the mean of KGE′ within each water year (Fowler et
//   al. 2018), so a few wet years can't dominate the score; for a record of
//   drought and deluge (issue #1 item 5).
// - NSE on √Q and on ln(Q + ε): Nash–Sutcliffe weighted towards medium and low
//   flows. KGE is not applied to log flows (Santos et al. 2018: the KGE
//   components misbehave for log-transformed flows).
// - FDC signatures (Yilmaz, Gupta & Wagener 2008): % bias of the high-flow
//   volume (top 2 %), of the mid-segment slope (20–70 % exceedance) and of the
//   low-flow volume (bottom 30 %, in log space). Reported, not optimised.

import type { ObjectiveId } from './objectives';

/** Every score for one comparison. null when it can't be computed (too few days, no variance, zero mean). */
export interface FitScores {
	days: number;
	kgePrime: number | null;
	/** Mean KGE′ over the water years (null without year labels, or when no year can be scored). */
	kgeYearly: number | null;
	kgeNp: number | null;
	nse: number | null;
	nseSqrt: number | null;
	nseLog: number | null;
	/** 100 × (Σsim − Σobs) / Σobs. */
	volumeErrorPct: number | null;
	/** %BiasFHV: high-flow (top 2 %) volume bias. */
	fdcHighPct: number | null;
	/** %BiasFMS: bias of the FDC mid-segment slope (20–70 % exceedance). */
	fdcMidSlopePct: number | null;
	/** %BiasFLV: low-flow (bottom 30 %) volume bias, log space. */
	fdcLowPct: number | null;
}

const mean = (a: ArrayLike<number>) => {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i]!;
	return a.length ? s / a.length : NaN;
};

const std = (a: ArrayLike<number>, m: number) => {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += (a[i]! - m) ** 2;
	return Math.sqrt(s / a.length);
};

function pearson(o: ArrayLike<number>, s: ArrayLike<number>): number | null {
	const mo = mean(o);
	const ms = mean(s);
	let so = 0;
	let ss = 0;
	let cov = 0;
	for (let i = 0; i < o.length; i++) {
		cov += (o[i]! - mo) * (s[i]! - ms);
		so += (o[i]! - mo) ** 2;
		ss += (s[i]! - ms) ** 2;
	}
	if (!(so > 0)) return null;
	// A flat simulation has no correlation with anything: r = 0 (as Knoben et
	// al. 2019 score the mean-flow benchmark). The tolerance absorbs the float
	// residue of subtracting a constant's own mean.
	if (!(ss > 1e-24 * so)) return 0;
	return cov / Math.sqrt(so * ss);
}

/** Fractional ranks (ties share their average rank). */
function ranks(a: ArrayLike<number>): Float64Array {
	const idx = Array.from({ length: a.length }, (_, i) => i).sort((p, q) => a[p]! - a[q]!);
	const r = new Float64Array(a.length);
	for (let i = 0; i < idx.length; ) {
		let j = i;
		while (j + 1 < idx.length && a[idx[j + 1]!] === a[idx[i]!]) j++;
		const avg = (i + j) / 2 + 1;
		for (let k = i; k <= j; k++) r[idx[k]!] = avg;
		i = j + 1;
	}
	return r;
}

/** Nash–Sutcliffe efficiency of `s` against `o`. */
export function nse(o: ArrayLike<number>, s: ArrayLike<number>): number | null {
	if (o.length < 2) return null;
	const mo = mean(o);
	let num = 0;
	let den = 0;
	for (let i = 0; i < o.length; i++) {
		num += (s[i]! - o[i]!) ** 2;
		den += (o[i]! - mo) ** 2;
	}
	return den > 0 ? 1 - num / den : null;
}

/** KGE′ = 1 − √((r − 1)² + (β − 1)² + (γ − 1)²), β = μs/μo, γ = CVs/CVo. */
export function kgePrime(o: ArrayLike<number>, s: ArrayLike<number>): number | null {
	if (o.length < 2) return null;
	const mo = mean(o);
	const ms = mean(s);
	const r = pearson(o, s);
	if (r === null || !(mo > 0) || !(ms > 0)) return null;
	const beta = ms / mo;
	const gamma = std(s, ms) / ms / (std(o, mo) / mo);
	return 1 - Math.sqrt((r - 1) ** 2 + (beta - 1) ** 2 + (gamma - 1) ** 2);
}

/**
 * Non-parametric KGE (Pool et al. 2018): r = Spearman correlation,
 * α = 1 − ½ Σ |sorted sim/(n·μs) − sorted obs/(n·μo)|, β = μs/μo.
 */
export function kgeNp(o: ArrayLike<number>, s: ArrayLike<number>): number | null {
	const n = o.length;
	if (n < 2) return null;
	const mo = mean(o);
	const ms = mean(s);
	if (!(mo > 0) || !(ms > 0)) return null;
	const r = pearson(ranks(o), ranks(s));
	if (r === null) return null;
	const so = Float64Array.from(o).sort();
	const ss = Float64Array.from(s).sort();
	let d = 0;
	for (let i = 0; i < n; i++) d += Math.abs(ss[i]! / (n * ms) - so[i]! / (n * mo));
	const alpha = 1 - 0.5 * d;
	const beta = ms / mo;
	return 1 - Math.sqrt((r - 1) ** 2 + (alpha - 1) ** 2 + (beta - 1) ** 2);
}

/** NSE of transformed flows. */
function nseOf(o: ArrayLike<number>, s: ArrayLike<number>, f: (q: number) => number): number | null {
	const to = Float64Array.from(o, f);
	const ts = Float64Array.from(s, f);
	return nse(to, ts);
}

/** ε for log flows: 1 % of the mean observed flow (as network/stats.ts logNse). */
export const logEpsilon = (o: ArrayLike<number>) => Math.max(mean(o) / 100, 1e-12);

/** Exceedance-sorted copy (largest first) and the flow at exceedance probability p (0–1). */
function fdc(a: ArrayLike<number>): Float64Array {
	return Float64Array.from(a).sort().reverse();
}
const at = (sorted: Float64Array, p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]!;

/** Yilmaz et al. (2008) signatures, in %. ε keeps zero flows finite in log space. */
export function fdcSignatures(o: ArrayLike<number>, s: ArrayLike<number>): Pick<FitScores, 'fdcHighPct' | 'fdcMidSlopePct' | 'fdcLowPct'> {
	const n = o.length;
	if (n < 10) return { fdcHighPct: null, fdcMidSlopePct: null, fdcLowPct: null };
	const fo = fdc(o);
	const fs = fdc(s);
	const eps = logEpsilon(o);
	const lg = (q: number) => Math.log(q + eps);

	// High: the top 2 % of days (at least one).
	const h = Math.max(1, Math.floor(0.02 * n));
	let ho = 0;
	let hs = 0;
	for (let i = 0; i < h; i++) {
		ho += fo[i]!;
		hs += fs[i]!;
	}
	const fdcHighPct = ho > 0 ? (100 * (hs - ho)) / ho : null;

	// Mid-segment slope between 20 % and 70 % exceedance, log flows.
	const slopeO = lg(at(fo, 0.2)) - lg(at(fo, 0.7));
	const slopeS = lg(at(fs, 0.2)) - lg(at(fs, 0.7));
	const fdcMidSlopePct = slopeO !== 0 ? (100 * (slopeS - slopeO)) / slopeO : null;

	// Low: the bottom 30 % (70–100 % exceedance), log flows relative to the minimum.
	const l0 = Math.floor(0.7 * (n - 1));
	const minO = lg(fo[n - 1]!);
	const minS = lg(fs[n - 1]!);
	let lo = 0;
	let ls = 0;
	for (let i = l0; i < n; i++) {
		lo += lg(fo[i]!) - minO;
		ls += lg(fs[i]!) - minS;
	}
	const fdcLowPct = lo !== 0 ? (-100 * (ls - lo)) / lo : null;
	return { fdcHighPct, fdcMidSlopePct, fdcLowPct };
}

/**
 * Mean KGE′ over groups (water years): each group with at least `minDays`
 * days and a score counts once, whatever its length. `groups[i]` labels day i;
 * days of a group needn't be contiguous.
 */
export function kgeYearly(o: ArrayLike<number>, s: ArrayLike<number>, groups: ArrayLike<number>, minDays = 30): number | null {
	const by = new Map<number, number[]>();
	for (let i = 0; i < o.length; i++) {
		let list = by.get(groups[i]!);
		if (!list) by.set(groups[i]!, (list = []));
		list.push(i);
	}
	let sum = 0;
	let n = 0;
	for (const idx of by.values()) {
		if (idx.length < minDays) continue;
		const k = kgePrime(
			idx.map((i) => o[i]!),
			idx.map((i) => s[i]!)
		);
		if (k === null) continue;
		sum += k;
		n++;
	}
	return n ? sum / n : null;
}

/** Every score for paired flows (any consistent unit); `groups` labels each day's water year. */
export function fitScores(o: ArrayLike<number>, s: ArrayLike<number>, groups?: ArrayLike<number>): FitScores {
	const eps = logEpsilon(o);
	let so = 0;
	let ss = 0;
	for (let i = 0; i < o.length; i++) {
		so += o[i]!;
		ss += s[i]!;
	}
	return {
		days: o.length,
		kgePrime: kgePrime(o, s),
		kgeYearly: groups ? kgeYearly(o, s, groups) : null,
		kgeNp: kgeNp(o, s),
		nse: nse(o, s),
		nseSqrt: nseOf(o, s, (q) => Math.sqrt(Math.max(0, q))),
		nseLog: nseOf(o, s, (q) => Math.log(Math.max(0, q) + eps)),
		volumeErrorPct: so > 0 ? (100 * (ss - so)) / so : null,
		...fdcSignatures(o, s)
	};
}

/** The loss the optimiser minimises: 1 − score (so a perfect fit is 0); +∞ when the score is undefined. */
export function objectiveLoss(id: ObjectiveId, o: ArrayLike<number>, s: ArrayLike<number>, groups?: ArrayLike<number>): number {
	let v: number | null;
	switch (id) {
		case 'kgePrime':
			v = kgePrime(o, s);
			break;
		case 'kgeYearly':
			if (!groups) throw new Error('the year-balanced KGE needs water-year labels');
			v = kgeYearly(o, s, groups);
			break;
		case 'kgeNp':
			v = kgeNp(o, s);
			break;
		case 'nseSqrt':
			v = nseOf(o, s, (q) => Math.sqrt(Math.max(0, q)));
			break;
		case 'nseLog': {
			const eps = logEpsilon(o);
			v = nseOf(o, s, (q) => Math.log(Math.max(0, q) + eps));
			break;
		}
	}
	return v === null ? Infinity : 1 - v;
}
