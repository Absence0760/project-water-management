// The WR2012 check's settings: the reference as entered, the thresholds, the
// calibration penalty, their defaults and the checks the Settings form, the
// backend and the engine share. Apart from the comparison (./wr2012.ts), so
// pages that edit or show the settings don't load it (issue #9). Pure: no I/O.
import { regroup } from '../format';


/** The quaternary catchment's naturalised flow, as entered from WR2012. */
export interface Wr2012Reference {
	/** Quaternary catchment code, e.g. "A21B". */
	quaternary: string;
	/** Area of the quaternary catchment, km². */
	areaKm2: number;
	/** Naturalised mean annual runoff, Mm³ a year. */
	marMm3: number;
	/** Mean naturalised flow per water-year month (Oct … Sep), Mm³ per month. */
	monthlyMm3: number[];
	/**
	 * First and last hydrological year the reference covers, each labelled by
	 * the calendar year it starts in (1920 = Oct 1920 – Sep 1921).
	 */
	periodStart: number;
	periodEnd: number;
	/** Mean annual precipitation over the quaternary, mm. Optional; enables the rainfall scaling and the rain check. */
	mapMm: number | null;
	/** Where the numbers come from (study, table, version). */
	source: string;
}

/**
 * How the reference is scaled to the modelled catchment:
 * - 'area': × modelled area ÷ quaternary area;
 * - 'areaRain': also × modelled MAP ÷ quaternary MAP (needs the quaternary MAP
 *   and a rainfall series; otherwise area only, with a warning).
 */
export type Wr2012Scaling = 'area' | 'areaRain';
export const WR2012_SCALINGS = ['area', 'areaRain'] as const;

/**
 * Deviation thresholds on the MAR ratio, in % (simulated ÷ scaled WR2012 − 1).
 * A deviation of at least notePct is noted; at least queryPct, or wetter by
 * more than queryWetterPct, is queried; at least unusablePct makes the run
 * unusable for EWR findings until it is explained.
 */
export interface Wr2012Flags {
	notePct: number;
	queryPct: number;
	queryWetterPct: number;
	unusablePct: number;
}

export interface Wr2012Settings {
	/** null = no WR2012 check. */
	reference: Wr2012Reference | null;
	scaling: Wr2012Scaling;
	/**
	 * Calendar months (1–12) reported as the dry season. null = the project's
	 * own low-flow months, found from the run's simulated natural flow.
	 */
	lowFlowMonths: number[] | null;
	flags: Wr2012Flags;
	/**
	 * Soft penalty on the MAR in automatic calibration. Off by default.
	 * marLowMm3 / marHighMm3 (Mm³/a, already at the modelled catchment's
	 * scale — not the quaternary's) are an optional band: both null (the
	 * default) is a single target, ref.marMm3 scaled the usual way; both set
	 * makes the penalty zero inside [marLowMm3, marHighMm3] and weight ×
	 * |ln(simulated MAR ÷ the nearer bound)| outside it. Useful when two
	 * published natural-MAR estimates for the catchment disagree, so there is
	 * no single number to pull towards. Always both or neither (resolveWr2012
	 * drops a one-sided or inverted band with a warning).
	 */
	calibrationPenalty: { enabled: boolean; weight: number; marLowMm3: number | null; marHighMm3: number | null };
}

export function defaultWr2012Settings(): Wr2012Settings {
	return {
		reference: null,
		scaling: 'area',
		lowFlowMonths: null,
		flags: { notePct: 10, queryPct: 25, queryWetterPct: 15, unusablePct: 50 },
		calibrationPenalty: { enabled: false, weight: 0.5, marLowMm3: null, marHighMm3: null }
	};
}

/** Largest share the 12 monthly means may differ from the MAR by (rounding in the published tables). */
export const WR2012_MONTHLY_SUM_TOLERANCE = 0.05;
/** Highest calibration penalty weight accepted. */
export const WR2012_MAX_PENALTY_WEIGHT = 10;

/** Rain volume (Mm³ a year) of `mapMm` mm a year over `areaKm2` km²: 1 mm on 1 km² is 1 000 m³. */
export const rainVolumeMm3 = (mapMm: number, areaKm2: number) => (mapMm * areaKm2) / 1000;

/** m³/day → Mm³ over `days` days. */
export const m3DayToMm3 = (m3Day: number, days: number) => (m3Day * days) / 1e6;

export interface Wr2012Issue {
	/** Field the problem is on (a key of Wr2012Reference or Wr2012Flags). */
	field: string;
	message: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
// As ./wr2012.ts formats its numbers.
const fmt = (v: number, digits = 3) => {
	const s = new Intl.NumberFormat('en-US', { maximumSignificantDigits: Math.max(1, digits) }).format(v);
	return s === '-0' ? '0' : regroup(s);
};

/**
 * Plausibility problems with an entered reference: the MAR can't exceed the
 * rain that falls on the quaternary (when its MAP is given), and the monthly
 * means must add up to the MAR within WR2012_MONTHLY_SUM_TOLERANCE. Shared by
 * the backend's validation, the Settings form and the engine.
 */
export function wr2012ReferenceIssues(ref: Wr2012Reference): Wr2012Issue[] {
	const out: Wr2012Issue[] = [];
	if (!ref.quaternary?.trim()) out.push({ field: 'quaternary', message: 'Enter the quaternary catchment code.' });
	if (!ref.source?.trim()) out.push({ field: 'source', message: 'Say where the numbers come from (study, table).' });
	if (!(isNum(ref.areaKm2) && ref.areaKm2 > 0)) out.push({ field: 'areaKm2', message: 'The quaternary area must be more than 0 km².' });
	if (!(isNum(ref.marMm3) && ref.marMm3 >= 0)) out.push({ field: 'marMm3', message: 'The MAR must be 0 or more.' });
	const monthly = Array.isArray(ref.monthlyMm3) ? ref.monthlyMm3 : [];
	if (monthly.length !== 12 || !monthly.every((v) => isNum(v) && v >= 0)) {
		out.push({ field: 'monthlyMm3', message: 'Enter 12 monthly means of 0 or more.' });
	}
	if (!Number.isInteger(ref.periodStart) || !Number.isInteger(ref.periodEnd) || ref.periodEnd < ref.periodStart) {
		out.push({ field: 'periodEnd', message: 'The reference period must be whole years, ending no earlier than it starts.' });
	}
	if (ref.mapMm !== null && !(isNum(ref.mapMm) && ref.mapMm > 0)) out.push({ field: 'mapMm', message: 'The MAP must be more than 0 mm, or left blank.' });
	if (out.length) return out;

	if (ref.mapMm !== null) {
		const rain = rainVolumeMm3(ref.mapMm, ref.areaKm2);
		if (ref.marMm3 > rain) {
			out.push({
				field: 'marMm3',
				message: `The MAR (${fmt(ref.marMm3)} Mm³/a) is more than the rain on the quaternary (${fmt(ref.mapMm)} mm × ${fmt(ref.areaKm2)} km² = ${fmt(rain)} Mm³/a).`
			});
		}
	}
	const sum = monthly.reduce((s, v) => s + v, 0);
	if (Math.abs(sum - ref.marMm3) > WR2012_MONTHLY_SUM_TOLERANCE * ref.marMm3) {
		out.push({
			field: 'monthlyMm3',
			message: `The monthly means add up to ${fmt(sum)} Mm³, more than ${WR2012_MONTHLY_SUM_TOLERANCE * 100} % away from the MAR (${fmt(ref.marMm3)} Mm³/a).`
		});
	}
	return out;
}

/**
 * Validates the calibration penalty group: the weight must be in range, and
 * the optional MAR band must be both bounds or neither, each 0 or more, low ≤
 * high. Shared by the backend's zod schema, the Settings form and
 * `resolveWr2012`.
 */
export function wr2012PenaltyIssues(p: { weight: number; marLowMm3: number | null | undefined; marHighMm3: number | null | undefined }): Wr2012Issue[] {
	const out: Wr2012Issue[] = [];
	if (!(isNum(p.weight) && p.weight >= 0 && p.weight <= WR2012_MAX_PENALTY_WEIGHT)) {
		out.push({ field: 'weight', message: `Enter a penalty weight from 0 to ${WR2012_MAX_PENALTY_WEIGHT}.` });
	}
	// Settings stored before the band existed have no marLowMm3/marHighMm3 keys at all: treat missing the same as null.
	const lo = p.marLowMm3 ?? null;
	const hi = p.marHighMm3 ?? null;
	if (lo !== null || hi !== null) {
		if (lo === null || hi === null) {
			out.push({ field: 'marLowMm3', message: 'Enter both a low and high bound for the MAR band, or leave both blank.' });
		} else if (!isNum(lo) || lo < 0) {
			out.push({ field: 'marLowMm3', message: 'The MAR band’s low bound must be 0 or more.' });
		} else if (!isNum(hi) || hi < 0) {
			out.push({ field: 'marHighMm3', message: 'The MAR band’s high bound must be 0 or more.' });
		} else if (lo > hi) {
			out.push({ field: 'marHighMm3', message: 'The MAR band’s low bound can’t be above its high bound.' });
		}
	}
	return out;
}

/** The thresholds must be positive and ordered: note ≤ query ≤ unusable, and wetter-query ≤ query. */
export function wr2012FlagIssues(f: Wr2012Flags): Wr2012Issue[] {
	const out: Wr2012Issue[] = [];
	for (const k of ['notePct', 'queryPct', 'queryWetterPct', 'unusablePct'] as const) {
		if (!(isNum(f[k]) && f[k] > 0 && f[k] <= 1000)) out.push({ field: k, message: 'Enter a percentage above 0 (at most 1 000).' });
	}
	if (out.length) return out;
	if (!(f.notePct <= f.queryPct && f.queryPct <= f.unusablePct)) {
		out.push({ field: 'queryPct', message: 'The thresholds must rise: note ≤ query ≤ not usable.' });
	}
	if (f.queryWetterPct > f.queryPct) out.push({ field: 'queryWetterPct', message: 'The wetter-than threshold can’t be above the query threshold.' });
	return out;
}
