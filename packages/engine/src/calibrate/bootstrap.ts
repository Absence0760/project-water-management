// How sure is a score, and does it beat a naive forecast? (engine ≥ 1.19.0,
// calibration research CR-5.)
//
// - Intervals: a block bootstrap over water years. Daily scores carry large
//   sampling error, mostly from a few wet spells (Clark et al. 2021), and
//   days within a year are not independent, so whole water years are
//   resampled with replacement, never single days. The 90 % interval is the
//   5th–95th percentile of the resampled scores. Each resample is scored from
//   per-year sums (count, Σo, Σs, Σo², Σs², Σos, Σ(s − o)², and the same for
//   1/(Q + ε)), so a resample costs one pass over the years, not the days.
// - Benchmarks: the same scores for two naive simulations on the same days:
//   the mean observed flow every day (KGE′ 1 − √2, NSE 0; Knoben et al. 2019)
//   and the day-of-year climatology (each day the mean observed flow on that
//   calendar day, smoothed over a centred ±7-day window). In a strongly
//   seasonal catchment climatology is hard to beat (Schaefli & Gupta 2007;
//   Knoben et al. 2020), and a model that doesn't beat it adds little
//   beyond the seasonal cycle.
// - Where the benchmarks come from (engine ≥ 1.61.0, CR-5, provisional
//   decision 2026-10-01, to be confirmed by the client's hydrologist): on a
//   validation period both are built from the flows of the test's own
//   calibration period and applied to the validation days, as a forecast
//   made with only the calibration data would be (Knoben et al. 2020;
//   Gründemann et al. 2026, HESS 30, 3439, "the benchmarks are defined using
//   data from a dedicated calibration period … and then used to predict the
//   streamflow in an independent evaluation period"). Up to 1.60.0 they were
//   built from the validation days themselves, a benchmark that already knew
//   the period's flows. A calibration period (and a validation on another
//   record, whose flows the calibration period never saw) keeps its own.

import { fromEpochDay } from '../calendar';
import { Rng } from '../random';
import { fitScores, inverseFlows, logEpsilon, type FitScores } from './objective';

/** The scores given an interval: the default objective, plain NSE, and the low/high-flow KGE′ (CR-3). */
export const INTERVAL_SCORES = ['kgePrime', 'nse', 'kgeLowHigh'] as const;
export type IntervalScoreId = (typeof INTERVAL_SCORES)[number];

/** Resamples per interval. 1 000 is the usual floor for a 90 % percentile interval. */
export const BOOTSTRAP_RESAMPLES = 1000;
/** Fixed seed, so a period's intervals depend only on its flows (and are reproducible). */
export const BOOTSTRAP_SEED = 20_210_101;
/** Two-sided coverage of the interval. */
export const BOOTSTRAP_LEVEL = 0.9;
/** Fewer water years than this (each with at least BOOTSTRAP_MIN_DAYS scored days): no interval. */
export const BOOTSTRAP_MIN_YEARS = 3;
/** Scored days a water year needs to count towards BOOTSTRAP_MIN_YEARS (as the year-balanced KGE′). */
export const BOOTSTRAP_MIN_DAYS = 30;
/** Half-width (days) of the centred window the day-of-year climatology is smoothed over: 15 days in all. */
export const CLIMATOLOGY_HALF_WINDOW = 7;

export interface ScoreInterval {
	lo: number;
	hi: number;
}

/** 90 % block-bootstrap intervals for one scored period. */
export interface ScoreIntervals {
	/** Coverage (0.9). */
	level: number;
	resamples: number;
	seed: number;
	/** Water years resampled (every year with a scored day). */
	years: number;
	kgePrime: ScoreInterval | null;
	nse: ScoreInterval | null;
	kgeLowHigh: ScoreInterval | null;
}

/** The model's scores beside two naive simulations of the same days. */
export interface ScoreBenchmarks {
	/** The mean observed flow of the period, every day. */
	meanFlow: FitScores;
	/** Each day, the period's mean observed flow on that calendar day, smoothed over ±`halfWindowDays`. */
	climatology: FitScores;
	halfWindowDays: number;
	/**
	 * Whose flows built the two benchmarks (engine ≥ 1.61.0): 'period' the scored days' own,
	 * 'calibration' the test's calibration period's, applied to these days. Absent on an older
	 * report, which always used the period's own.
	 */
	builtFrom?: 'period' | 'calibration';
}

export interface BootstrapOptions {
	resamples?: number;
	seed?: number;
	level?: number;
}

/** Sums for one water year (flows shifted by the period's means, so the squares don't lose precision). */
const K = 12;
// Offsets into a year's row of sums.
const N = 0,
	SO = 1,
	SS = 2,
	SOO = 3,
	SSS = 4,
	SOS = 5,
	SD2 = 6,
	IO = 7,
	IS = 8,
	IOO = 9,
	ISS = 10,
	IOS = 11;

/** KGE′ from sums over n days of flows shifted by (co, cs); null as kgePrime() gives it. */
function kgeFromSums(n: number, co: number, cs: number, so: number, ss: number, soo: number, sss: number, sos: number): number | null {
	if (n < 2) return null;
	const ao = so / n;
	const as = ss / n;
	const mo = co + ao;
	const ms = cs + as;
	const vo = soo / n - ao * ao;
	const vs = Math.max(0, sss / n - as * as);
	if (!(vo > 1e-300) || !(mo > 0) || !(ms > 0)) return null;
	// A flat simulation correlates with nothing (as pearson() in objective.ts).
	const r = vs > 1e-24 * vo ? (sos / n - ao * as) / Math.sqrt(vo * vs) : 0;
	const beta = ms / mo;
	const gamma = Math.sqrt(vs) / ms / (Math.sqrt(vo) / mo);
	return 1 - Math.sqrt((r - 1) ** 2 + (beta - 1) ** 2 + (gamma - 1) ** 2);
}

/** Linear-interpolation quantile (type 7) of an ascending array. */
function quantile(sorted: Float64Array, p: number): number {
	const h = (sorted.length - 1) * p;
	const lo = Math.floor(h);
	const hi = Math.min(sorted.length - 1, lo + 1);
	return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

/**
 * Block-bootstrap intervals of KGE′, NSE and the low/high-flow KGE′ over
 * water years (`groups[i]` labels day i). null with fewer than
 * BOOTSTRAP_MIN_YEARS water years of BOOTSTRAP_MIN_DAYS scored days. A
 * score's interval is null when fewer than half of the resamples can be
 * scored. ε for 1/(Q + ε) is the whole period's, as in its point score.
 * Deterministic for a seed.
 */
export function bootstrapIntervals(o: ArrayLike<number>, s: ArrayLike<number>, groups: ArrayLike<number>, opts: BootstrapOptions = {}): ScoreIntervals | null {
	const resamples = opts.resamples ?? BOOTSTRAP_RESAMPLES;
	const seed = opts.seed ?? BOOTSTRAP_SEED;
	const level = opts.level ?? BOOTSTRAP_LEVEL;
	const n = o.length;
	const blockOf = new Map<number, number>();
	for (let i = 0; i < n; i++) if (!blockOf.has(groups[i]!)) blockOf.set(groups[i]!, blockOf.size);
	const B = blockOf.size;
	const sums = new Float64Array(B * K);
	let co = 0;
	let cs = 0;
	for (let i = 0; i < n; i++) {
		co += o[i]!;
		cs += s[i]!;
	}
	co /= n;
	cs /= n;
	const eps = logEpsilon(o);
	const io = inverseFlows(o, eps);
	const is = inverseFlows(s, eps);
	let ci = 0;
	let cj = 0;
	for (let i = 0; i < n; i++) {
		ci += io[i]!;
		cj += is[i]!;
	}
	ci /= n;
	cj /= n;
	for (let i = 0; i < n; i++) {
		const b = blockOf.get(groups[i]!)! * K;
		const x = o[i]! - co;
		const y = s[i]! - cs;
		const u = io[i]! - ci;
		const v = is[i]! - cj;
		sums[b + N]! += 1;
		sums[b + SO]! += x;
		sums[b + SS]! += y;
		sums[b + SOO]! += x * x;
		sums[b + SSS]! += y * y;
		sums[b + SOS]! += x * y;
		sums[b + SD2]! += (s[i]! - o[i]!) ** 2;
		sums[b + IO]! += u;
		sums[b + IS]! += v;
		sums[b + IOO]! += u * u;
		sums[b + ISS]! += v * v;
		sums[b + IOS]! += u * v;
	}
	let years = 0;
	for (let b = 0; b < B; b++) if (sums[b * K + N]! >= BOOTSTRAP_MIN_DAYS) years++;
	if (years < BOOTSTRAP_MIN_YEARS) return null;

	const rng = new Rng(seed);
	const acc = new Float64Array(K);
	const kge = new Float64Array(resamples);
	const nseV = new Float64Array(resamples);
	const lh = new Float64Array(resamples);
	let nk = 0;
	let nn = 0;
	let nl = 0;
	for (let r = 0; r < resamples; r++) {
		acc.fill(0);
		for (let j = 0; j < B; j++) {
			const b = rng.int(0, B - 1) * K;
			for (let k = 0; k < K; k++) acc[k]! += sums[b + k]!;
		}
		const m = acc[N]!;
		const k1 = kgeFromSums(m, co, cs, acc[SO]!, acc[SS]!, acc[SOO]!, acc[SSS]!, acc[SOS]!);
		if (k1 !== null) kge[nk++] = k1;
		const vo = acc[SOO]! - (acc[SO]! * acc[SO]!) / m;
		if (m >= 2 && vo > 0) nseV[nn++] = 1 - acc[SD2]! / vo;
		const k2 = kgeFromSums(m, ci, cj, acc[IO]!, acc[IS]!, acc[IOO]!, acc[ISS]!, acc[IOS]!);
		if (k1 !== null && k2 !== null) lh[nl++] = (k1 + k2) / 2;
	}
	const tail = (1 - level) / 2;
	const interval = (vals: Float64Array, count: number): ScoreInterval | null => {
		if (count < resamples / 2) return null;
		const sorted = vals.subarray(0, count).sort();
		return { lo: quantile(sorted, tail), hi: quantile(sorted, 1 - tail) };
	};
	return { level, resamples, seed, years: B, kgePrime: interval(kge, nk), nse: interval(nseV, nn), kgeLowHigh: interval(lh, nl) };
}

const CUM = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];

/** Calendar-day slot 0–365 of an epoch day, on a leap-year calendar (29 Feb is 59; 1 Mar is 60 in every year). */
export function dayOfYearSlot(epochDay: number): number {
	const iso = fromEpochDay(epochDay);
	return CUM[Number(iso.slice(5, 7)) - 1]! + Number(iso.slice(8, 10)) - 1;
}

/**
 * The smoothed day-of-year climatology of `o` as a table over the 366
 * calendar slots: each slot the mean of every observation within
 * ±`halfWindow` calendar days of it (circular over the year), each weighted
 * once; NaN where none is.
 */
function slotTable(o: ArrayLike<number>, slots: ArrayLike<number>, halfWindow: number): Float64Array {
	const sum = new Float64Array(366);
	const count = new Float64Array(366);
	for (let i = 0; i < o.length; i++) {
		sum[slots[i]!]! += o[i]!;
		count[slots[i]!]! += 1;
	}
	const clim = new Float64Array(366);
	for (let d = 0; d < 366; d++) {
		let s = 0;
		let c = 0;
		for (let k = -halfWindow; k <= halfWindow; k++) {
			const j = (((d + k) % 366) + 366) % 366;
			s += sum[j]!;
			c += count[j]!;
		}
		clim[d] = c > 0 ? s / c : NaN;
	}
	return clim;
}

/**
 * The day-of-year climatology of `o`: for each day, the mean observed flow
 * over every day of the period within ±`halfWindow` calendar days of it
 * (circular over the year), each observation weighted once.
 */
export function climatologyFlows(o: ArrayLike<number>, slots: ArrayLike<number>, halfWindow = CLIMATOLOGY_HALF_WINDOW): Float64Array {
	const clim = slotTable(o, slots, halfWindow);
	return Float64Array.from(slots, (d) => clim[d]!);
}

/** Observed flows and their epoch days: the record a benchmark is built from. */
export interface BenchmarkSource {
	o: ArrayLike<number>;
	days: ArrayLike<number>;
}

/**
 * The mean-flow and day-of-year climatology benchmarks for observed flows `o`
 * on the epoch days `days`. Built from `o` itself, or, given `from` (engine ≥
 * 1.61.0), from another period's flows (the test's calibration period) and
 * applied to these days: the mean of `from`, and each day `from`'s
 * climatology on that calendar day. A calendar day `from` has no flow within
 * ±`halfWindow` of takes `from`'s mean.
 */
export function scoreBenchmarks(
	o: ArrayLike<number>,
	days: ArrayLike<number>,
	groups?: ArrayLike<number>,
	halfWindow = CLIMATOLOGY_HALF_WINDOW,
	from?: BenchmarkSource
): ScoreBenchmarks {
	const src = from ?? { o, days };
	let m = 0;
	for (let i = 0; i < src.o.length; i++) m += src.o[i]!;
	m /= src.o.length;
	const slots = Int32Array.from(days, dayOfYearSlot);
	// The source's climatology by calendar slot, read at each scored day's slot.
	const bySlot = from ? slotTable(src.o, Int32Array.from(src.days, dayOfYearSlot), halfWindow) : null;
	const clim = bySlot ? Float64Array.from(slots, (d) => (Number.isFinite(bySlot[d]!) ? bySlot[d]! : m)) : climatologyFlows(o, slots, halfWindow);
	return {
		meanFlow: fitScores(o, new Float64Array(o.length).fill(m), groups),
		climatology: fitScores(o, clim, groups),
		halfWindowDays: halfWindow,
		builtFrom: from ? 'calibration' : 'period'
	};
}
