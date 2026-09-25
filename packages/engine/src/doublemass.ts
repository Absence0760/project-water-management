// Double-mass check of the catchment rain against CHIRPS (engine ≥ 0.18.0,
// CR-20, docs/model.md §2.10a).
//
// Two records of the same rain should keep a steady ratio. Plot cumulative
// catchment rain against cumulative CHIRPS and the curve is a straight line;
// a kink means one record changed: a station opened or closed in the
// catchment average, a gauge moved, a CHIRPS version or input change (Searcy
// & Hardison 1960). The CHIRPS factors (./rain.ts) are one ratio per calendar
// month fitted over the whole record, so a kink means they blend eras that
// don't agree, and a gap in the latest era is filled with an older era's
// ratio.
//
// Detection works on water-year totals over the days both series have a
// reading (and that aren't suspect: a flagged zero run not kept dry, or a
// listed missing period). A daily curve is dominated by timing mismatches
// between CHIRPS and gauge days and overstates the sample size. The number of
// breaks (0, 1 or 2) is chosen by BIC on the annual ratios, not on the
// cumulative curve, whose residuals are autocorrelated; each break position is
// found by exhaustive search. A break is reported only when the slope changes
// by DOUBLE_MASS_MIN_CHANGE and either a Pettitt test on the annual ratios
// either side of it or the BIC gain of keeping it says it is real.
//
// The check only warns. It never changes the fit or the rain a run uses: a
// slope break doesn't say which record is wrong. A run also warns when CHIRPS
// fills days in a segment whose slope differs from the fit's pooled ratio.
import { toEpochDay } from './calendar';
import { waterYearOf } from './network/stats';
import { defaultZeroRainSettings, type DailySeries, type SeriesKind, type ZeroRainSettings } from './project';
import { waterYearLabel, type SeriesCheck } from './quality';
import { suspectRainDays, type ChirpsCorrection } from './rain';

/** A water year is judged with this many shared days … */
export const DOUBLE_MASS_MIN_DAYS = 300;
/** … and at least this much CHIRPS rain on them, mm. */
export const DOUBLE_MASS_MIN_CHIRPS_MM = 100;
/** Fewer judged years than this: no result. */
export const DOUBLE_MASS_MIN_YEARS = 10;
/** Every segment between breaks spans at least this many judged years. */
export const DOUBLE_MASS_MIN_SEGMENT_YEARS = 5;
/** At most this many breaks. */
export const DOUBLE_MASS_MAX_BREAKS = 2;
/** A break is reported when the slope changes by at least this fraction … */
export const DOUBLE_MASS_MIN_CHANGE = 0.2;
/** … and the Pettitt p-value either side of it is below this … */
export const DOUBLE_MASS_PETTITT_P = 0.05;
/** … or keeping it improves BIC by at least this much. */
export const DOUBLE_MASS_MIN_BIC_GAIN = 6;
/** A run warns when CHIRPS fills days in a segment whose slope differs from the fit's pooled ratio by this fraction. */
export const DOUBLE_MASS_RUN_WARN_CHANGE = 0.2;

export interface DoubleMassYear {
	/** Water year starting 1 October of this calendar year. */
	waterYear: number;
	/** Shared days used. */
	days: number;
	catchmentMm: number;
	chirpsMm: number;
	/** catchmentMm / chirpsMm. */
	ratio: number;
	/** Cumulative totals to the end of this year, over the judged years only. */
	cumChirpsMm: number;
	cumCatchmentMm: number;
	/** (cumulative catchment − whole-record slope × cumulative CHIRPS) / cumulative catchment × 100; null while the cumulative catchment is 0. */
	residualPct: number | null;
}

export interface DoubleMassSegment {
	/** First and last judged water year of the segment. */
	fromWaterYear: number;
	toWaterYear: number;
	years: number;
	days: number;
	/** Σ catchment / Σ CHIRPS over the segment: the slope of the cumulative curve. */
	slope: number;
}

export interface DoubleMassBreak {
	/** The last judged water year before the break. */
	afterWaterYear: number;
	slopeBefore: number;
	slopeAfter: number;
	/** slopeAfter / slopeBefore − 1. */
	change: number;
	/** Pettitt's approximate p-value on the annual ratios of the two segments either side. */
	pettittP: number;
	/** BIC of the fit without this break minus the fit with it. */
	bicGain: number;
}

export interface DoubleMass {
	/** The judged water years, in order. */
	years: DoubleMassYear[];
	/** Water years with shared days but too few days or too little CHIRPS to judge. */
	skippedYears: number[];
	/** Σ catchment / Σ CHIRPS over all judged years. */
	wholeSlope: number;
	/** The segments between reported breaks: one segment when there is none. */
	segments: DoubleMassSegment[];
	/** Reported breaks, in order. */
	breaks: DoubleMassBreak[];
}

const isReading = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v >= 0;

/** Pettitt (1979) change-point test on a sequence: the approximate two-sided p-value of its most likely change. */
export function pettittP(xs: readonly number[]): number {
	const n = xs.length;
	if (n < 2) return 1;
	let u = 0;
	let k = 0;
	for (let t = 0; t < n - 1; t++) {
		// U_t = U_{t−1} + Σ_j sgn(x_t − x_j)
		for (let j = 0; j < n; j++) u += Math.sign(xs[t]! - xs[j]!);
		k = Math.max(k, Math.abs(u));
	}
	return Math.min(1, 2 * Math.exp((-6 * k * k) / (n ** 3 + n ** 2)));
}

/**
 * The double-mass curve of catchment rain against CHIRPS, with its breaks.
 * Shared days leave out suspect catchment rain as a run treats it
 * (suspectRainDays: listed missing periods, flagged zero runs not kept dry).
 * null without both series, or with fewer than DOUBLE_MASS_MIN_YEARS judged
 * water years.
 */
export function doubleMass(
	series: Partial<Record<SeriesKind, DailySeries>>,
	zeroRain: ZeroRainSettings = defaultZeroRainSettings()
): DoubleMass | null {
	const sa = series.rain_catchment_mm;
	const sb = series.rain_chirps_mm;
	if (!sa || !sb) return null;
	const suspect = suspectRainDays(sa, zeroRain);
	const a0 = toEpochDay(sa.startDate);
	const b0 = toEpochDay(sb.startDate);
	const from = Math.max(a0, b0);
	const to = Math.min(a0 + sa.values.length, b0 + sb.values.length); // exclusive
	const byYear = new Map<number, { days: number; a: number; b: number }>();
	for (let day = from; day < to; day++) {
		const va = sa.values[day - a0];
		const vb = sb.values[day - b0];
		if (!isReading(va) || !isReading(vb)) continue;
		const s = suspect.status(day);
		if (s === 'missing' || s === 'flagged') continue;
		const wy = waterYearOf(day);
		const y = byYear.get(wy) ?? { days: 0, a: 0, b: 0 };
		y.days++;
		y.a += va;
		y.b += vb;
		byYear.set(wy, y);
	}
	const all = [...byYear.entries()].sort(([x], [y]) => x - y);
	const judged = all.filter(([, y]) => y.days >= DOUBLE_MASS_MIN_DAYS && y.b >= DOUBLE_MASS_MIN_CHIRPS_MM);
	if (judged.length < DOUBLE_MASS_MIN_YEARS) return null;

	const n = judged.length;
	const X = judged.map(([, y]) => y.b);
	const Y = judged.map(([, y]) => y.a);
	const D = judged.map(([, y]) => y.days);
	const R = judged.map((_, i) => Y[i]! / X[i]!);
	// Prefix sums: Σ X, Σ Y, Σ Y²/X (for the weighted SSE), Σ days.
	const px = [0];
	const py = [0];
	const pq = [0];
	const pd = [0];
	for (let i = 0; i < n; i++) {
		px.push(px[i]! + X[i]!);
		py.push(py[i]! + Y[i]!);
		pq.push(pq[i]! + (Y[i]! * Y[i]!) / X[i]!);
		pd.push(pd[i]! + D[i]!);
	}
	const slope = (a: number, b: number) => (py[b]! - py[a]!) / (px[b]! - px[a]!);
	// Annual ratios weighted by CHIRPS (normalised to mean weight 1): the
	// weighted least-squares level of a segment is Σ Y / Σ X, its slope.
	const meanX = px[n]! / n;
	const sse = (a: number, b: number) => Math.max(0, pq[b]! - pq[a]! - (py[b]! - py[a]!) ** 2 / (px[b]! - px[a]!)) / meanX;
	const meanR = py[n]! / px[n]!;
	const floor = 1e-10 * meanR * meanR; // keeps ln finite on a noise-free record
	/** BIC of a segmentation given by its cut indices (segment starts after 0). */
	const bic = (cuts: number[]) => {
		const edges = [0, ...cuts, n];
		let s = 0;
		for (let k = 0; k + 1 < edges.length; k++) s += sse(edges[k]!, edges[k + 1]!);
		return n * Math.log(Math.max(s / n, floor)) + (2 * cuts.length + 1) * Math.log(n);
	};

	// Best segmentation for 0, 1 and 2 breaks (exhaustive), then the lowest BIC; a tie keeps fewer breaks.
	const M = DOUBLE_MASS_MIN_SEGMENT_YEARS;
	let best: number[] = [];
	let bestBic = bic([]);
	const consider = (cuts: number[]) => {
		const b = bic(cuts);
		if (b < bestBic - 1e-9 || (Math.abs(b - bestBic) <= 1e-9 && cuts.length < best.length)) {
			best = cuts;
			bestBic = b;
		}
	};
	const bestOf = (k: number) => {
		let cuts: number[] | null = null;
		let s = Infinity;
		const edges = (c: number[]) => {
			const e = [0, ...c, n];
			let t = 0;
			for (let i = 0; i + 1 < e.length; i++) t += sse(e[i]!, e[i + 1]!);
			return t;
		};
		if (k === 1) {
			for (let c = M; c <= n - M; c++) {
				const t = edges([c]);
				if (t < s - 1e-12) [s, cuts] = [t, [c]];
			}
		} else {
			for (let c1 = M; c1 <= n - 2 * M; c1++) {
				for (let c2 = c1 + M; c2 <= n - M; c2++) {
					const t = edges([c1, c2]);
					if (t < s - 1e-12) [s, cuts] = [t, [c1, c2]];
				}
			}
		}
		return cuts;
	};
	for (let k = 1; k <= DOUBLE_MASS_MAX_BREAKS; k++) {
		const cuts = bestOf(k);
		if (cuts) consider(cuts);
	}

	// Keep only breaks that are big and real; drop the weakest failing one at a time.
	const judge = (cuts: number[]): DoubleMassBreak[] => {
		const edges = [0, ...cuts, n];
		return cuts.map((c, j) => {
			const before = slope(edges[j]!, c);
			const after = slope(c, edges[j + 2]!);
			return {
				afterWaterYear: judged[c - 1]![0],
				slopeBefore: before,
				slopeAfter: after,
				change: before > 0 ? after / before - 1 : after > 0 ? Infinity : 0,
				pettittP: pettittP(R.slice(edges[j]!, edges[j + 2]!)),
				bicGain: bic(cuts.filter((_, i) => i !== j)) - bic(cuts)
			};
		});
	};
	const reported = (b: DoubleMassBreak) =>
		Math.abs(b.change) >= DOUBLE_MASS_MIN_CHANGE && (b.pettittP < DOUBLE_MASS_PETTITT_P || b.bicGain >= DOUBLE_MASS_MIN_BIC_GAIN);
	let cuts = best;
	let breaks = judge(cuts);
	while (breaks.some((b) => !reported(b))) {
		let weakest = -1;
		breaks.forEach((b, j) => {
			if (reported(b)) return;
			const w = breaks[weakest];
			if (!w || Math.abs(b.change) < Math.abs(w.change) || (Math.abs(b.change) === Math.abs(w.change) && b.bicGain < w.bicGain)) weakest = j;
		});
		cuts = cuts.filter((_, j) => j !== weakest);
		breaks = judge(cuts);
	}

	const edges = [0, ...cuts, n];
	const segments: DoubleMassSegment[] = [];
	for (let k = 0; k + 1 < edges.length; k++) {
		const a = edges[k]!;
		const b = edges[k + 1]!;
		segments.push({ fromWaterYear: judged[a]![0], toWaterYear: judged[b - 1]![0], years: b - a, days: pd[b]! - pd[a]!, slope: slope(a, b) });
	}
	const wholeSlope = slope(0, n);
	const years: DoubleMassYear[] = judged.map(([waterYear], i) => {
		const cx = px[i + 1]!;
		const cy = py[i + 1]!;
		return {
			waterYear,
			days: D[i]!,
			catchmentMm: Y[i]!,
			chirpsMm: X[i]!,
			ratio: R[i]!,
			cumChirpsMm: cx,
			cumCatchmentMm: cy,
			residualPct: cy > 0 ? ((cy - wholeSlope * cx) / cy) * 100 : null
		};
	});
	const judgedSet = new Set(judged.map(([wy]) => wy));
	return { years, skippedYears: all.map(([wy]) => wy).filter((wy) => !judgedSet.has(wy)), wholeSlope, segments, breaks };
}

const signedPct = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))} %` : 'from 0');
const f2 = (x: number) => x.toFixed(2);

/** The breaks as a data check (SeriesCheck 'doublemass'), or null when there are none. */
export function doubleMassCheck(dm: DoubleMass | null): SeriesCheck | null {
	if (!dm || dm.breaks.length === 0) return null;
	const parts = dm.breaks.map((b) => `after ${waterYearLabel(b.afterWaterYear)} (${f2(b.slopeBefore)} → ${f2(b.slopeAfter)}, ${signedPct(b.change)})`);
	return {
		seriesKind: 'rain_catchment_mm',
		check: 'doublemass',
		days: dm.segments.reduce((a, s) => a + s.days, 0),
		examples: dm.breaks.map((b, j) => {
			const next = dm.segments[j + 1]!;
			return { date: `${next.fromWaterYear}-10-01`, endDate: `${next.toWaterYear + 1}-09-30`, value: next.slope / dm.segments[j]!.slope, runDays: next.days };
		}),
		text:
			`Rainfall (catchment): on the double-mass curve against CHIRPS (${dm.years.length} water years, whole-record slope ${f2(dm.wholeSlope)}), ` +
			`catchment rain changes slope ${parts.join(' and ')}. A station change, a moved gauge or a change in how the catchment average is built can do this; ` +
			'so can a change in CHIRPS. The CHIRPS factors are fitted over all segments: this check does not change them (see the Data tab\'s double-mass chart)'
	};
}

/** The segment a water year falls in: the last whose first year is at or before it (the first segment for earlier years). */
function segmentOf(dm: DoubleMass, wy: number): number {
	let s = 0;
	for (let k = 1; k < dm.segments.length; k++) if (dm.segments[k]!.fromWaterYear <= wy) s = k;
	return s;
}

/**
 * The run warning when CHIRPS fills days in a double-mass segment whose slope
 * differs from the fit's pooled ratio by DOUBLE_MASS_RUN_WARN_CHANGE or more,
 * or null. `catchment` is the run's catchment rain after the zero-rain
 * blanking, `chirps` its CHIRPS as stored, both aligned to the run from
 * epoch day `start`. Only with a reported break, in mode 'monthly' with a
 * pooled ratio.
 */
export function doubleMassRunWarning(
	dm: DoubleMass | null,
	corr: ChirpsCorrection | null,
	catchment: readonly (number | null)[],
	chirps: readonly (number | null)[],
	start: number
): string | null {
	const pooled = corr?.pooled.ownFactor ?? null;
	if (!dm || dm.breaks.length === 0 || !corr || corr.mode !== 'monthly' || pooled === null || !(pooled > 0)) return null;
	const days = new Array<number>(dm.segments.length).fill(0);
	for (let t = 0; t < chirps.length; t++) {
		if (catchment[t] != null || chirps[t] == null) continue;
		days[segmentOf(dm, waterYearOf(start + t))]!++;
	}
	const last = dm.segments.length - 1;
	const span = (k: number) => {
		const s = dm.segments[k]!;
		if (k === 0) return `up to ${waterYearLabel(dm.segments[1]!.fromWaterYear - 1)}`;
		if (k === last) return `from ${waterYearLabel(s.fromWaterYear)} on`;
		return `${waterYearLabel(s.fromWaterYear)} to ${waterYearLabel(dm.segments[k + 1]!.fromWaterYear - 1)}`;
	};
	const parts = dm.segments.flatMap((s, k) => {
		const change = s.slope / pooled - 1;
		if (days[k] === 0 || Math.abs(change) < DOUBLE_MASS_RUN_WARN_CHANGE) return [];
		return [`${days[k]} days ${span(k)}, where catchment rain reads ${f2(s.slope)} × CHIRPS (${signedPct(change)})`];
	});
	if (!parts.length) return null;
	return (
		`CHIRPS fills catchment-rain gaps with factors fitted on the whole record (pooled catchment / CHIRPS ${f2(pooled)}), ` +
		`but the double-mass check finds the ratio changed: ${parts.join('; ')}. ` +
		'Those days may run too wet or too dry. The Data tab\'s double-mass chart shows the segments.'
	);
}
