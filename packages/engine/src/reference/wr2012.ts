// Optional WR2012 check (issue #4 phase 8): compare the run's simulated
// *natural* flow with the naturalised flow the Water Resources of South Africa
// 2012 study (WR2012) publishes for the quaternary catchment the project lies
// in. The reference is entered by the user from the public study, never
// bundled. Pure: no I/O.
//
// Why natural flow: WR2012 flows are naturalised (no farms, dams or
// abstraction), so they compare with the rain → flow model's output before the
// network takes anything out. Comparing them with the simulated outflow would
// score the model against a record of a different quantity (audit C1).
//
// Units: the reference MAR is in Mm³ a year, and the 12 monthly means are in
// Mm³ per month (water-year order, Oct … Sep), the units WR2012 publishes its
// naturalised flow tables in. Simulated flow is m³/day and is converted here.
import { daysPerMonth, monthOfEpochDay, toEpochDay, waterYearIndex } from '../calendar';

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

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Stored WR2012 settings merged over the defaults; an unusable reference or bad thresholds are dropped with a warning. */
export function resolveWr2012(raw: unknown, warnings: string[]): Wr2012Settings {
	const d = defaultWr2012Settings();
	if (!isObj(raw)) return d;
	const s: Wr2012Settings = {
		reference: isObj(raw.reference) ? (raw.reference as unknown as Wr2012Reference) : null,
		scaling: (WR2012_SCALINGS as readonly unknown[]).includes(raw.scaling) ? (raw.scaling as Wr2012Scaling) : d.scaling,
		lowFlowMonths: Array.isArray(raw.lowFlowMonths)
			? [...new Set(raw.lowFlowMonths.filter((m): m is number => Number.isInteger(m) && m >= 1 && m <= 12))].sort((a, b) => a - b)
			: null,
		flags: { ...d.flags, ...(isObj(raw.flags) ? (raw.flags as Partial<Wr2012Flags>) : {}) },
		calibrationPenalty: { ...d.calibrationPenalty, ...(isObj(raw.calibrationPenalty) ? (raw.calibrationPenalty as object) : {}) }
	};
	if (s.lowFlowMonths?.length === 0) s.lowFlowMonths = null;
	if (s.reference) {
		const ref = { ...s.reference, mapMm: s.reference.mapMm ?? null } as Wr2012Reference;
		const issues = wr2012ReferenceIssues(ref);
		if (issues.length) {
			warnings.push(`WR2012 check skipped: the reference data isn't usable (${issues.map((i) => i.message).join(' ')})`);
			s.reference = null;
		} else s.reference = ref;
	}
	const flagIssues = wr2012FlagIssues(s.flags);
	if (flagIssues.length) {
		warnings.push(`WR2012 deviation thresholds aren't usable (${flagIssues.map((i) => i.message).join(' ')}); using the defaults`);
		s.flags = d.flags;
	}
	const penaltyIssues = wr2012PenaltyIssues(s.calibrationPenalty);
	if (penaltyIssues.length) {
		const bad = new Set(penaltyIssues.map((i) => i.field));
		warnings.push(`WR2012 calibration penalty settings aren't usable (${penaltyIssues.map((i) => i.message).join(' ')}); using the default instead`);
		if (bad.has('weight')) s.calibrationPenalty = { ...s.calibrationPenalty, weight: d.calibrationPenalty.weight };
		if (bad.has('marLowMm3') || bad.has('marHighMm3')) s.calibrationPenalty = { ...s.calibrationPenalty, marLowMm3: null, marHighMm3: null };
	}
	s.calibrationPenalty.enabled = s.calibrationPenalty.enabled === true;
	return s;
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

export type Wr2012FlagLevel = 'ok' | 'note' | 'query' | 'unusable';

export interface Wr2012Month {
	/** Calendar month 1–12 (the list runs in water-year order, Oct … Sep). */
	month: number;
	/** Mean simulated natural flow in this month, Mm³. */
	simulatedMm3: number;
	/** Scaled WR2012 mean for this month, Mm³. */
	referenceMm3: number;
	/** simulated ÷ reference; null when the reference is 0. */
	ratio: number | null;
	/** One of the dry-season months. */
	lowFlow: boolean;
}

export interface Wr2012Report {
	quaternary: string;
	source: string;
	referencePeriod: { start: number; end: number };
	/** Always the simulated natural flow: WR2012 flows are naturalised. */
	compared: 'natural_flow';
	scaling: {
		/** The rule applied (the rain ratio falls back to area when the data is missing). */
		rule: Wr2012Scaling;
		/** The rule the settings asked for. */
		requested: Wr2012Scaling;
		/** The reference is multiplied by this. */
		factor: number;
		areaFactor: number;
		rainFactor: number | null;
		modelAreaKm2: number;
		referenceAreaKm2: number;
		/** Mean annual rain on the modelled catchment over the compared years (null without rain). */
		modelMapMm: number | null;
		referenceMapMm: number | null;
	};
	referenceMarMm3: number;
	/** referenceMarMm3 × factor. */
	scaledMarMm3: number;
	/** Complete water years of the run inside the reference period; null when there are none. */
	overlap: { years: number[]; simulatedMarMm3: number; ratio: number | null } | null;
	/** Mean annual natural flow over the whole run (all days × 365.25 ÷ days). */
	whole: { days: number; simulatedMarMm3: number; ratio: number | null };
	/** Days the monthly pattern was taken over: the overlap years when there are any, else the whole run. */
	monthlyBasis: 'overlap' | 'whole';
	months: Wr2012Month[];
	/** Calendar months of the dry season, and whether they were set in Settings or found from the run. */
	lowFlowMonths: number[];
	lowFlowSource: 'setting' | 'simulated';
	/** Σ simulated ÷ Σ scaled reference over the dry-season months. */
	lowFlowRatio: number | null;
	/** Pearson correlation of the 12 monthly means (null when either is flat). */
	patternCorrelation: number | null;
	flag: {
		level: Wr2012FlagLevel;
		/** The MAR ratio the flag was judged on. */
		basis: 'overlap' | 'whole';
		/** 100 × (ratio − 1). */
		deviationPct: number | null;
		thresholds: Wr2012Flags;
		/** Plain-language run warning; null when the level is 'ok'. */
		text: string | null;
	};
}

export interface Wr2012Input {
	settings: Wr2012Settings;
	startDate: string;
	/** Simulated natural flow, m³/day, one value per run day. */
	natural: ArrayLike<number>;
	/** Modelled catchment area, km². */
	areaKm2: number;
	/** Daily rain on the catchment (mm; null = missing), or null when the project has no rainfall series. */
	rainMm: ArrayLike<number | null> | null;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS_PER_YEAR = 365.25;

/**
 * The run days the MAR is taken over: every day of the complete water years
 * (Oct 1 – Sep 30 all inside the run) that fall in the reference period, or
 * null when there are none.
 */
export function overlapDays(startDate: string, days: number, periodStart: number, periodEnd: number): { idx: Int32Array; years: number[] } | null {
	const d0 = toEpochDay(startDate);
	const years: number[] = [];
	const idx: number[] = [];
	const firstYear = new Date(d0 * 86_400_000).getUTCFullYear() - 1;
	const lastYear = new Date((d0 + days - 1) * 86_400_000).getUTCFullYear();
	for (let y = Math.max(firstYear, periodStart); y <= Math.min(lastYear, periodEnd); y++) {
		const a = toEpochDay(`${String(y).padStart(4, '0')}-10-01`) - d0;
		const b = toEpochDay(`${String(y + 1).padStart(4, '0')}-09-30`) - d0;
		if (a < 0 || b > days - 1) continue;
		years.push(y);
		for (let t = a; t <= b; t++) idx.push(t);
	}
	return years.length ? { idx: Int32Array.from(idx), years } : null;
}

/**
 * Mean flow volume per water-year month (Oct … Sep), Mm³: the mean daily flow
 * of that month over the given days (m³/day) × the month's mean length (Feb
 * 28.25 days), ÷ 10⁶. Months with no day in `idx` are 0.
 */
export function monthlyMeansMm3(naturalM3Day: ArrayLike<number>, startDate: string, idx?: ArrayLike<number>): number[] {
	const d0 = toEpochDay(startDate);
	const sum = new Float64Array(12);
	const n = new Float64Array(12);
	const count = idx ? idx.length : naturalM3Day.length;
	for (let i = 0; i < count; i++) {
		const t = idx ? idx[i]! : i;
		const wy = waterYearIndex(monthOfEpochDay(d0 + t));
		sum[wy] = sum[wy]! + naturalM3Day[t]!;
		n[wy] = n[wy]! + 1;
	}
	const len = daysPerMonth(28.25);
	return Array.from({ length: 12 }, (_, i) => (n[i]! > 0 ? m3DayToMm3(sum[i]! / n[i]!, len[i]!) : 0));
}

function pearson(a: readonly number[], b: readonly number[]): number | null {
	const n = a.length;
	const ma = a.reduce((s, v) => s + v, 0) / n;
	const mb = b.reduce((s, v) => s + v, 0) / n;
	let sab = 0;
	let saa = 0;
	let sbb = 0;
	for (let i = 0; i < n; i++) {
		sab += (a[i]! - ma) * (b[i]! - mb);
		saa += (a[i]! - ma) ** 2;
		sbb += (b[i]! - mb) ** 2;
	}
	return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

/**
 * The project's own dry season: calendar months whose mean simulated flow is
 * below half the average month (the lowest month when none is).
 */
export function lowFlowMonthsFrom(monthlyMm3: readonly number[]): number[] {
	const mean = monthlyMm3.reduce((s, v) => s + v, 0) / 12;
	const cal = (wy: number) => ((wy + 9) % 12) + 1; // water-year index → calendar month
	let out = monthlyMm3.flatMap((v, i) => (v < 0.5 * mean ? [cal(i)] : []));
	if (out.length === 0) {
		let lo = 0;
		for (let i = 1; i < 12; i++) if (monthlyMm3[i]! < monthlyMm3[lo]!) lo = i;
		out = [cal(lo)];
	}
	return out.sort((a, b) => a - b);
}

/** Mean annual rain (mm) over the given days: mean of the days with a value × 365.25; null without enough rain values. */
function meanAnnualRain(rain: ArrayLike<number | null> | null, idx: ArrayLike<number> | null, days: number): number | null {
	if (!rain) return null;
	let s = 0;
	let n = 0;
	const count = idx ? idx.length : days;
	for (let i = 0; i < count; i++) {
		const v = rain[idx ? idx[i]! : i];
		if (v === null || v === undefined || !Number.isFinite(v)) continue;
		s += Math.max(0, v);
		n++;
	}
	// A year of rain values at least, and most of the compared days.
	return n >= 365 && n >= 0.9 * count ? (s / n) * DAYS_PER_YEAR : null;
}

export interface Wr2012Scale {
	rule: Wr2012Scaling;
	factor: number;
	areaFactor: number;
	rainFactor: number | null;
	modelMapMm: number | null;
	/** Why the rain ratio couldn't be used, when it was asked for. */
	fallback: string | null;
}

/** The factor the reference is multiplied by to describe the modelled catchment. */
export function wr2012Scale(ws: Wr2012Settings, ref: Wr2012Reference, areaKm2: number, modelMapMm: number | null): Wr2012Scale {
	const areaFactor = areaKm2 / ref.areaKm2;
	if (ws.scaling === 'areaRain') {
		const missing = ref.mapMm === null ? 'the quaternary MAP is not entered' : modelMapMm === null ? 'the run has less than a year of rainfall values' : null;
		if (!missing) {
			const rainFactor = modelMapMm! / ref.mapMm!;
			return { rule: 'areaRain', factor: areaFactor * rainFactor, areaFactor, rainFactor, modelMapMm, fallback: null };
		}
		return { rule: 'area', factor: areaFactor, areaFactor, rainFactor: null, modelMapMm, fallback: missing };
	}
	return { rule: 'area', factor: areaFactor, areaFactor, rainFactor: null, modelMapMm, fallback: null };
}

const fmt = (v: number, digits = 3) => {
	const s = new Intl.NumberFormat('en-US', { maximumSignificantDigits: Math.max(1, digits) }).format(v);
	return s === '-0' ? '0' : s;
};
const pctText = (v: number) => `${Math.round(Math.abs(v))} %`;

/** The flag level for a MAR deviation (%, simulated vs scaled reference). */
export function wr2012FlagLevel(deviationPct: number | null, f: Wr2012Flags): Wr2012FlagLevel {
	if (deviationPct === null) return 'ok';
	const a = Math.abs(deviationPct);
	if (a >= f.unusablePct) return 'unusable';
	if (a >= f.queryPct || deviationPct > f.queryWetterPct) return 'query';
	if (a >= f.notePct) return 'note';
	return 'ok';
}

/**
 * Compare a run's simulated natural flow with the scaled WR2012 reference.
 * Returns null when there is no reference. Adds plain-language run warnings.
 */
export function wr2012Report(input: Wr2012Input, warnings: string[]): Wr2012Report | null {
	const ws = input.settings;
	const ref = ws.reference;
	if (!ref) return null;
	const { natural, startDate, areaKm2 } = input;
	const days = natural.length;
	if (!(areaKm2 > 0) || days === 0) {
		warnings.push('WR2012 check skipped: the modelled catchment has no area or the run no days');
		return null;
	}

	const ov = overlapDays(startDate, days, ref.periodStart, ref.periodEnd);
	const basisIdx = ov?.idx ?? null;
	const modelMapMm = meanAnnualRain(input.rainMm, basisIdx, days);
	const scale = wr2012Scale(ws, ref, areaKm2, modelMapMm);
	if (scale.fallback) warnings.push(`WR2012 check: scaled by area only, because ${scale.fallback}`);
	const scaledMar = ref.marMm3 * scale.factor;
	const ratio = (sim: number) => (scaledMar > 0 ? sim / scaledMar : null);

	let total = 0;
	for (let t = 0; t < days; t++) total += natural[t]!;
	const wholeMar = m3DayToMm3(total / days, DAYS_PER_YEAR);
	let overlap: Wr2012Report['overlap'] = null;
	if (ov) {
		let s = 0;
		for (const t of ov.idx) s += natural[t]!;
		const mar = s / 1e6 / ov.years.length;
		overlap = { years: ov.years, simulatedMarMm3: mar, ratio: ratio(mar) };
	} else {
		warnings.push(
			`WR2012 check: the run has no complete water year inside the reference period (${ref.periodStart}/${String((ref.periodStart + 1) % 100).padStart(2, '0')} – ` +
				`${ref.periodEnd}/${String((ref.periodEnd + 1) % 100).padStart(2, '0')}), so the MAR is compared over the whole run`
		);
	}

	const simMonthly = monthlyMeansMm3(natural, startDate, basisIdx ?? undefined);
	const refMonthly = ref.monthlyMm3.map((v) => v * scale.factor);
	const lowFlowSource = ws.lowFlowMonths ? 'setting' : 'simulated';
	const lowFlowMonths = ws.lowFlowMonths ?? lowFlowMonthsFrom(simMonthly);
	const low = new Set(lowFlowMonths);
	const months: Wr2012Month[] = simMonthly.map((sim, i) => {
		const month = ((i + 9) % 12) + 1;
		const r = refMonthly[i]!;
		return { month, simulatedMm3: sim, referenceMm3: r, ratio: r > 0 ? sim / r : null, lowFlow: low.has(month) };
	});
	let lowSim = 0;
	let lowRef = 0;
	for (const m of months) {
		if (!m.lowFlow) continue;
		lowSim += m.simulatedMm3;
		lowRef += m.referenceMm3;
	}

	const basis = overlap ? 'overlap' : 'whole';
	const flagRatio = overlap ? overlap.ratio : ratio(wholeMar);
	const deviationPct = flagRatio === null ? null : 100 * (flagRatio - 1);
	const level = wr2012FlagLevel(deviationPct, ws.flags);
	let text: string | null = null;
	if (level !== 'ok' && deviationPct !== null) {
		const period = overlap
			? `over the ${overlap.years.length} water year${overlap.years.length === 1 ? '' : 's'} both cover`
			: 'over the whole run (no year overlaps the reference period)';
		const head =
			`Simulated natural flow is ${pctText(deviationPct)} ${deviationPct > 0 ? 'above' : 'below'} the WR2012 naturalised MAR for ${ref.quaternary} ` +
			`(scaled to the modelled catchment) ${period}.`;
		text =
			level === 'unusable'
				? `${head} Don't use this run for EWR findings until the difference is explained.`
				: level === 'query'
					? `${head} Query it: check the rainfall, the catchment area and the calibration before relying on the results.`
					: `${head} Note the difference when reporting.`;
		warnings.push(text);
	}
	if (modelMapMm !== null) {
		const rain = rainVolumeMm3(modelMapMm, areaKm2);
		if (scaledMar > rain) {
			warnings.push(
				`WR2012 check: the scaled reference MAR (${fmt(scaledMar)} Mm³/a) is more than the rain that falls on the modelled catchment (${fmt(rain)} Mm³/a). ` +
					'Check the reference numbers and the catchment areas'
			);
		}
	}

	return {
		quaternary: ref.quaternary,
		source: ref.source,
		referencePeriod: { start: ref.periodStart, end: ref.periodEnd },
		compared: 'natural_flow',
		scaling: {
			rule: scale.rule,
			requested: ws.scaling,
			factor: scale.factor,
			areaFactor: scale.areaFactor,
			rainFactor: scale.rainFactor,
			modelAreaKm2: areaKm2,
			referenceAreaKm2: ref.areaKm2,
			modelMapMm,
			referenceMapMm: ref.mapMm
		},
		referenceMarMm3: ref.marMm3,
		scaledMarMm3: scaledMar,
		overlap,
		whole: { days, simulatedMarMm3: wholeMar, ratio: ratio(wholeMar) },
		monthlyBasis: basis,
		months,
		lowFlowMonths,
		lowFlowSource,
		lowFlowRatio: lowRef > 0 ? lowSim / lowRef : null,
		patternCorrelation: pearson(simMonthly, refMonthly),
		flag: { level, basis, deviationPct, thresholds: ws.flags, text }
	};
}

/** "Jan, Feb, Mar" for calendar months. */
export const monthNames = (months: readonly number[]) => months.map((m) => MONTH_NAMES[m - 1] ?? String(m)).join(', ');

// ---------------------------------------------------------------------------
// Calibration penalty
// ---------------------------------------------------------------------------

/**
 * The soft MAR penalty automatic calibration adds to its loss when
 * settings.wr2012.calibrationPenalty is on, on the simulated *natural* flow
 * of the first `days` run days, over the complete water years inside the
 * reference period (the whole span when there are none):
 * - a single target (no band): weight × |ln(simulated MAR ÷ scaled WR2012
 *   MAR)|, symmetric in wetter and drier;
 * - a band (marLowMm3 / marHighMm3 both set): 0 inside [marLowMm3,
 *   marHighMm3], else weight × |ln(simulated MAR ÷ the nearer bound)|.
 */
export interface Wr2012Penalty {
	weight: number;
	/**
	 * The MAR the simulated MAR is pulled towards, Mm³/a: the scaled WR2012
	 * MAR for a single target, or the geometric mean of the band (the point
	 * equally far in log space from both bounds) when one is set.
	 */
	targetMarMm3: number;
	/** The band bounds (already at the modelled catchment's scale), when the penalty uses one; null for a single target. */
	marLowMm3: number | null;
	marHighMm3: number | null;
	basis: 'overlap' | 'whole';
	/** Simulated MAR (Mm³/a) of a natural-flow series (m³/day, at least `days` long). */
	simulatedMar(natural: ArrayLike<number>): number;
	/** The penalty for a natural-flow series. */
	penalty(natural: ArrayLike<number>): number;
}

export function wr2012Penalty(
	ws: Wr2012Settings,
	startDate: string,
	days: number,
	areaKm2: number,
	rainMm: ArrayLike<number | null> | null
): Wr2012Penalty | null {
	const ref = ws.reference;
	if (!ws.calibrationPenalty.enabled || !ref || !(areaKm2 > 0) || days === 0) return null;
	const ov = overlapDays(startDate, days, ref.periodStart, ref.periodEnd);
	const scale = wr2012Scale(ws, ref, areaKm2, meanAnnualRain(rainMm, ov?.idx ?? null, days));
	const { marLowMm3, marHighMm3 } = ws.calibrationPenalty;
	const hasBand = isNum(marLowMm3) && isNum(marHighMm3) && marLowMm3 >= 0 && marHighMm3 >= marLowMm3;
	const lo = hasBand ? marLowMm3 : null;
	const hi = hasBand ? marHighMm3 : null;
	const single = ref.marMm3 * scale.factor;
	// The band is already scaled to the modelled catchment (unlike marMm3, which is the
	// quaternary's own figure): two independently published catchment-specific estimates,
	// not one study figure to area-scale.
	const target = hasBand ? Math.sqrt(lo! * hi!) : single;
	if (!(target > 0)) return null;
	const weight = ws.calibrationPenalty.weight;
	const simulatedMar = (natural: ArrayLike<number>) => {
		let s = 0;
		if (ov) {
			for (const t of ov.idx) s += natural[t]!;
			return s / 1e6 / ov.years.length;
		}
		for (let t = 0; t < days; t++) s += natural[t]!;
		return m3DayToMm3(s / days, DAYS_PER_YEAR);
	};
	const penaltyOf = (mar: number) => {
		if (hasBand) {
			if (mar >= lo! && mar <= hi!) return 0;
			const nearest = mar < lo! ? lo! : hi!;
			return weight * Math.abs(Math.log(Math.max(mar, 1e-9) / nearest));
		}
		return weight * Math.abs(Math.log(Math.max(mar, 1e-9) / target));
	};
	return {
		weight,
		targetMarMm3: target,
		marLowMm3: lo,
		marHighMm3: hi,
		basis: ov ? 'overlap' : 'whole',
		simulatedMar,
		penalty: (natural) => penaltyOf(simulatedMar(natural))
	};
}

/** Daily rain the run uses (catchment, else CHIRPS, else forecast; null = none that day), or null without any rainfall series. */
export function runRain(aligned: (k: 'rain_catchment_mm' | 'rain_chirps_mm' | 'rain_forecast_mm') => (number | null)[], has: boolean, days: number): (number | null)[] | null {
	if (!has) return null;
	const c = aligned('rain_catchment_mm');
	const ch = aligned('rain_chirps_mm');
	const f = aligned('rain_forecast_mm');
	return Array.from({ length: days }, (_, t) => c[t] ?? ch[t] ?? f[t] ?? null);
}
