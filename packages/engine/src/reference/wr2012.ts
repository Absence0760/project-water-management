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
import { regroup } from '../format';
import { daysPerMonth, monthOfEpochDay, toEpochDay, waterYearIndex } from '../calendar';
import {
	m3DayToMm3,
	rainVolumeMm3,
	type Wr2012Flags,
	type Wr2012Reference,
	type Wr2012Scaling,
	type Wr2012Settings
} from './wr2012Settings';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

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
	return s === '-0' ? '0' : regroup(s);
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
