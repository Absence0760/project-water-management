// Run comparison: what changed between two runs, in results (compareRuns) and
// in the inputs that produced them (diffInputs). Pure — the backend calls it
// for GET /compare/runs and the frontend could call it for a live preview.
//
// Runs may come from two different projects (e.g. project D copied from C and
// then modified). Copies get fresh node/crop/transfer ids, so everything is
// matched by id first (same project, catches renames) and then by name
// (across copies). See docs/run-comparison.md.
import { fromEpochDay, toEpochDay } from './calendar';
import type { Wr2012Reference, Wr2012Settings } from './reference/wr2012';
import { exclusionKey, exclusionLabel, type CalibrationExclusion, type FitRecord } from './calibrate/provenance';
import { OBJECTIVE_LABELS, type ObjectiveId } from './calibrate/objective';
import {
	defaultProjectSettings,
	type CalibrationStats,
	type CropDef,
	type FarmSummary,
	type NetworkNode,
	type ProjectModel,
	type ProjectSettings,
	type RunSummary,
	type Transfer
} from './project';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What a run stores about its inputs (model_run.inputs): the merged settings,
 * the whole model document, and the start/length of each driving series plus
 * a content hash of its values (the values themselves are not kept).
 */
export interface RunInputsSnapshot {
	settings: Partial<ProjectSettings> & Record<string, unknown>;
	model: ProjectModel;
	series: Partial<Record<string, RunSeriesSnapshot>>;
}

export interface RunSeriesSnapshot {
	startDate: string;
	length: number;
	/** Hash of the values (backend: SHA-256 hex of their JSON). Absent on runs stored before it existed. */
	valuesSha256?: string;
}

/** The parts of a run compareRuns needs. */
export interface ComparableRun {
	label?: string | null;
	engineVersion: string;
	startDate: string;
	endDate: string;
	summary: RunSummary;
}

/** One metric in both runs. delta = b − a; null when either side is missing. */
export interface MetricDelta {
	a: number | null;
	b: number | null;
	delta: number | null;
}

export interface FarmDelta {
	/** Name in run B (the newer/changed side). */
	name: string;
	/** Name in run A when it differs (renamed farm matched by id). */
	nameA: string | null;
	nodeIdA: string;
	nodeIdB: string;
	demandM3Day: MetricDelta;
	suppliedM3Day: MetricDelta;
	deficitM3Day: MetricDelta;
	/** 0–1; delta is in fraction points (0.05 = +5 percentage points). */
	fractionSupplied: MetricDelta;
	ewrShortfallM3Day: MetricDelta;
	daysEwrNotMet: MetricDelta;
}

export interface RunComparison {
	/** Both runs cover the same dates; averages over different periods compare poorly. */
	samePeriod: boolean;
	engineVersionChanged: boolean;
	farms: FarmDelta[];
	/** Farms with results in only one of the runs. */
	onlyInA: FarmSummary[];
	onlyInB: FarmSummary[];
	/** Sums over the farms present in each run (fractionSupplied = supplied / demand). */
	totals: {
		demandM3Day: MetricDelta;
		suppliedM3Day: MetricDelta;
		deficitM3Day: MetricDelta;
		fractionSupplied: MetricDelta;
		farmsBelowTarget: MetricDelta;
	};
	catchment: {
		meanNaturalFlowM3Day: MetricDelta;
		meanSimulatedOutflowM3Day: MetricDelta;
		ewrDaysNotMet: MetricDelta;
		ewrFractionDaysNotMet: MetricDelta;
		/** Natural flow ÷ rain over the run (absent on runs saved before engine 0.4.0). */
		runoffCoefficient: MetricDelta;
	};
	/**
	 * The outlet EWR test on each run's observed record (engine ≥ 0.5.3):
	 * null when neither run has one. Each run's full tables stay in its
	 * summary (summary.catchment.ewrAgreement).
	 */
	ewrAgreement: {
		days: MetricDelta;
		hitRate: MetricDelta;
		falseAlarmRatio: MetricDelta;
		frequencyBias: MetricDelta;
		modelFractionBelow: MetricDelta;
		observedFractionBelow: MetricDelta;
	} | null;
	/** null when neither run has calibration statistics (whole-record, in-sample scores). */
	calibration: {
		days: MetricDelta;
		nse: MetricDelta;
		/** Kling–Gupta efficiency (absent on runs saved before engine 0.3.0). */
		kge: MetricDelta;
		pbias: MetricDelta;
		rmseM3s: MetricDelta;
		meanObservedM3s: MetricDelta;
		meanSimulatedM3s: MetricDelta;
	} | null;
	/** The WR2012 check (engine ≥ 0.6.0); null when neither run has one. Ratios are simulated natural ÷ scaled WR2012. */
	wr2012: {
		marRatioOverlap: MetricDelta;
		marRatioWhole: MetricDelta;
		lowFlowRatio: MetricDelta;
		patternCorrelation: MetricDelta;
	} | null;
}

export type InputChangeArea = 'settings' | 'network' | 'crops' | 'transfers' | 'series';

export interface InputChange {
	area: InputChangeArea;
	kind: 'added' | 'removed' | 'changed';
	/** What the change is about: a node, crop, transfer, series or setting name. */
	subject: string;
	/** Complete human-readable sentence, e.g. "Rooikloof: dam capacity 600,000 → 720,000 m³". */
	text: string;
}

/** Share of demand a farm must get to not be flagged (matches the runs view). */
export const SUPPLY_TARGET = 0.95;

// ---------------------------------------------------------------------------
// compareRuns
// ---------------------------------------------------------------------------

function num(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function metricDelta(a: unknown, b: unknown): MetricDelta {
	const x = num(a);
	const y = num(b);
	return { a: x, b: y, delta: x !== null && y !== null ? y - x : null };
}

const nameKey = (s: string) => s.trim().toLowerCase();

/**
 * Pair items from two lists: first by identical id, then by name (trimmed,
 * case-insensitive), in order of appearance. Returns the pairs and the
 * leftovers on each side.
 */
export function matchByIdThenName<T>(
	a: readonly T[],
	b: readonly T[],
	id: (x: T) => string,
	name: (x: T) => string
): { pairs: [T, T][]; onlyA: T[]; onlyB: T[] } {
	const usedA = new Set<number>();
	const usedB = new Set<number>();
	const pairs: [number, number][] = [];
	const bById = new Map<string, number>();
	b.forEach((x, j) => bById.set(id(x), j));
	a.forEach((x, i) => {
		const j = bById.get(id(x));
		if (j !== undefined && !usedB.has(j)) {
			pairs.push([i, j]);
			usedA.add(i);
			usedB.add(j);
		}
	});
	const bByName = new Map<string, number[]>();
	b.forEach((x, j) => {
		if (usedB.has(j)) return;
		const k = nameKey(name(x));
		bByName.set(k, [...(bByName.get(k) ?? []), j]);
	});
	a.forEach((x, i) => {
		if (usedA.has(i)) return;
		const queue = bByName.get(nameKey(name(x)));
		const j = queue?.shift();
		if (j !== undefined) {
			pairs.push([i, j]);
			usedA.add(i);
			usedB.add(j);
		}
	});
	// Keep B's order for the pairs — that's the order the user sees the model in now.
	pairs.sort((p, q) => p[1] - q[1]);
	return {
		pairs: pairs.map(([i, j]) => [a[i]!, b[j]!]),
		onlyA: a.filter((_, i) => !usedA.has(i)),
		onlyB: b.filter((_, j) => !usedB.has(j))
	};
}

function farmTotals(farms: FarmSummary[]) {
	const demand = farms.reduce((s, f) => s + f.avgDemandM3Day, 0);
	const supplied = farms.reduce((s, f) => s + f.avgSuppliedM3Day, 0);
	return {
		demand,
		supplied,
		deficit: farms.reduce((s, f) => s + f.avgDeficitM3Day, 0),
		fraction: demand > 0 ? supplied / demand : null,
		below: farms.filter((f) => f.fractionSupplied < SUPPLY_TARGET).length
	};
}

/**
 * Compare the results of run A (the baseline) with run B (the changed one).
 * Every delta is B − A.
 */
export function compareRuns(a: ComparableRun, b: ComparableRun): RunComparison {
	const fa = a.summary.farms ?? [];
	const fb = b.summary.farms ?? [];
	const m = matchByIdThenName(fa, fb, (f) => f.nodeId, (f) => f.name);
	const farms: FarmDelta[] = m.pairs.map(([x, y]) => ({
		name: y.name,
		nameA: x.name !== y.name ? x.name : null,
		nodeIdA: x.nodeId,
		nodeIdB: y.nodeId,
		demandM3Day: metricDelta(x.avgDemandM3Day, y.avgDemandM3Day),
		suppliedM3Day: metricDelta(x.avgSuppliedM3Day, y.avgSuppliedM3Day),
		deficitM3Day: metricDelta(x.avgDeficitM3Day, y.avgDeficitM3Day),
		fractionSupplied: metricDelta(x.fractionSupplied, y.fractionSupplied),
		ewrShortfallM3Day: metricDelta(x.avgEwrShortfallM3Day, y.avgEwrShortfallM3Day),
		daysEwrNotMet: metricDelta(x.daysEwrNotMet, y.daysEwrNotMet)
	}));

	const ta = farmTotals(fa);
	const tb = farmTotals(fb);
	const ca = a.summary.catchment;
	const cb = b.summary.catchment;
	const cal = (s: CalibrationStats | null | undefined) => (s && s.days > 0 ? s : null);
	const ea = ca?.ewrAgreement && ca.ewrAgreement.days > 0 ? ca.ewrAgreement.overall : null;
	const eb = cb?.ewrAgreement && cb.ewrAgreement.days > 0 ? cb.ewrAgreement.overall : null;
	const ka = cal(a.summary.calibration);
	const kb = cal(b.summary.calibration);
	const wa = a.summary.wr2012;
	const wb = b.summary.wr2012;

	return {
		samePeriod: a.startDate === b.startDate && a.endDate === b.endDate,
		engineVersionChanged: a.engineVersion !== b.engineVersion,
		farms,
		onlyInA: m.onlyA,
		onlyInB: m.onlyB,
		totals: {
			demandM3Day: metricDelta(ta.demand, tb.demand),
			suppliedM3Day: metricDelta(ta.supplied, tb.supplied),
			deficitM3Day: metricDelta(ta.deficit, tb.deficit),
			fractionSupplied: metricDelta(ta.fraction, tb.fraction),
			farmsBelowTarget: metricDelta(ta.below, tb.below)
		},
		catchment: {
			meanNaturalFlowM3Day: metricDelta(ca?.meanNaturalFlowM3Day, cb?.meanNaturalFlowM3Day),
			meanSimulatedOutflowM3Day: metricDelta(ca?.meanSimulatedOutflowM3Day, cb?.meanSimulatedOutflowM3Day),
			ewrDaysNotMet: metricDelta(ca?.ewrDaysNotMet, cb?.ewrDaysNotMet),
			ewrFractionDaysNotMet: metricDelta(ca?.ewrFractionDaysNotMet, cb?.ewrFractionDaysNotMet),
			runoffCoefficient: metricDelta(ca?.runoffCoefficient, cb?.runoffCoefficient)
		},
		ewrAgreement:
			ea || eb
				? {
						days: metricDelta(ea?.days, eb?.days),
						hitRate: metricDelta(ea?.hitRate, eb?.hitRate),
						falseAlarmRatio: metricDelta(ea?.falseAlarmRatio, eb?.falseAlarmRatio),
						frequencyBias: metricDelta(ea?.frequencyBias, eb?.frequencyBias),
						modelFractionBelow: metricDelta(ea?.modelFractionBelow, eb?.modelFractionBelow),
						observedFractionBelow: metricDelta(ea?.observedFractionBelow, eb?.observedFractionBelow)
					}
				: null,
		calibration:
			ka || kb
				? {
						days: metricDelta(ka?.days, kb?.days),
						nse: metricDelta(ka?.nse, kb?.nse),
						kge: metricDelta(ka?.kge, kb?.kge),
						pbias: metricDelta(ka?.pbias, kb?.pbias),
						rmseM3s: metricDelta(ka?.rmseM3s, kb?.rmseM3s),
						meanObservedM3s: metricDelta(ka?.meanObservedM3s, kb?.meanObservedM3s),
						meanSimulatedM3s: metricDelta(ka?.meanSimulatedM3s, kb?.meanSimulatedM3s)
					}
				: null,
		wr2012:
			wa || wb
				? {
						marRatioOverlap: metricDelta(wa?.overlap?.ratio, wb?.overlap?.ratio),
						marRatioWhole: metricDelta(wa?.whole.ratio, wb?.whole.ratio),
						lowFlowRatio: metricDelta(wa?.lowFlowRatio, wb?.lowFlowRatio),
						patternCorrelation: metricDelta(wa?.patternCorrelation, wb?.patternCorrelation)
					}
				: null
	};
}

// ---------------------------------------------------------------------------
// diffInputs
// ---------------------------------------------------------------------------

const WY_MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
const CAL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const nf = new Map<number, Intl.NumberFormat>();
/** Comma-grouped, up to `digits` decimals (trailing zeros dropped). */
export function fmtValue(v: unknown, digits = 3): string {
	if (v === null || v === undefined) return 'none';
	if (typeof v !== 'number') return String(v);
	if (!Number.isFinite(v)) return '–';
	let f = nf.get(digits);
	if (!f) {
		f = new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, useGrouping: true });
		nf.set(digits, f);
	}
	const s = f.format(v);
	return s === '-0' ? '0' : s;
}

const pct = (v: unknown) => (typeof v === 'number' ? `${fmtValue(v * 100, 2)}%` : fmtValue(v));

/** Calendar months 1–12 → "Oct–Mar" style (water-year order). */
export function describeCalendarMonths(months: readonly number[]): string {
	const order = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];
	const set = new Set(months);
	if (set.size === 0) return 'no months';
	if (order.every((m) => set.has(m))) return 'all year';
	const runs: number[][] = [];
	for (const m of order) {
		if (!set.has(m)) continue;
		const last = runs[runs.length - 1];
		if (last && order.indexOf(last[last.length - 1]!) === order.indexOf(m) - 1) last.push(m);
		else runs.push([m]);
	}
	const name = (m: number) => CAL_MONTHS[m - 1] ?? String(m);
	return runs.map((r) => (r.length > 2 ? `${name(r[0]!)}–${name(r[r.length - 1]!)}` : r.map(name).join(', '))).join(', ');
}

const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
/** A month list as a sorted set: order and repeats don't change which months apply. */
const monthSet = (v: unknown) => [...new Set(Array.isArray(v) ? v : [])].sort((p, q) => Number(p) - Number(q));

/**
 * Describe a changed 12-value water-year table: the months that changed with
 * their values when there are a few, otherwise how many.
 */
function monthlyChange(a: unknown, b: unknown, unit: string): string | null {
	const xa = Array.isArray(a) ? a : [];
	const xb = Array.isArray(b) ? b : [];
	const changed: string[] = [];
	for (let i = 0; i < Math.max(12, xa.length, xb.length); i++) {
		if (!same(xa[i], xb[i])) changed.push(`${WY_MONTHS[i] ?? `#${i + 1}`} ${fmtValue(xa[i])} → ${fmtValue(xb[i])}`);
	}
	if (changed.length === 0) return null;
	if (changed.length <= 3) return changed.join(', ') + (unit ? ` ${unit}` : '');
	return `changed in ${changed.length} months`;
}

function arrayChange(a: unknown, b: unknown): string {
	const xa = Array.isArray(a) ? a : [];
	const xb = Array.isArray(b) ? b : [];
	let n = 0;
	for (let i = 0; i < Math.max(xa.length, xb.length); i++) if (!same(xa[i], xb[i])) n++;
	const len = xa.length !== xb.length ? ` (${xa.length} → ${xb.length} values)` : '';
	return `${n} value${n === 1 ? '' : 's'} changed${len}`;
}

type Fmt = (v: unknown) => string;
const withUnit = (unit: string, digits = 3): Fmt => (v) => (v === null || v === undefined ? 'none' : `${fmtValue(v, digits)} ${unit}`);
const plain: Fmt = (v) => fmtValue(v);

interface ScalarField {
	label: string;
	fmt: Fmt;
}

const SETTINGS_FIELDS: Record<string, ScalarField> = {
	februaryDays: { label: 'Days in February', fmt: plain },
	effectiveRainFraction: { label: 'Effective rain fraction', fmt: plain },
	flowShareMethod: { label: 'Flow-share method', fmt: plain },
	runoffModel: { label: 'Runoff model', fmt: (v) => (v === 'legacy' ? 'legacy (b023 recession)' : v === 'gr4j' ? 'GR4J' : String(v)) },
	chirpsBiasCorrection: {
		label: 'CHIRPS bias correction',
		fmt: (v) => (v === 'monthly' ? 'monthly factors' : v === 'none' ? 'raw CHIRPS' : String(v))
	},
	simulationStart: { label: 'Simulation start', fmt: (v) => (v ? String(v) : 'start of data') },
	simulationEnd: { label: 'Simulation end', fmt: (v) => (v ? String(v) : 'end of data') },
	reportStart: { label: 'Curtailment report start', fmt: (v) => (v ? String(v) : 'start of run') },
	reportEnd: { label: 'Curtailment report end', fmt: (v) => (v ? String(v) : 'end of run') },
	calibrationStart: { label: 'Calibration window start', fmt: (v) => (v ? String(v) : 'start of record') },
	calibrationEnd: { label: 'Calibration window end', fmt: (v) => (v ? String(v) : 'end of record') },
	calibrationFlowKind: { label: 'Calibration flow series', fmt: (v) => (v ? (SERIES_LABELS[String(v)] ?? String(v)) : 'default (observed, else logger)') }
};
const DATA_QUALITY_FIELDS: Record<string, ScalarField> = {
	agreementMinRatio: { label: 'gauge/logger lowest ratio', fmt: pct },
	agreementMaxRatio: { label: 'gauge/logger highest ratio', fmt: pct },
	agreementMinDays: { label: 'gauge/logger minimum shared days', fmt: withUnit('days') }
};
const SETTINGS_MONTHLY: Record<string, { label: string; unit: string }> = {
	apanMm: { label: 'A-pan evaporation', unit: 'mm' },
	ewrPragmaticM3PerDay: { label: 'Pragmatic EWR', unit: 'm³/day' },
	panCoefficient: { label: 'Pan coefficient', unit: '' }
};
const GR4J_FIELDS: Record<string, ScalarField> = {
	x1: { label: 'production store X1', fmt: withUnit('mm') },
	x2: { label: 'groundwater exchange X2', fmt: withUnit('mm/day') },
	x3: { label: 'routing store X3', fmt: withUnit('mm') },
	x4: { label: 'unit hydrograph time base X4', fmt: withUnit('days') },
	warmupDays: { label: 'warm-up', fmt: withUnit('days') }
};
const CALIBRATION_FIELDS: Record<string, ScalarField> = {
	a: { label: 'peak flow coefficient a', fmt: plain },
	b: { label: 'peak flow exponent b', fmt: plain },
	rainThresholdMm: { label: 'rain threshold', fmt: withUnit('mm') },
	summerFactor: { label: 'summer factor', fmt: plain },
	winterFactor: { label: 'winter factor', fmt: plain },
	baseFlowInitial: { label: 'initial base flow', fmt: withUnit('m³/day') },
	catchmentAreaKm2: { label: 'catchment area', fmt: (v) => (v === null || v === undefined ? 'sum of farm areas' : `${fmtValue(v)} km²`) },
	baseResetRatio: { label: 'base-flow reset ratio', fmt: plain },
	winterTodayRainMm: { label: 'winter switch (rain today)', fmt: withUnit('mm') },
	winterNextDayRainMm: { label: 'winter switch (rain yesterday)', fmt: withUnit('mm') },
	shiftPeakIndexLo: { label: 'recession start index (large events)', fmt: plain },
	shiftPeakIndexHi: { label: 'recession start index (small events)', fmt: plain },
	amplitudeM3Day: { label: 'amplitude', fmt: withUnit('m³/day') },
	recessionDaysMax: { label: 'max recession days', fmt: withUnit('days') }
};
const CALIBRATION_ARRAYS: Record<string, string> = {
	recessionFactors: 'recession factors',
	recessionCurveM3Day: 'recession curve'
};

/**
 * Settings as the engine sees them: stored values merged over the defaults.
 * A run saved without a runoff model predates the setting (engine 0.5.0), so
 * it ran legacy, whatever today's default is.
 */
function effectiveSettings(raw: RunInputsSnapshot['settings'] | undefined): Record<string, unknown> {
	const d = defaultProjectSettings() as unknown as Record<string, unknown>;
	const r = (raw ?? {}) as Record<string, unknown>;
	return {
		...d,
		...r,
		runoffModel: r.runoffModel ?? 'legacy',
		calibration: { ...(d.calibration as object), ...((r.calibration as object | undefined) ?? {}) },
		hiLoSplit: { ...(d.hiLoSplit as object), ...((r.hiLoSplit as object | undefined) ?? {}) },
		dataQuality: { ...(d.dataQuality as object), ...((r.dataQuality as object | undefined) ?? {}) },
		gr4j: { ...(d.gr4j as object), ...((r.gr4j as object | undefined) ?? {}) },
		wr2012: { ...(d.wr2012 as object), ...((r.wr2012 as object | undefined) ?? {}) }
	};
}

function diffSettings(ra: RunInputsSnapshot['settings'] | undefined, rb: RunInputsSnapshot['settings'] | undefined): InputChange[] {
	const a = effectiveSettings(ra);
	const b = effectiveSettings(rb);
	const out: InputChange[] = [];
	const push = (subject: string, text: string) => out.push({ area: 'settings', kind: 'changed', subject, text });

	for (const [k, f] of Object.entries(SETTINGS_FIELDS)) {
		if (!same(a[k], b[k])) push(f.label, `${f.label}: ${f.fmt(a[k])} → ${f.fmt(b[k])}`);
	}
	for (const [k, f] of Object.entries(SETTINGS_MONTHLY)) {
		const c = monthlyChange(a[k], b[k], f.unit);
		if (c) push(f.label, `${f.label}: ${c}`);
	}
	const ha = a.hiLoSplit as Record<string, unknown>;
	const hb = b.hiLoSplit as Record<string, unknown>;
	if (!same(ha, hb)) push('Hi/lo MAP split', `Hi/lo MAP split: ${fmtValue(ha.hi)}/${fmtValue(ha.lo)} → ${fmtValue(hb.hi)}/${fmtValue(hb.lo)}`);

	const qa = a.dataQuality as Record<string, unknown>;
	const qb = b.dataQuality as Record<string, unknown>;
	for (const [k, f] of Object.entries(DATA_QUALITY_FIELDS)) {
		if (!same(qa[k], qb[k])) push(`Data quality ${f.label}`, `Data quality ${f.label}: ${f.fmt(qa[k])} → ${f.fmt(qb[k])}`);
	}

	const ga = a.gr4j as Record<string, unknown>;
	const gb = b.gr4j as Record<string, unknown>;
	for (const [k, f] of Object.entries(GR4J_FIELDS)) {
		if (!same(ga[k], gb[k])) push(`GR4J ${f.label}`, `GR4J ${f.label}: ${f.fmt(ga[k])} → ${f.fmt(gb[k])}`);
	}

	const ka = a.calibration as Record<string, unknown>;
	const kb = b.calibration as Record<string, unknown>;
	for (const [k, f] of Object.entries(CALIBRATION_FIELDS)) {
		if (!same(ka[k], kb[k])) push(`Calibration ${f.label}`, `Calibration ${f.label}: ${f.fmt(ka[k])} → ${f.fmt(kb[k])}`);
	}
	if (!same(monthSet(ka.summerMonths), monthSet(kb.summerMonths))) {
		push(
			'Calibration summer months',
			`Calibration summer months: ${describeCalendarMonths((ka.summerMonths as number[]) ?? [])} → ${describeCalendarMonths((kb.summerMonths as number[]) ?? [])}`
		);
	}
	for (const [k, label] of Object.entries(CALIBRATION_ARRAYS)) {
		if (!same(ka[k], kb[k])) push(`Calibration ${label}`, `Calibration ${label}: ${arrayChange(ka[k], kb[k])}`);
	}
	out.push(...diffWr2012(a.wr2012 as Partial<Wr2012Settings>, b.wr2012 as Partial<Wr2012Settings>));
	out.push(...diffExclusions(a.calibrationExclusions, b.calibrationExclusions));
	out.push(...diffFitRecord(a.fitRecord, b.fitRecord));
	// Anything we don't have a label for (older or newer engine keys) still shows up.
	const known = new Set([
		...Object.keys(SETTINGS_FIELDS),
		...Object.keys(SETTINGS_MONTHLY),
		'hiLoSplit',
		'calibration',
		'dataQuality',
		'gr4j',
		'wr2012',
		'calibrationExclusions',
		'fitRecord'
	]);
	for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
		if (!known.has(k) && !same(a[k], b[k])) push(k, `Setting "${k}" changed`);
	}
	const knownCal = new Set([...Object.keys(CALIBRATION_FIELDS), ...Object.keys(CALIBRATION_ARRAYS), 'summerMonths']);
	for (const k of new Set([...Object.keys(ka), ...Object.keys(kb)])) {
		if (!knownCal.has(k) && !same(ka[k], kb[k])) push(`calibration.${k}`, `Calibration setting "${k}" changed`);
	}
	return out;
}

const WR2012_REFERENCE_FIELDS: Record<string, ScalarField> = {
	quaternary: { label: 'quaternary', fmt: (v) => (v ? `"${String(v)}"` : 'none') },
	areaKm2: { label: 'quaternary area', fmt: withUnit('km²') },
	marMm3: { label: 'naturalised MAR', fmt: withUnit('Mm³/a') },
	mapMm: { label: 'quaternary MAP', fmt: (v) => (v === null || v === undefined ? 'not entered' : `${fmtValue(v)} mm`) },
	periodStart: { label: 'reference period start', fmt: (v) => fmtWaterYear(v) },
	periodEnd: { label: 'reference period end', fmt: (v) => fmtWaterYear(v) },
	source: { label: 'source', fmt: (v) => (v ? `"${String(v)}"` : 'none') }
};
const WR2012_FLAG_FIELDS: Record<string, string> = {
	notePct: 'note threshold',
	queryPct: 'query threshold',
	queryWetterPct: 'query-if-wetter threshold',
	unusablePct: 'not-usable threshold'
};
const SCALING_LABEL: Record<string, string> = { area: 'area ratio', areaRain: 'area and rainfall ratio' };

/** A water year labelled by the calendar year it starts in: 1990 → "1990/91". */
function fmtWaterYear(v: unknown): string {
	return typeof v === 'number' && Number.isInteger(v) ? `${v}/${String((v + 1) % 100).padStart(2, '0')}` : fmtValue(v);
}

/** Every WR2012 input: the reference (each field and month), scaling, dry-season months, thresholds and the calibration penalty. */
function diffWr2012(a: Partial<Wr2012Settings> | undefined, b: Partial<Wr2012Settings> | undefined): InputChange[] {
	const out: InputChange[] = [];
	const push = (kind: InputChange['kind'], subject: string, text: string) => out.push({ area: 'settings', kind, subject, text });
	const ra = a?.reference ?? null;
	const rb = b?.reference ?? null;
	const describe = (r: Wr2012Reference) => `${r.quaternary}, MAR ${fmtValue(r.marMm3)} Mm³/a over ${fmtValue(r.areaKm2)} km², ${fmtWaterYear(r.periodStart)} – ${fmtWaterYear(r.periodEnd)}`;
	if (!ra && rb) push('added', 'WR2012 reference', `WR2012 reference added (${describe(rb)})`);
	else if (ra && !rb) push('removed', 'WR2012 reference', `WR2012 reference removed (was ${describe(ra)})`);
	else if (ra && rb) {
		const x = ra as unknown as Record<string, unknown>;
		const y = rb as unknown as Record<string, unknown>;
		for (const [k, f] of Object.entries(WR2012_REFERENCE_FIELDS)) {
			if (!same(x[k] ?? null, y[k] ?? null)) push('changed', `WR2012 ${f.label}`, `WR2012 ${f.label}: ${f.fmt(x[k])} → ${f.fmt(y[k])}`);
		}
		const c = monthlyChange(ra.monthlyMm3, rb.monthlyMm3, 'Mm³');
		if (c) push('changed', 'WR2012 monthly means', `WR2012 monthly means: ${c}`);
	}
	if (!same(a?.scaling, b?.scaling)) {
		const f = (v: unknown) => SCALING_LABEL[String(v)] ?? String(v);
		push('changed', 'WR2012 scaling', `WR2012 scaling: ${f(a?.scaling)} → ${f(b?.scaling)}`);
	}
	if (!same(a?.lowFlowMonths ? monthSet(a.lowFlowMonths) : null, b?.lowFlowMonths ? monthSet(b.lowFlowMonths) : null)) {
		const f = (v: number[] | null | undefined) => (v?.length ? describeCalendarMonths(v) : 'from the run');
		push('changed', 'WR2012 dry-season months', `WR2012 dry-season months: ${f(a?.lowFlowMonths)} → ${f(b?.lowFlowMonths)}`);
	}
	const fa = (a?.flags ?? {}) as Record<string, unknown>;
	const fb = (b?.flags ?? {}) as Record<string, unknown>;
	for (const [k, label] of Object.entries(WR2012_FLAG_FIELDS)) {
		if (!same(fa[k], fb[k])) push('changed', `WR2012 ${label}`, `WR2012 ${label}: ${withUnit('%')(fa[k])} → ${withUnit('%')(fb[k])}`);
	}
	const pa = a?.calibrationPenalty;
	const pb = b?.calibrationPenalty;
	if (!same(pa?.enabled, pb?.enabled)) {
		push('changed', 'WR2012 calibration penalty', `WR2012 calibration penalty: ${pa?.enabled ? 'on' : 'off'} → ${pb?.enabled ? 'on' : 'off'}`);
	}
	if (!same(pa?.weight, pb?.weight)) {
		push('changed', 'WR2012 calibration penalty weight', `WR2012 calibration penalty weight: ${fmtValue(pa?.weight)} → ${fmtValue(pb?.weight)}`);
	}
	const band = (p: typeof pa) => (p?.marLowMm3 != null && p?.marHighMm3 != null ? `${fmtValue(p.marLowMm3)} – ${fmtValue(p.marHighMm3)} Mm³/a` : 'none (single target)');
	if (!same(pa?.marLowMm3 ?? null, pb?.marLowMm3 ?? null) || !same(pa?.marHighMm3 ?? null, pb?.marHighMm3 ?? null)) {
		push('changed', 'WR2012 calibration penalty MAR band', `WR2012 calibration penalty MAR band: ${band(pa)} → ${band(pb)}`);
	}
	return out;
}

/** Calibration exclusions added, removed, or given another reason (matched by their period). */
function diffExclusions(ra: unknown, rb: unknown): InputChange[] {
	const list = (v: unknown) => (Array.isArray(v) ? (v as CalibrationExclusion[]).filter((x) => x && typeof x === 'object') : []);
	const a = new Map(list(ra).map((x) => [exclusionKey(x), x]));
	const b = new Map(list(rb).map((x) => [exclusionKey(x), x]));
	const out: InputChange[] = [];
	for (const [k, x] of a) {
		if (!b.has(k)) out.push({ area: 'settings', kind: 'removed', subject: `Calibration exclusion ${exclusionLabel(x)}`, text: `Calibration exclusion ${exclusionLabel(x)} removed (was: “${x.reason}”)` });
	}
	for (const [k, y] of b) {
		const x = a.get(k);
		const subject = `Calibration exclusion ${exclusionLabel(y)}`;
		if (!x) out.push({ area: 'settings', kind: 'added', subject, text: `${subject} added: “${y.reason}”` });
		else if (x.reason !== y.reason) out.push({ area: 'settings', kind: 'changed', subject, text: `${subject}: reason “${x.reason}” → “${y.reason}”` });
	}
	return out;
}

const MODEL_NAME: Record<string, string> = { gr4j: 'GR4J', legacy: 'legacy' };

/** "GR4J fit of 2026-09-24 14:05 UTC (KGE′, seed 1)". */
export function describeFitRecord(r: Pick<FitRecord, 'model' | 'fittedAt' | 'objective' | 'seed'>): string {
	const when = typeof r.fittedAt === 'string' ? r.fittedAt.replace('T', ' ').replace(/:\d{2}(\.\d+)?Z$/, ' UTC') : 'unknown time';
	const objective = (OBJECTIVE_LABELS[r.objective as ObjectiveId] ?? String(r.objective)).replace(/ \(.*\)$/, '');
	return `${MODEL_NAME[r.model] ?? String(r.model)} fit of ${when} (${objective}, seed ${r.seed})`;
}

/** The fit record the parameters came from: set, cleared, replaced, or edited since. */
function diffFitRecord(ra: unknown, rb: unknown): InputChange[] {
	const rec = (v: unknown) => (v && typeof v === 'object' ? (v as FitRecord) : null);
	const a = rec(ra);
	const b = rec(rb);
	const subject = 'Fit record';
	if (!a && !b) return [];
	if (!a) return [{ area: 'settings', kind: 'added', subject, text: `Parameters now from a ${describeFitRecord(b!)}` }];
	if (!b) return [{ area: 'settings', kind: 'removed', subject, text: `Fit record removed (was a ${describeFitRecord(a)})` }];
	if (a.fittedAt !== b.fittedAt || a.model !== b.model || a.seed !== b.seed) {
		return [{ area: 'settings', kind: 'changed', subject, text: `Fit record: ${describeFitRecord(a)} → ${describeFitRecord(b)}` }];
	}
	const ea = Array.isArray(a.editedParams) ? a.editedParams : [];
	const eb = Array.isArray(b.editedParams) ? b.editedParams : [];
	if (!same(ea, eb)) {
		return [
			{
				area: 'settings',
				kind: 'changed',
				subject,
				text: eb.length
					? `Fit record: parameters edited since the fit (${eb.join(', ')})${ea.length ? `, was ${ea.join(', ')}` : ''}`
					: `Fit record: parameters back to the fitted values (were edited: ${ea.join(', ')})`
			}
		];
	}
	return same(a, b) ? [] : [{ area: 'settings', kind: 'changed', subject, text: 'Fit record changed' }];
}

const NODE_FIELDS: [keyof NetworkNode, string, Fmt][] = [
	['kind', 'kind', plain],
	['areaKm2', 'area', withUnit('km²')],
	['areaHiKm2', 'high-MAP area', withUnit('km²')],
	['areaLoKm2', 'low-MAP area', withUnit('km²')],
	['flowShareManual', 'manual flow share', (v) => (v === null || v === undefined ? 'none' : pct(v))],
	['pctUpstreamToDam', 'upstream inflow to dam', pct],
	['pctRunoffToDam', 'own runoff to dam', pct],
	['damCapacityM3', 'dam capacity', withUnit('m³', 0)],
	['damInitialPct', 'dam initial level', pct],
	['damMinPct', 'dam minimum operating level', pct],
	['divertCapacityM3Day', 'diversion capacity', withUnit('m³/day', 0)],
	['returnFlowPct', 'return flow', pct]
];

const ha = (m2: number) => `${fmtValue(m2 / 10_000, 2)} ha`;

function diffModel(ma: ProjectModel | undefined, mb: ProjectModel | undefined): InputChange[] {
	const a: ProjectModel = { nodes: [], crops: [], cropAreas: [], transfers: [], ...(ma ?? {}) };
	const b: ProjectModel = { nodes: [], crops: [], cropAreas: [], transfers: [], ...(mb ?? {}) };
	const out: InputChange[] = [];
	const nameOf = (m: ProjectModel) => {
		const nodes = new Map(m.nodes.map((n) => [n.id, n.name] as [string, string]));
		const crops = new Map(m.crops.map((c) => [c.id, c.name] as [string, string]));
		return { node: (id: string | null) => (id ? (nodes.get(id) ?? 'unknown node') : null), crop: (id: string) => crops.get(id) ?? 'unknown crop' };
	};
	const na = nameOf(a);
	const nb = nameOf(b);

	// --- network nodes ---
	const nodes = matchByIdThenName(a.nodes, b.nodes, (n) => n.id, (n) => n.name);
	for (const n of nodes.onlyA) out.push({ area: 'network', kind: 'removed', subject: n.name, text: `${cap(n.kind)} "${n.name}" removed` });
	for (const n of nodes.onlyB) {
		const dam = n.kind === 'farm' && n.damCapacityM3 > 0 ? `, dam ${fmtValue(n.damCapacityM3, 0)} m³` : '';
		const into = nb.node(n.downstreamNodeId);
		out.push({
			area: 'network',
			kind: 'added',
			subject: n.name,
			text: `${cap(n.kind)} "${n.name}" added (${fmtValue(n.areaKm2)} km²${dam}${into ? `, drains into ${into}` : ''})`
		});
	}
	for (const [x, y] of nodes.pairs) {
		const parts: string[] = [];
		if (x.name !== y.name) parts.push(`renamed from "${x.name}"`);
		for (const [k, label, fmt] of NODE_FIELDS) {
			if (!same(x[k], y[k])) parts.push(`${label} ${fmt(x[k])} → ${fmt(y[k])}`);
		}
		const da = na.node(x.downstreamNodeId);
		const db = nb.node(y.downstreamNodeId);
		if (!same(da && nameKey(da), db && nameKey(db))) parts.push(`drains into ${db ?? 'nothing (outflow)'} (was ${da ?? 'nothing (outflow)'})`);
		for (const p of parts) out.push({ area: 'network', kind: 'changed', subject: y.name, text: `${y.name}: ${p}` });
	}

	// --- crops ---
	const crops = matchByIdThenName(a.crops, b.crops, (c) => c.id, (c) => c.name);
	for (const c of crops.onlyA) out.push({ area: 'crops', kind: 'removed', subject: c.name, text: `Crop "${c.name}" removed` });
	for (const c of crops.onlyB) out.push({ area: 'crops', kind: 'added', subject: c.name, text: `Crop "${c.name}" added` });
	for (const [x, y] of crops.pairs) {
		if (x.name !== y.name) out.push({ area: 'crops', kind: 'changed', subject: y.name, text: `Crop "${y.name}" renamed from "${x.name}"` });
		const c = monthlyChange((x as CropDef).cropFactor, (y as CropDef).cropFactor, '');
		if (c) out.push({ area: 'crops', kind: 'changed', subject: y.name, text: `Crop "${y.name}" crop factor: ${c}` });
	}

	// --- crop areas, keyed by (farm name, crop name) so copies line up ---
	const areaKey = (farm: string | null, crop: string) => `${nameKey(farm ?? '')}\u0000${nameKey(crop)}`;
	// Crop areas follow their node/crop through a rename: key B's rows by B's names,
	// and A's rows by the name their node/crop has in B when it was matched.
	const nodeRename = new Map(nodes.pairs.map(([x, y]) => [x.id, y.name] as [string, string]));
	const cropRename = new Map(crops.pairs.map(([x, y]) => [x.id, y.name] as [string, string]));
	const areasA = new Map<string, { farm: string; crop: string; m2: number }>();
	for (const r of a.cropAreas) {
		const farm = nodeRename.get(r.nodeId) ?? na.node(r.nodeId) ?? '';
		const crop = cropRename.get(r.cropId) ?? na.crop(r.cropId);
		const k = areaKey(farm, crop);
		areasA.set(k, { farm, crop, m2: (areasA.get(k)?.m2 ?? 0) + r.areaM2 });
	}
	const areasB = new Map<string, { farm: string; crop: string; m2: number }>();
	for (const r of b.cropAreas) {
		const farm = nb.node(r.nodeId) ?? '';
		const crop = nb.crop(r.cropId);
		const k = areaKey(farm, crop);
		areasB.set(k, { farm, crop, m2: (areasB.get(k)?.m2 ?? 0) + r.areaM2 });
	}
	for (const [k, r] of areasA) {
		if (areasB.has(k)) continue;
		out.push({ area: 'crops', kind: 'removed', subject: r.farm, text: `Crop "${r.crop}" removed from ${r.farm} (was ${ha(r.m2)})` });
	}
	for (const [k, r] of areasB) {
		const old = areasA.get(k);
		if (!old) out.push({ area: 'crops', kind: 'added', subject: r.farm, text: `Crop "${r.crop}" added to ${r.farm} (${ha(r.m2)})` });
		else if (old.m2 !== r.m2) {
			out.push({ area: 'crops', kind: 'changed', subject: r.farm, text: `${r.farm}: "${r.crop}" area ${ha(old.m2)} → ${ha(r.m2)}` });
		}
	}

	// --- transfers: by id, then by "from → to" route (A's route in B's names) ---
	const route = (m: typeof na, t: Transfer) => `${m.node(t.fromNodeId)} → ${m.node(t.toNodeId)}`;
	const routeInB = (t: Transfer) =>
		`${nodeRename.get(t.fromNodeId) ?? na.node(t.fromNodeId)} → ${nodeRename.get(t.toNodeId) ?? na.node(t.toNodeId)}`;
	const tm = matchByIdThenName(
		a.transfers.map((t) => ({ t, key: routeInB(t) })),
		b.transfers.map((t) => ({ t, key: route(nb, t) })),
		(w) => w.t.id,
		(w) => w.key
	);
	const transfers = {
		pairs: tm.pairs.map(([x, y]) => [x.t, y.t] as [Transfer, Transfer]),
		onlyA: tm.onlyA.map((w) => w.t),
		onlyB: tm.onlyB.map((w) => w.t)
	};
	const describeTransfer = (t: Transfer) =>
		`${fmtValue(t.maxRateM3s)} m³/s, ${describeCalendarMonths(t.months)}${t.enabled ? '' : ', disabled'}`;
	for (const t of transfers.onlyA) {
		const r = route(na, t);
		out.push({ area: 'transfers', kind: 'removed', subject: r, text: `Transfer ${r} removed` });
	}
	for (const t of transfers.onlyB) {
		const r = route(nb, t);
		out.push({ area: 'transfers', kind: 'added', subject: r, text: `Transfer ${r} added (${describeTransfer(t)})` });
	}
	for (const [x, y] of transfers.pairs) {
		const r = route(nb, y);
		const parts: string[] = [];
		if (routeInB(x) !== r) parts.push(`route was ${route(na, x)}`);
		if (x.enabled !== y.enabled) parts.push(y.enabled ? 'enabled' : 'disabled');
		if (!same(monthSet(x.months), monthSet(y.months))) parts.push(`months ${describeCalendarMonths(x.months)} → ${describeCalendarMonths(y.months)}`);
		if (x.maxRateM3s !== y.maxRateM3s) parts.push(`max rate ${fmtValue(x.maxRateM3s)} → ${fmtValue(y.maxRateM3s)} m³/s`);
		if (x.dailyCapM3 !== y.dailyCapM3) parts.push(`daily cap ${withUnit('m³', 0)(x.dailyCapM3)} → ${withUnit('m³', 0)(y.dailyCapM3)}`);
		if (x.minStoragePct !== y.minStoragePct) parts.push(`minimum source storage ${pct(x.minStoragePct)} → ${pct(y.minStoragePct)}`);
		for (const p of parts) out.push({ area: 'transfers', kind: 'changed', subject: r, text: `Transfer ${r}: ${p}` });
	}
	return out;
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

const SERIES_LABELS: Record<string, string> = {
	rain_catchment_mm: 'Rainfall (catchment)',
	rain_chirps_mm: 'Rainfall (CHIRPS)',
	rain_forecast_mm: 'Rainfall (forecast)',
	flow_observed_m3s: 'Observed flow',
	flow_logger_m3s: 'Logger flow',
	flow_reference_m3s: 'Reference gauge (other catchment)'
};

function diffSeries(sa: RunInputsSnapshot['series'] | undefined, sb: RunInputsSnapshot['series'] | undefined): InputChange[] {
	const a = sa ?? {};
	const b = sb ?? {};
	const out: InputChange[] = [];
	const range = (s: RunSeriesSnapshot) => {
		const start = toEpochDay(s.startDate);
		return { start: s.startDate, end: fromEpochDay(start + Math.max(0, s.length - 1)), empty: !(s.length > 0) };
	};
	const kinds = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
	for (const k of kinds) {
		const label = SERIES_LABELS[k] ?? k;
		const x = a[k];
		const y = b[k];
		if (x && !y) out.push({ area: 'series', kind: 'removed', subject: label, text: `${label} series removed` });
		else if (!x && y) {
			const r = range(y);
			out.push({ area: 'series', kind: 'added', subject: label, text: `${label} series added (${r.empty ? 'no values' : `${r.start} to ${r.end}`})` });
		} else if (x && y) {
			const ra = range(x);
			const rb = range(y);
			// An empty series has no dates to compare: say it emptied or filled.
			if (ra.empty || rb.empty) {
				if (ra.empty !== rb.empty) {
					out.push({
						area: 'series',
						kind: 'changed',
						subject: label,
						text: rb.empty ? `${label} series now has no values (was ${ra.start} to ${ra.end})` : `${label} series now has values (${rb.start} to ${rb.end})`
					});
				}
				continue;
			}
			if (rb.end > ra.end) out.push({ area: 'series', kind: 'changed', subject: label, text: `${label} series extended to ${rb.end} (was ${ra.end})` });
			else if (rb.end < ra.end) out.push({ area: 'series', kind: 'changed', subject: label, text: `${label} series now ends ${rb.end} (was ${ra.end})` });
			if (rb.start < ra.start) out.push({ area: 'series', kind: 'changed', subject: label, text: `${label} series extended back to ${rb.start} (was ${ra.start})` });
			else if (rb.start > ra.start) out.push({ area: 'series', kind: 'changed', subject: label, text: `${label} series now starts ${rb.start} (was ${ra.start})` });
			// Same dates, different content: values corrected in place. (With
			// different dates the hash can't tell whether shared days changed.)
			const sameRange = ra.start === rb.start && ra.end === rb.end;
			if (sameRange && x.valuesSha256 && y.valuesSha256 && x.valuesSha256 !== y.valuesSha256) {
				out.push({ area: 'series', kind: 'changed', subject: label, text: `${label} values changed (same dates, ${ra.start} to ${ra.end})` });
			}
		}
	}
	return out;
}

/**
 * Human-readable list of what differs between the inputs of run A and run B:
 * settings, network nodes, crops and crop areas, transfers, and the date range
 * of each driving series. Values edited within the same dates show up through
 * the series' content hash (when both runs stored one); when the dates also
 * changed, only the date change is reported.
 */
export function diffInputs(a: RunInputsSnapshot | null | undefined, b: RunInputsSnapshot | null | undefined): InputChange[] {
	return [
		...diffModel(a?.model, b?.model),
		...diffSettings(a?.settings, b?.settings),
		...diffSeries(a?.series, b?.series)
	];
}
