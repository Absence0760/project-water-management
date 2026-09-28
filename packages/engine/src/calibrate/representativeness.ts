// How representative the calibration record is (calibration research CR-34,
// part of CR-22; engine 1.18.0): its length, and where its water years sit in
// the long-term rainfall distribution. A few years from one climate state
// can't support the flow's variability (the SD behind KGE's α), its seasonal
// pattern or a high-flow calibration, however good the scores look, so the
// report says so (docs/model.md §2.10b, "How representative is the record").
//
// The long-term reference is the run's own catchment rain as calibration
// reads it (catchment rain, else bias-corrected CHIRPS, else forecast, × the
// areal factor: `runRain`), over the whole run: by default the run covers the
// whole rain record, CHIRPS-infilled days included, which is the longest
// record the project holds.
import { toEpochDay, waterYearLabel, waterYearOf } from '../calendar';

/** A water year below this rain percentile (non-exceedance, 0–100) is called dry. Default, for the hydrologist to confirm. */
export const DRY_PERCENTILE = 33;
/** A water year above this rain percentile is called wet. */
export const WET_PERCENTILE = 67;
/** A water year's rain total counts only when rain has a value on at least this share of its days (and the whole year is inside the run). */
export const MIN_RAIN_COVERAGE = 0.95;
/** Fewer complete water years of rain than this are too short a long-term reference to rank the calibration years in. */
export const LONG_TERM_MIN_YEARS = 10;
/** Fewer scored water years than this can't pin down the flow's variability, seasonal pattern or high flows. */
export const FEW_CALIBRATION_YEARS = 5;

export type YearClass = 'dry' | 'normal' | 'wet';

export interface RepresentativenessYear {
	/** Water year, by the calendar year it starts in. */
	waterYear: number;
	/** Observed days scored in it. */
	scoredDays: number;
	/** The water year's rain (mm), or null when it isn't complete (part outside the run, or under MIN_RAIN_COVERAGE). */
	rainMm: number | null;
	/** Non-exceedance percentile (0–100) of rainMm among the long-term water-year totals (mid-rank), or null. */
	percentile: number | null;
	/** Dry (below DRY_PERCENTILE), wet (above WET_PERCENTILE) or normal; null without a percentile or with a short long-term record. */
	class: YearClass | null;
}

export interface RecordRepresentativeness {
	/** Observed days scored. */
	scoredDays: number;
	/** Water years with at least one scored day. */
	waterYears: number;
	/** Each scored water year, ascending. */
	years: RepresentativenessYear[];
	/** The long-term reference: the run's complete water years of rain. null when there are none. */
	longTerm: { years: number; firstYear: number; lastYear: number; meanMm: number; medianMm: number } | null;
	/** Mean rain (mm/a) of the scored water years that are complete. */
	calibrationMeanMm: number | null;
	/** calibrationMeanMm ÷ the long-term mean. */
	meanRatio: number | null;
	/** The dry and wet percentile thresholds applied. */
	thresholds: { dry: number; wet: number };
	/** One plain-language statement of the record's length and wetness, always given. */
	summary: string;
	/** Plain-language limits it implies (also in the report's notes). */
	notes: string[];
}

/** Mid-rank non-exceedance percentile of `v` among `sorted` (ascending): 100 × (below + ½ × equal) ÷ n. */
export function midRankPercentile(sorted: readonly number[], v: number): number {
	let below = 0;
	let equal = 0;
	for (const x of sorted) {
		if (x < v) below++;
		else if (x === v) equal++;
	}
	return (100 * (below + 0.5 * equal)) / sorted.length;
}

export const classOf = (percentile: number): YearClass => (percentile < DRY_PERCENTILE ? 'dry' : percentile > WET_PERCENTILE ? 'wet' : 'normal');

/**
 * Water-year rain totals (mm) of a daily rain series starting `startDate`:
 * only water years wholly inside it with a value on at least
 * MIN_RAIN_COVERAGE of their days.
 */
export function waterYearRainTotals(rain: ArrayLike<number | null>, startDate: string): Map<number, number> {
	const d0 = toEpochDay(startDate);
	const n = rain.length;
	const by = new Map<number, { sum: number; valued: number; days: number; first: number }>();
	for (let t = 0; t < n; t++) {
		const wy = waterYearOf(d0 + t);
		let y = by.get(wy);
		if (!y) by.set(wy, (y = { sum: 0, valued: 0, days: 0, first: t }));
		y.days++;
		const v = rain[t];
		if (typeof v === 'number' && Number.isFinite(v)) {
			y.sum += Math.max(0, v);
			y.valued++;
		}
	}
	const out = new Map<number, number>();
	for (const [wy, y] of by) {
		const full = toEpochDay(`${wy + 1}-10-01`) - toEpochDay(`${wy}-10-01`);
		if (y.days === full && y.valued >= MIN_RAIN_COVERAGE * full) out.set(wy, y.sum);
	}
	return out;
}

/** 33 → "33rd". */
const ordinal = (n: number) => {
	const t = n % 100;
	return `${n}${t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};
const s = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const yearsRange = (a: number, b: number) => (a === b ? `WY ${waterYearLabel(a)}` : `WY ${waterYearLabel(a)}–${waterYearLabel(b)}`);

/**
 * How representative the scored days are of the long-term rainfall: see the
 * file comment. `rain` is the run's daily rain (mm, null = missing) from
 * `startDate`; `scoredDays` the run-day indices calibration scores.
 */
export function recordRepresentativeness(rain: ArrayLike<number | null>, startDate: string, scoredDays: ArrayLike<number>): RecordRepresentativeness {
	const d0 = toEpochDay(startDate);
	const totals = waterYearRainTotals(rain, startDate);
	const sorted = [...totals.values()].sort((a, b) => a - b);
	const ltYears = [...totals.keys()].sort((a, b) => a - b);
	const longTerm = sorted.length
		? {
				years: sorted.length,
				firstYear: ltYears[0]!,
				lastYear: ltYears[ltYears.length - 1]!,
				meanMm: sorted.reduce((a, b) => a + b, 0) / sorted.length,
				medianMm: sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2
			}
		: null;
	const enough = !!longTerm && longTerm.years >= LONG_TERM_MIN_YEARS;

	const perYear = new Map<number, number>();
	for (let i = 0; i < scoredDays.length; i++) {
		const wy = waterYearOf(d0 + scoredDays[i]!);
		perYear.set(wy, (perYear.get(wy) ?? 0) + 1);
	}
	const years: RepresentativenessYear[] = [...perYear.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([waterYear, days]) => {
			const rainMm = totals.get(waterYear) ?? null;
			const percentile = rainMm !== null && sorted.length ? midRankPercentile(sorted, rainMm) : null;
			return { waterYear, scoredDays: days, rainMm, percentile, class: percentile !== null && enough ? classOf(percentile) : null };
		});
	const withRain = years.filter((y) => y.rainMm !== null);
	const calibrationMeanMm = withRain.length ? withRain.reduce((a, y) => a + y.rainMm!, 0) / withRain.length : null;
	const meanRatio = calibrationMeanMm !== null && longTerm && longTerm.meanMm > 0 ? calibrationMeanMm / longTerm.meanMm : null;

	const n = years.length;
	const span = n ? ` (${yearsRange(years[0]!.waterYear, years[n - 1]!.waterYear)})` : '';
	let summary = `The calibration record has ${s(scoredDays.length, 'scored day')} over ${s(n, 'water year')}${span}.`;
	if (calibrationMeanMm !== null && longTerm && meanRatio !== null) {
		summary +=
			` Their mean rain, ${Math.round(calibrationMeanMm)} mm a year, is ${Math.round(meanRatio * 100)} % of the long-term mean of ${Math.round(longTerm.meanMm)} mm` +
			` (${s(longTerm.years, 'complete water year')}, ${yearsRange(longTerm.firstYear, longTerm.lastYear)}).`;
	} else if (longTerm) {
		summary += ` None of its water years has a complete rain record to compare with the long-term mean of ${Math.round(longTerm.meanMm)} mm (${s(longTerm.years, 'complete water year')}).`;
	} else {
		summary += ' The rain record has no complete water year to compare it with.';
	}

	const notes: string[] = [];
	if (!enough) {
		notes.push(
			`The rain record has only ${s(longTerm?.years ?? 0, 'complete water year')}, too short a long-term reference (at least ${LONG_TERM_MIN_YEARS}) to say how typical the calibration years are.`
		);
	} else {
		const ranked = years.filter((y) => y.class !== null);
		const m = ranked.length;
		const dry = ranked.filter((y) => y.class === 'dry').length;
		const wet = ranked.filter((y) => y.class === 'wet').length;
		const ref = `of the ${longTerm!.years}-year rain record`;
		const cover = `The calibration record covers ${s(m, 'water year')} with complete rain`;
		if (m > 0 && dry === m) {
			notes.push(`${cover}, ${m === 1 ? 'a dry one' : 'all dry'} (below the ${ordinal(DRY_PERCENTILE)} percentile ${ref}): it can't show how the model behaves in wet years.`);
		} else if (m > 0 && wet === m) {
			notes.push(`${cover}, ${m === 1 ? 'a wet one' : 'all wet'} (above the ${ordinal(WET_PERCENTILE)} percentile ${ref}): it can't show how the model behaves in droughts.`);
		} else if (m > 0 && dry === 0 && wet === 0) {
			notes.push(
				`${cover}, ${m === 1 ? 'a near-normal one' : 'all near-normal'} (between the ${ordinal(DRY_PERCENTILE)} and ${ordinal(WET_PERCENTILE)} percentile ${ref}): neither droughts nor wet years are tested.`
			);
		} else if (m > 0 && wet === 0) {
			notes.push(`None of the calibration record's ${s(m, 'water year')} with complete rain is wet (above the ${ordinal(WET_PERCENTILE)} percentile ${ref}): wet-year behaviour and high flows are weakly constrained.`);
		} else if (m > 0 && dry === 0) {
			notes.push(`None of the calibration record's ${s(m, 'water year')} with complete rain is dry (below the ${ordinal(DRY_PERCENTILE)} percentile ${ref}): drought behaviour and low flows are weakly constrained.`);
		}
	}
	if (n < FEW_CALIBRATION_YEARS) {
		notes.push(
			`The calibration record covers only ${s(n, 'water year')}, fewer than ${FEW_CALIBRATION_YEARS}: too few to pin down the flow's variability (its SD), its seasonal pattern or its high flows, whatever the scores say.`
		);
	}
	return { scoredDays: scoredDays.length, waterYears: n, years, longTerm, calibrationMeanMm, meanRatio, thresholds: { dry: DRY_PERCENTILE, wet: WET_PERCENTILE }, summary, notes };
}
