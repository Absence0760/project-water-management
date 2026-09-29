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
// The check never changes the fit or the rain a run uses: a slope break
// doesn't say which record is wrong, and its position is an estimate that can
// land a year or two off the real network change. A run warns when CHIRPS
// fills days in a segment whose slope differs from the ratio of the factors
// that filled them. The breaks can *propose* water-year ranges
// (proposeChirpsFitRanges) for the hydrologist to confirm as
// settings.chirpsFitPeriod (engine ≥ 0.29.0, ./rain.ts); the run warning then
// names the range whose factors filled each gap.
import { toEpochDay, waterYearLabel, waterYearOf } from './calendar';
import { defaultZeroRainSettings, type DailySeries, type DataQualitySettings, type SeriesKind, type ZeroRainSettings } from './project';
import type { SeriesCheck } from './quality';
import type { ChirpsFitRange } from './project';
import { chirpsFitSegmentFor, fitSegmentFillText, fitSegmentName, suspectRainDays, type ChirpsCorrection, type ChirpsFitPeriodInfo } from './rain';

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
 * (suspectRainDays: listed missing periods, flagged zero runs not kept dry,
 * under settings.dataQuality `dq`, engine ≥ 1.20.0).
 * null without both series, or with fewer than DOUBLE_MASS_MIN_YEARS judged
 * water years.
 */
export function doubleMass(
	series: Partial<Record<SeriesKind, DailySeries>>,
	zeroRain: ZeroRainSettings = defaultZeroRainSettings(),
	dq?: DataQualitySettings
): DoubleMass | null {
	const sa = series.rain_catchment_mm;
	const sb = series.rain_chirps_mm;
	if (!sa || !sb) return null;
	const suspect = suspectRainDays(sa, zeroRain, [], [], { dq, chirps: sb });
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

	const points = judged.map(([waterYear, y]) => ({ waterYear, x: y.b, y: y.a, days: y.days }));
	const { wholeSlope, segments, breaks } = doubleMassSegments(points);
	const years: DoubleMassYear[] = [];
	let cx = 0;
	let cy = 0;
	for (const p of points) {
		cx += p.x;
		cy += p.y;
		years.push({
			waterYear: p.waterYear,
			days: p.days,
			catchmentMm: p.y,
			chirpsMm: p.x,
			ratio: p.y / p.x,
			cumChirpsMm: cx,
			cumCatchmentMm: cy,
			residualPct: cy > 0 ? ((cy - wholeSlope * cx) / cy) * 100 : null
		});
	}
	const judgedSet = new Set(judged.map(([wy]) => wy));
	return { years, skippedYears: all.map(([wy]) => wy).filter((wy) => !judgedSet.has(wy)), wholeSlope, segments, breaks };
}

/** One judged water year of a double-mass curve: y plotted against x. */
export interface DoubleMassPoint {
	waterYear: number;
	/** The reference record's total (CHIRPS, or rain for the flow check); must be > 0. */
	x: number;
	/** The record being tested (catchment rain, or observed flow). */
	y: number;
	/** Days behind the totals. */
	days: number;
}

/**
 * The break detection behind every double-mass check: the segmentation of
 * the annual ratios y/x (0, 1 or 2 breaks by BIC, each segment at least
 * DOUBLE_MASS_MIN_SEGMENT_YEARS long, exhaustive search), keeping only the
 * breaks that are big (DOUBLE_MASS_MIN_CHANGE) and real (Pettitt or the BIC
 * gain), dropping the weakest failing one at a time. `points` are the judged
 * years in order. Used by doubleMass (rain vs CHIRPS) and by the flow-vs-rain
 * plausibility check (./plausibility/flowDoubleMass.ts).
 */
export function doubleMassSegments(points: readonly DoubleMassPoint[]): { wholeSlope: number; segments: DoubleMassSegment[]; breaks: DoubleMassBreak[] } {
	const n = points.length;
	const X = points.map((p) => p.x);
	const Y = points.map((p) => p.y);
	const D = points.map((p) => p.days);
	const R = points.map((p) => p.y / p.x);
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
				afterWaterYear: points[c - 1]!.waterYear,
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
		segments.push({ fromWaterYear: points[a]!.waterYear, toWaterYear: points[b - 1]!.waterYear, years: b - a, days: pd[b]! - pd[a]!, slope: slope(a, b) });
	}
	const wholeSlope = slope(0, n);
	return { wholeSlope, segments, breaks };
}

const signedPct = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))} %` : 'from 0');
const f2 = (x: number) => x.toFixed(2);

/**
 * The breaks as a data check (SeriesCheck 'doublemass'), or null when there
 * are none. `fitPeriod` (settings.chirpsFitPeriod, engine ≥ 0.29.0; 'ranges'
 * for a list) says whether the factors blend the segments or are fitted per
 * listed range.
 */
export function doubleMassCheck(dm: DoubleMass | null, fitPeriod: ChirpsFitPeriodInfo['period'] = 'all'): SeriesCheck | null {
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
			'so can a change in CHIRPS. ' +
			(fitPeriod === 'ranges'
				? 'The CHIRPS factors are fitted per listed water-year range (Settings → CHIRPS fit period; see the Data tab\'s double-mass chart)'
				: 'The CHIRPS factors are fitted over all segments: this check does not change them. Settings → CHIRPS fit period can fit them per water-year range, and propose ranges from these breaks (see the Data tab\'s double-mass chart)')
	};
}

/** The segment a water year falls in: the last whose first year is at or before it (the first segment for earlier years). */
function segmentOf(dm: DoubleMass, wy: number): number {
	let s = 0;
	for (let k = 1; k < dm.segments.length; k++) if (dm.segments[k]!.fromWaterYear <= wy) s = k;
	return s;
}

/**
 * The run warning for CHIRPS filling gaps across a double-mass break, or
 * null. `catchment` is the run's catchment rain after the zero-rain
 * blanking, `chirps` its CHIRPS as stored, both aligned to the run from
 * epoch day `start`. Mode 'monthly' only.
 *
 * With whole-record factors (fit period 'all'): only with a reported break,
 * when CHIRPS fills days in a segment whose slope differs by
 * DOUBLE_MASS_RUN_WARN_CHANGE or more from the fit's pooled ratio.
 *
 * With listed fit ranges (engine ≥ 0.29.0): whenever CHIRPS fills a day,
 * naming the range whose factors filled each gap, and adding the double-mass
 * segments whose slope still differs by DOUBLE_MASS_RUN_WARN_CHANGE or more
 * from the pooled ratio of the factors that filled them (a range that
 * doesn't follow the breaks).
 */
export function doubleMassRunWarning(
	dm: DoubleMass | null,
	corr: ChirpsCorrection | null,
	catchment: readonly (number | null)[],
	chirps: readonly (number | null)[],
	start: number
): string | null {
	if (!corr || corr.mode !== 'monthly') return null;
	const fitSegs = corr.fitPeriod?.segments ?? [];
	if (fitSegs.length) return segmentedRunWarning(dm, corr, catchment, chirps, start);
	const pooled = corr.pooled.ownFactor;
	if (!dm || dm.breaks.length === 0 || pooled === null || !(pooled > 0)) return null;
	const days = new Array<number>(dm.segments.length).fill(0);
	for (let t = 0; t < chirps.length; t++) {
		if (catchment[t] != null || chirps[t] == null) continue;
		days[segmentOf(dm, waterYearOf(start + t))]!++;
	}
	const parts = dm.segments.flatMap((s, k) => {
		const change = s.slope / pooled - 1;
		if (days[k] === 0 || Math.abs(change) < DOUBLE_MASS_RUN_WARN_CHANGE) return [];
		return [`${days[k]} days ${dmSpan(dm, k)}, where catchment rain reads ${f2(s.slope)} × CHIRPS (${signedPct(change)})`];
	});
	if (!parts.length) return null;
	return (
		`CHIRPS fills catchment-rain gaps with factors fitted on the whole record (pooled catchment / CHIRPS ${f2(pooled)}), ` +
		`but the double-mass check finds the ratio changed: ${parts.join('; ')}. ` +
		"Those days may run too wet or too dry. The Data tab's double-mass chart shows the segments; " +
		'Settings → CHIRPS fit period can fit the factors per water-year range instead, and propose ranges from these breaks.'
	);
}

/** The water years of double-mass segment k, open at the ends: "up to 2004/05", "2005/06 to 2011/12", "from 2012/13 on". */
function dmSpan(dm: DoubleMass, k: number): string {
	const s = dm.segments[k]!;
	const last = dm.segments.length - 1;
	if (last === 0) return 'in every year';
	if (k === 0) return `up to ${waterYearLabel(dm.segments[1]!.fromWaterYear - 1)}`;
	if (k === last) return `from ${waterYearLabel(s.fromWaterYear)} on`;
	return `${waterYearLabel(s.fromWaterYear)} to ${waterYearLabel(dm.segments[k + 1]!.fromWaterYear - 1)}`;
}

function segmentedRunWarning(
	dm: DoubleMass | null,
	corr: ChirpsCorrection,
	catchment: readonly (number | null)[],
	chirps: readonly (number | null)[],
	start: number
): string | null {
	const fitSegs = corr.fitPeriod!.segments;
	const byFit = new Array<number>(fitSegs.length).fill(0);
	// Days per (fit segment, double-mass segment) pair.
	const pairs = new Map<string, { fit: number; dm: number; days: number }>();
	for (let t = 0; t < chirps.length; t++) {
		if (catchment[t] != null || chirps[t] == null) continue;
		const wy = waterYearOf(start + t);
		const seg = chirpsFitSegmentFor(corr, wy);
		const i = seg ? fitSegs.indexOf(seg) : -1;
		if (i < 0) continue;
		byFit[i]!++;
		if (dm && dm.breaks.length) {
			const k = segmentOf(dm, wy);
			const key = `${i}:${k}`;
			const p = pairs.get(key) ?? { fit: i, dm: k, days: 0 };
			p.days++;
			pairs.set(key, p);
		}
	}
	const total = byFit.reduce((a, b) => a + b, 0);
	if (total === 0) return null;
	const ratioOf = (i: number) => fitSegs[i]!.pooled.ownFactor ?? corr.pooled.ownFactor;
	const filled = fitSegs.flatMap((s, i) => {
		if (!byFit[i]) return [];
		const r = ratioOf(i);
		return [`${byFit[i]} days ${fitSegmentFillText(s)} with the factors of ${fitSegmentName(s)}${r !== null ? ` (pooled catchment / CHIRPS ${f2(r)})` : ''}`];
	});
	const off = dm
		? [...pairs.values()].flatMap((p) => {
				const r = ratioOf(p.fit);
				const slope = dm.segments[p.dm]!.slope;
				if (r === null || !(r > 0)) return [];
				const change = slope / r - 1;
				if (Math.abs(change) < DOUBLE_MASS_RUN_WARN_CHANGE) return [];
				return [`${p.days} days ${dmSpan(dm, p.dm)} filled by ${fitSegmentName(fitSegs[p.fit]!)}, where catchment rain reads ${f2(slope)} × CHIRPS (${signedPct(change)})`];
			})
		: [];
	return (
		`CHIRPS fills catchment-rain gaps with factors fitted per listed water-year range (Settings → CHIRPS fit period): ${filled.join('; ')}.` +
		(off.length ? ` But the double-mass check finds the ratio differs from the factors that filled: ${off.join('; ')}. Those days may run too wet or too dry.` : '') +
		" The Data tab's double-mass chart shows the segments."
	);
}

/**
 * Water-year ranges for settings.chirpsFitPeriod proposed from the reported
 * breaks (engine ≥ 0.29.0, issue #40): one per double-mass segment, from its
 * first judged year to the year before the next segment's (the first from
 * its own first judged year, the last to its last), each with a reason that
 * says it is a proposal. Empty without a reported break. Never applied by
 * itself: a break's position is an estimate (the 5-year minimum segment and
 * dry years can move it a year or two, and a CHIRPS product change moves it
 * too), so the hydrologist checks each range against the station history
 * before saving it.
 */
export function proposeChirpsFitRanges(dm: DoubleMass | null): ChirpsFitRange[] {
	if (!dm || dm.breaks.length === 0) return [];
	const last = dm.segments.length - 1;
	return dm.segments.map((s, k) => ({
		fromWaterYear: s.fromWaterYear,
		toWaterYear: k === last ? s.toWaterYear : dm.segments[k + 1]!.fromWaterYear - 1,
		reason: `proposed from the double-mass check (catchment / CHIRPS ${f2(s.slope)}): confirm against the station history`
	}));
}
