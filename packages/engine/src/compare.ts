// Run comparison: what changed between two runs, in results (compareRuns) and
// in the inputs that produced them (diffInputs). Pure — the backend calls it
// for GET /compare/runs and the frontend could call it for a live preview.
//
// Runs may come from two different projects (e.g. project D copied from C and
// then modified). Copies get fresh node/crop/transfer ids, so everything is
// matched by id first (same project, catches renames) and then by name
// (across copies). See docs/run-comparison.md.
import { DEFAULT_ALLOCATION_TOLERANCE, type AllocationEntry } from './allocations/compare';
import { ALLOCATION_MODE_LABEL, type AllocationMode } from './allocations/mode';
import { regroup } from './format';
import { DEFAULT_ANNUAL_THRESHOLD } from './network/reliability';
import { fromEpochDay, toEpochDay } from './calendar';
import { ewrSourceConfidence, type EwrRuleTable, type EwrRuleSourceKind } from './reserve/rules';
import { isEwrSite } from './network/topology';
import { hasMonthlyRates, transferRatesM3s } from './network/transferRates';
import { isRiverOfftake } from './network/offtake';
import type { EwrAssuranceSite } from './reserve/assurance';
import { exclusionKey, exclusionLabel, type CalibrationExclusion, type FitRecord } from './calibrate/provenance';
import { originLabel, provenanceLabel, sameOrigin, sameProvenance, type SeriesOrigin, type SeriesProvenance } from './seriesProvenance';
import { defaultFlowGapFill, gapFillRecordLabel, GAP_FILL_KINDS, type FlowGapFillSpec } from './flowGapFill';
import { qualityFlagChanges, resolveQualityFlags, type QualityFlagSettings } from './calibrate/qualityFlagSettings';
import { calibrationRulesChanges, resolveCalibrationRules } from './calibrate/rulesSettings';
import { fitPeriodText, fitSegmentName, fitWindowLabels, type ChirpsCorrection } from './rain';
import { rainSourceLines, rainSourceText } from './rainSourcePeriods';
import { declaredRuleText } from './uncertainty/options';
import {
	defaultProjectSettings,
	RETIRED_CALIBRATION_KEYS,
	resolveArealRain,
	resolvePe,
	SUPPLY_RULE_LABEL,
	OBSERVED_SERIES_LABEL,
	parseGaugeSeriesKey,
	upgradeLegacyModel,
	type Borehole,
	type CalibrationFitStatus,
	type CalibrationStats,
	type CropDef,
	type DemandObject,
	DEMAND_OBJECT_CATEGORY_LABEL,
	type FarmSummary,
	type LandCoverPatch,
	type NetworkNode,
	type ArealRain,
	type PeInput,
	type ProjectModel,
	type ProjectSettings,
	type RunSummary,
	type Transfer
} from './project';
import type { Wr2012Reference, Wr2012Settings } from './reference/wr2012Settings';
import { OBJECTIVE_LABELS, type ObjectiveId } from './calibrate/objectives';
import { comparePlausibility, type PlausibilityComparison } from './plausibility/compare';

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
	/**
	 * The product and version the series held (032_series_provenance.sql):
	 * null = not recorded, absent on runs stored before it was recorded.
	 */
	provenance?: SeriesProvenance | null;
	/**
	 * Where the values came from and the unit they were given in
	 * (107_series_source.sql): null = not recorded, absent on runs stored
	 * before it was recorded.
	 */
	origin?: SeriesOrigin | null;
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
	/** null when neither run has calibration statistics. */
	calibration: {
		/** Whether each run's scores are in-sample (CalibrationStats.fitStatus, engine ≥ 0.39.0); null = not recorded. */
		fitStatus: { a: CalibrationFitStatus | null; b: CalibrationFitStatus | null };
		days: MetricDelta;
		nse: MetricDelta;
		/** Kling–Gupta efficiency (absent on runs saved before engine 0.3.0). */
		kge: MetricDelta;
		pbias: MetricDelta;
		rmseM3s: MetricDelta;
		meanObservedM3s: MetricDelta;
		meanSimulatedM3s: MetricDelta;
	} | null;
	/**
	 * The CHIRPS fallback factors each run applied (model.md §2.4b); null when
	 * neither run fitted any (no CHIRPS, mode 'none', or saved before engine
	 * 0.7.0). `changed` when a month's applied factor or the water years left
	 * out of the fit differ, or only one run has factors: a keep-dry or
	 * missing-period edit, new rain data or an engine change (0.18.0 fits
	 * around flagged zero runs day by day) all move them, so rain on the days
	 * CHIRPS fills in differs even with the setting unchanged.
	 */
	chirpsFit: {
		pooledFactor: MetricDelta;
		excludedWaterYearsA: number[] | null;
		excludedWaterYearsB: number[] | null;
		/**
		 * Engine ≥ 0.29.0: each run's CHIRPS fit period in words ("whole
		 * record" or the listed ranges), its fit ranges by name, and the
		 * reference window of every fit (the water years that gave it shared
		 * days; empty for a run saved before 0.29.0, which fitted the whole
		 * record). A change of period, of ranges, of a range's factors or of a
		 * reference window counts in `changed`.
		 */
		fitPeriodA?: string | null;
		fitPeriodB?: string | null;
		segmentsA?: string[];
		segmentsB?: string[];
		fitWindowsA?: string[];
		fitWindowsB?: string[];
		changed: boolean;
	} | null;
	/**
	 * The rain-source periods each run applied (engine ≥ 0.30.0, model.md
	 * §2.4e): one line per period with its factors, where they came from (the
	 * provenance, or a fit's reference and reference windows) and its
	 * fallback. null when neither run has any; `changed` when the lines differ.
	 */
	rainSource?: { periodsA: string[]; periodsB: string[]; changed: boolean } | null;
	/**
	 * Reserve compliance by month (engine ≥ 0.21.0, model.md §2.9c): one row
	 * per EWR site with a rule table in either run, matched by site (the
	 * outlet with the outlet, a gauge by id then name), outlet first. null when
	 * neither run has one. Rates are 0–1, deltas in fraction points.
	 */
	ewrAssurance: EwrAssuranceDelta[] | null;
	/**
	 * The hydrologist plausibility checks side by side (./plausibility/compare.ts):
	 * per site (the outlet, then each gauge with a record of its own) the failing
	 * water years of check 1 and the Q90 ratio of check 4, with pass or fail,
	 * and the catchment-wide checks 2 and 3. null when neither run has them
	 * (both before engine 0.25.0).
	 */
	plausibility: PlausibilityComparison | null;
	/** The WR2012 check (engine ≥ 0.6.0); null when neither run has one. Ratios are simulated natural ÷ scaled WR2012. */
	wr2012: {
		marRatioOverlap: MetricDelta;
		marRatioWhole: MetricDelta;
		lowFlowRatio: MetricDelta;
		patternCorrelation: MetricDelta;
	} | null;
}

/** One EWR site's Reserve compliance in both runs (compareRuns). */
export interface EwrAssuranceDelta {
	/** Name in run B, else A. */
	name: string;
	isOutlet: boolean;
	/** The site has a rule table in one run only. */
	onlyIn: 'a' | 'b' | null;
	/** The two runs' tables differ (source, points, values, unit, scale or natural source): the rates measure against different rules. */
	tableChanged: boolean;
	rate: MetricDelta;
	monthsNotMet: MetricDelta;
	months: MetricDelta;
	deficitM3: MetricDelta;
	longestNotMetRun: MetricDelta;
	fdcRate: MetricDelta;
	/** Months met ÷ complete years per calendar month, water-year order (Oct … Sep). */
	byMonth: MetricDelta[];
	/** Months the low flows were met (engine ≥ 0.33.0; null values without a low-flow grid). */
	lowFlowRate: MetricDelta;
	/** Water years the high-flow components were met ÷ years they were required, summed over the components (engine ≥ 0.33.0). */
	highFlowRate: MetricDelta;
	/** Days below the day's requirement ÷ days, and the required volume not delivered, from daily data (engine ≥ 1.19.0, CR-29; null values on older runs). */
	timeNotMet?: MetricDelta;
	volumeNotMet?: MetricDelta;
	/** The EWR as %nMAR at the site (engine ≥ 1.19.0, CR-29). */
	ewrPctNmar?: MetricDelta;
}

export type InputChangeArea = 'settings' | 'network' | 'crops' | 'transfers' | 'series';

export interface InputChange {
	area: InputChangeArea;
	kind: 'added' | 'removed' | 'changed';
	/** What the change is about: a node, crop, transfer, series or setting name. */
	subject: string;
	/** Complete human-readable sentence, e.g. "Rooikloof: dam capacity 600 000 → 750 000 m³". */
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
	const fitOf = (s: RunSummary) => {
		const c = s.chirpsCorrection;
		return c && c.mode === 'monthly' && c.months.some((m) => m.factor !== null) ? c : null;
	};
	const xa = fitOf(a.summary);
	const xb = fitOf(b.summary);
	const monthsDiffer = (p: ChirpsCorrection['months'], q: ChirpsCorrection['months'] | undefined) =>
		p.some((m, i) => {
			const f = q?.[i]?.factor ?? null;
			return m.factor === null || f === null ? m.factor !== f : Math.abs(m.factor - f) > 1e-9;
		});
	const segsOf = (x: ChirpsCorrection | null) => x?.fitPeriod?.segments ?? [];
	const rsa = rainSourceLines(a.summary.rainSource);
	const rsb = rainSourceLines(b.summary.rainSource);
	const rainSource = rsa.length || rsb.length ? { periodsA: rsa, periodsB: rsb, changed: !same(rsa, rsb) } : null;
	const chirpsFit =
		xa || xb
			? {
					pooledFactor: metricDelta(xa?.pooled.factor, xb?.pooled.factor),
					excludedWaterYearsA: xa?.excludedWaterYears ?? null,
					excludedWaterYearsB: xb?.excludedWaterYears ?? null,
					fitPeriodA: xa ? fitPeriodText(xa.fitPeriod) : null,
					fitPeriodB: xb ? fitPeriodText(xb.fitPeriod) : null,
					segmentsA: segsOf(xa).map(fitSegmentName),
					segmentsB: segsOf(xb).map(fitSegmentName),
					fitWindowsA: fitWindowLabels(xa),
					fitWindowsB: fitWindowLabels(xb),
					changed:
						!xa ||
						!xb ||
						!same(xa.excludedWaterYears, xb.excludedWaterYears) ||
						monthsDiffer(xa.months, xb.months) ||
						fitPeriodText(xa.fitPeriod) !== fitPeriodText(xb.fitPeriod) ||
						!same(segsOf(xa).map(fitSegmentName), segsOf(xb).map(fitSegmentName)) ||
						segsOf(xa).some((s, i) => monthsDiffer(s.months, segsOf(xb)[i]?.months)) ||
						// Only when both recorded their windows: a run before 0.29.0 has none to compare.
						(xa.fitWindow !== undefined && xb.fitWindow !== undefined && !same(fitWindowLabels(xa), fitWindowLabels(xb)))
				}
			: null;

	return {
		ewrAssurance: compareAssurance(a.summary.ewrAssurance, b.summary.ewrAssurance),
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
						fitStatus: { a: ka?.fitStatus ?? null, b: kb?.fitStatus ?? null },
						days: metricDelta(ka?.days, kb?.days),
						nse: metricDelta(ka?.nse, kb?.nse),
						kge: metricDelta(ka?.kge, kb?.kge),
						pbias: metricDelta(ka?.pbias, kb?.pbias),
						rmseM3s: metricDelta(ka?.rmseM3s, kb?.rmseM3s),
						meanObservedM3s: metricDelta(ka?.meanObservedM3s, kb?.meanObservedM3s),
						meanSimulatedM3s: metricDelta(ka?.meanSimulatedM3s, kb?.meanSimulatedM3s)
					}
				: null,
		chirpsFit,
		rainSource,
		plausibility: comparePlausibility(a.summary.plausibility, b.summary.plausibility),
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

/** Years a site's high-flow components were met ÷ years they were required, over every component; null without one. */
function highFlowRate(s: EwrAssuranceSite | null): number | null {
	const h = s?.highFlows ?? [];
	const req = h.reduce((n, c) => n + c.overall.required, 0);
	return req ? h.reduce((n, c) => n + c.overall.met, 0) / req : null;
}

/** Pair each EWR site's Reserve compliance across the runs: the outlet with the outlet, gauges by id then name. */
function compareAssurance(ra: EwrAssuranceSite[] | undefined, rb: EwrAssuranceSite[] | undefined): EwrAssuranceDelta[] | null {
	const a = ra ?? [];
	const b = rb ?? [];
	if (!a.length && !b.length) return null;
	const key = (s: EwrAssuranceSite) => (s.isOutlet ? '(outlet)' : (s.nodeId ?? ''));
	const m = matchByIdThenName(a, b, key, (s) => (s.isOutlet ? '(outlet)' : s.name));
	const tableOf = (s: EwrAssuranceSite) => ({
		source: s.source,
		component: s.component,
		unit: s.unit,
		naturalSource: s.naturalSource,
		scale: s.scale,
		points: s.points,
		ewr: s.byMonth.map((x) => x.fdc.map((f) => f.required)),
		// Engine ≥ 0.33.0: whether low flows are split out, and the high-flow components (not their yearly results).
		lowFlow: !!s.lowFlow,
		highFlows: (s.highFlows ?? []).map((h) => [h.label, h.months, h.peakM3s, h.durationDays, h.perYear])
	});
	const row = (x: EwrAssuranceSite | null, y: EwrAssuranceSite | null): EwrAssuranceDelta => ({
		name: (y ?? x)!.name,
		isOutlet: (y ?? x)!.isOutlet,
		onlyIn: x && y ? null : x ? 'a' : 'b',
		tableChanged: !!x && !!y && !same(tableOf(x), tableOf(y)),
		rate: metricDelta(x?.overall.rate, y?.overall.rate),
		monthsNotMet: metricDelta(x ? x.overall.months - x.overall.met : null, y ? y.overall.months - y.overall.met : null),
		months: metricDelta(x?.overall.months, y?.overall.months),
		deficitM3: metricDelta(x?.overall.deficitM3, y?.overall.deficitM3),
		longestNotMetRun: metricDelta(x?.overall.longestNotMetRun, y?.overall.longestNotMetRun),
		fdcRate: metricDelta(x?.fdc.rate, y?.fdc.rate),
		byMonth: Array.from({ length: 12 }, (_, i) => metricDelta(x?.byMonth[i]?.rate, y?.byMonth[i]?.rate)),
		lowFlowRate: metricDelta(x?.lowFlow?.rate, y?.lowFlow?.rate),
		highFlowRate: metricDelta(highFlowRate(x), highFlowRate(y)),
		timeNotMet: metricDelta(x?.daily?.timeNotMet, y?.daily?.timeNotMet),
		volumeNotMet: metricDelta(x?.daily?.volumeNotMet, y?.daily?.volumeNotMet),
		ewrPctNmar: metricDelta(x?.ewrPctNmar?.pct, y?.ewrPctNmar?.pct)
	});
	const rows = [...m.pairs.map(([x, y]) => row(x, y)), ...m.onlyA.map((x) => row(x, null)), ...m.onlyB.map((y) => row(null, y))];
	return rows.sort((p, q) => Number(q.isOutlet) - Number(p.isOutlet));
}

// ---------------------------------------------------------------------------
// diffInputs
// ---------------------------------------------------------------------------

const WY_MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
const CAL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const nf = new Map<number, Intl.NumberFormat>();
/** Grouped with the app's thousands separator, up to `digits` decimals (trailing zeros dropped). */
export function fmtValue(v: unknown, digits = 3): string {
	if (v === null || v === undefined) return 'none';
	if (typeof v !== 'number') return String(v);
	if (!Number.isFinite(v)) return '–';
	let f = nf.get(digits);
	if (!f) {
		f = new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, useGrouping: true });
		nf.set(digits, f);
	}
	const s = regroup(f.format(v));
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

/** A monthly row that may be absent (null = off): set or cleared reads as the whole row, Oct–Sep; otherwise as monthlyChange. */
function optionalMonthlyChange(a: unknown, b: unknown, unit: string, none: string): string | null {
	const has = (x: unknown) => Array.isArray(x) && x.length > 0;
	const row = (x: unknown) => `${(x as unknown[]).map((v) => fmtValue(v)).join(', ')}${unit ? ` ${unit}` : ''} (Oct–Sep)`;
	if (!has(a) && !has(b)) return null;
	if (!has(a)) return `${none} → ${row(b)}`;
	if (!has(b)) return `${row(a)} → ${none}`;
	return monthlyChange(a, b, unit);
}

function arrayChange(a: unknown, b: unknown): string {
	const xa = Array.isArray(a) ? a : [];
	const xb = Array.isArray(b) ? b : [];
	let n = 0;
	for (let i = 0; i < Math.max(xa.length, xb.length); i++) if (!same(xa[i], xb[i])) n++;
	const len = xa.length !== xb.length ? ` (${xa.length} → ${xb.length} values)` : '';
	return `${n} value${n === 1 ? '' : 's'} changed${len}`;
}

/**
 * GR4J's potential-evaporation input in words (engine ≥ 0.31.0, issue #39):
 * "pan coefficient × A-pan", or "monthly PE, 1,234 mm/yr (source: …)".
 */
export function peText(pe: PeInput): string {
	if (pe.kind !== 'monthly') return 'pan coefficient × A-pan';
	const total = pe.mm.reduce((a, v) => a + v, 0);
	const source = pe.source.trim();
	return `monthly PE, ${fmtValue(total, 0)} mm/yr (${source ? `source: ${source}` : 'no source given'})`;
}

/**
 * The change of settings.pe between two runs, or null. A run saved without
 * one (engine < 0.31.0) ran pan coefficient × A-pan. Two monthly rows name the
 * months that changed (or how many) and the annual totals; a reworded source
 * note is listed too, since it is part of the run's record.
 */
function peChange(ra: unknown, rb: unknown): string | null {
	const a = resolvePe(ra, []);
	const b = resolvePe(rb, []);
	if (same(a, b)) return null;
	if (a.kind !== 'monthly' || b.kind !== 'monthly') return `${peText(a)} → ${peText(b)}`;
	const parts: string[] = [];
	const rows = monthlyChange(a.mm, b.mm, 'mm');
	if (rows) {
		const total = (x: readonly number[]) => fmtValue(x.reduce((s, v) => s + v, 0), 0);
		parts.push(`monthly PE ${rows} (${total(a.mm)} → ${total(b.mm)} mm/yr)`);
	}
	if (a.source.trim() !== b.source.trim()) parts.push(`source "${a.source.trim()}" → "${b.source.trim()}"`);
	return parts.length ? parts.join('; ') : null;
}

/** An areal rainfall correction in words (engine ≥ 1.13.0): "none", or "× 1.9 (map: …)" / "× 1.5–2.1 by month (…)". */
export function arealRainText(a: ArealRain | null): string {
	if (!a) return 'none';
	const lo = Math.min(...a.factors);
	const hi = Math.max(...a.factors);
	const f = lo === hi ? `× ${fmtValue(lo, 3)}` : `× ${fmtValue(lo, 3)}–${fmtValue(hi, 3)} by month`;
	return `${f} (${a.method}: ${a.source})`;
}

/**
 * The change of settings.arealRain between two runs, or null. A run saved
 * without one (engine < 1.13.0) ran with none. Two corrections name the months
 * whose factor changed; a changed method or source note is listed too, since
 * it is part of the run's record.
 */
function arealRainChange(ra: unknown, rb: unknown): string | null {
	const a = resolveArealRain(ra, []);
	const b = resolveArealRain(rb, []);
	if (same(a, b)) return null;
	if (!a || !b) return `${arealRainText(a)} → ${arealRainText(b)}`;
	const parts: string[] = [];
	const rows = monthlyChange(a.factors, b.factors, '');
	if (rows) parts.push(`factors ${rows}`);
	if (a.method !== b.method) parts.push(`method ${a.method} → ${b.method}`);
	if (a.source !== b.source) parts.push(`source "${a.source}" → "${b.source}"`);
	return parts.length ? parts.join('; ') : null;
}
const AREAL_RAIN_LABEL = 'Areal rainfall correction (GR4J)';

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
	effectiveRainStoreMm: { label: 'Soil-water store (effective rain carry-over)', fmt: withUnit('mm') },
	lakeEvapFactor: { label: 'Dam evaporation factor (× A-pan)', fmt: plain },
	// Engine ≥ 0.32.0; absent = the default 0.9. Changes only the reported annual reliability.
	assuranceAnnualThreshold: { label: 'Annual assurance threshold', fmt: pct },
	// Engine ≥ 1.18.0 (issue #72); a snapshot without them compared only, at ±10 %.
	allocationMode: { label: 'Allocation mode', fmt: (v) => ALLOCATION_MODE_LABEL[(v ?? 'none') as AllocationMode] ?? String(v) },
	allocationTolerance: { label: 'Allocation comparison band', fmt: (v) => `±${pct(v)}` },
	// Issue #71 (ER3): the rule an evidence report's cited ensemble must follow; never changes a result. Absent = not declared.
	evidenceUncertaintyRule: { label: 'Declared uncertainty rule (evidence)', fmt: declaredRuleText },
	flowShareMethod: { label: 'Flow-share method', fmt: plain },
	// Engine ≥ 1.3.0 (issue #64); a snapshot without them ran the defaults, which is what older runs did.
	ewrChargeSource: {
		label: 'EWR charge follows',
		fmt: (v) => (v === 'ruleTable' ? 'the Reserve rule tables' : v === 'pragmatic' || v === undefined ? 'the pragmatic EWR' : String(v))
	},
	lowFlowMeasure: {
		label: 'Low flows judged on',
		fmt: (v) => (v === 'baseflow' ? 'base flow (Lyne–Hollick filter)' : v === 'total' || v === undefined ? 'the month’s total flow' : String(v))
	},
	// Engine ≥ 0.31.1; provenance only. A snapshot without it had none.
	panCoefficientSource: { label: 'Pan coefficient source', fmt: (v) => (typeof v === 'string' && v ? `"${v}"` : 'none') },
	runoffModel: { label: 'Runoff model', fmt: (v) => (v === 'legacy' ? 'legacy (b023 recession)' : v === 'gr4j' ? 'GR4J' : String(v)) },
	chirpsBiasCorrection: {
		label: 'CHIRPS bias correction',
		fmt: (v) => (v === 'monthly' ? 'monthly factors' : v === 'none' ? 'raw CHIRPS' : String(v))
	},
	// Engine ≥ 0.29.0; a snapshot without it takes the default, 'all', which is what older runs did.
	chirpsFitPeriod: { label: 'CHIRPS fit period', fmt: (v) => (v === 'all' || Array.isArray(v) ? fitPeriodText(v as never) : String(v)) },
	// Engine ≥ 0.30.0; a snapshot without it had none.
	rainSource: { label: 'Rain-source periods', fmt: rainSourceText },
	simulationStart: { label: 'Simulation start', fmt: (v) => (v ? String(v) : 'first day with rain') },
	simulationEnd: { label: 'Simulation end', fmt: (v) => (v ? String(v) : 'last day with rain') },
	// Engine ≥ 0.44.0; set only by the seasonal outlook's members, never a project setting.
	demandFactorFrom: { label: 'Demand factors apply from', fmt: (v) => (v ? String(v) : 'the run start') },
	// Engine ≥ 0.46.0; set only by the review triggers' members, never a project setting.
	damStorageReset: {
		label: 'Dam storage set',
		fmt: (v) => {
			const r = v as { date?: unknown; storageM3?: Record<string, unknown> } | null | undefined;
			if (!r || typeof r !== 'object') return 'none';
			const dams = r.storageM3 && typeof r.storageM3 === 'object' ? Object.entries(r.storageM3).map(([id, m3]) => `${id} ${String(m3)} m³`) : [];
			return `on ${String(r.date)}: ${dams.join(', ') || 'no dam'}`;
		}
	},
	reportStart: { label: 'Curtailment report start', fmt: (v) => (v ? String(v) : 'start of run') },
	reportEnd: { label: 'Curtailment report end', fmt: (v) => (v ? String(v) : 'end of run') },
	calibrationStart: { label: 'Calibration window start', fmt: (v) => (v ? String(v) : 'start of record') },
	calibrationEnd: { label: 'Calibration window end', fmt: (v) => (v ? String(v) : 'end of record') },
	calibrationFlowKind: { label: 'Calibration flow series', fmt: (v) => (v ? (SERIES_LABELS[String(v)] ?? String(v)) : 'default (observed, else logger)') },
	// Engine ≥ 1.41.0; a snapshot without it calibrated at the outlet. Only calibration reads it, never the run.
	calibrationSiteNodeId: { label: 'Calibration site', fmt: (v) => (v ? `gauge node ${String(v)}` : 'the outlet') }
};
/** Engine ≥ 0.31.0; a snapshot without settings.pe ran pan coefficient × A-pan. */
const PE_LABEL = 'Potential evaporation (GR4J)';
const DATA_QUALITY_FIELDS: Record<string, ScalarField> = {
	agreementMinRatio: { label: 'gauge/logger lowest ratio', fmt: pct },
	agreementMaxRatio: { label: 'gauge/logger highest ratio', fmt: pct },
	agreementMinDays: { label: 'gauge/logger minimum shared days', fmt: withUnit('days') },
	// Engine ≥ 1.20.0 (issue #66); a snapshot without them ran the defaults (effectiveSettings merges them in).
	outlierFactorRain: { label: 'rain outlier factor', fmt: (v) => `${fmtValue(v)}× the 99th percentile` },
	outlierFactorFlow: { label: 'flow outlier factor', fmt: (v) => `${fmtValue(v)}× the 99th percentile` },
	flatlineRainDays: { label: 'rain flat-line', fmt: withUnit('days') },
	flatlineEvapDays: { label: 'A-pan flat-line', fmt: withUnit('days') },
	flatlineFlowMinDays: { label: 'flow flat-line floor', fmt: withUnit('days') },
	flatlineFlowMaxDays: { label: 'flow flat-line cap', fmt: withUnit('days') },
	zeroRunRule: {
		label: 'zero-rain run rule',
		fmt: (v) => (v === 'wetDays' ? 'days in the wet season' : v === 'usualRain' ? 'share of the usual annual rain' : String(v))
	},
	zeroRunMinWetDays: { label: 'zero-rain run wet-season days', fmt: withUnit('days') },
	zeroRunUsualShare: { label: 'zero-rain run share of usual annual rain', fmt: pct },
	zeroRunMinDays: { label: 'zero-rain run minimum length', fmt: withUnit('days') },
	zeroRunChirpsCheck: { label: 'zero-rain run CHIRPS check', fmt: (v) => (v === true ? 'on' : v === false ? 'off' : String(v)) },
	lowVsChirpsRatio: { label: 'low vs CHIRPS ratio', fmt: pct },
	lowVsChirpsBaseline: {
		label: 'low vs CHIRPS usual ratio',
		fmt: (v) => (v === 'record' ? 'whole-record median' : v === 'moving' ? 'moving median (±5 years)' : String(v))
	},
	lowVsChirpsMinimum: {
		label: 'low vs CHIRPS minimum CHIRPS rain',
		fmt: (v) => (v === 'fixed' ? '50 mm' : v === 'scaled' ? 'max(50 mm, 25 % of median annual CHIRPS)' : String(v))
	}
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
/** Calibration settings; all but the rain threshold and catchment area belonged to the legacy runoff model (engine < 1.0.0). */
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
 * it ran legacy, whatever today's default is; one without a soil-water store
 * predates it (engine 0.14.0), so it ran with none (0 mm); one without
 * zeroRainRuns predates it (engine 0.15.0), so it ran flagged zero runs as
 * recorded; one whose zeroRainRuns has no accumulationMode predates that
 * (engine 0.20.0), so it ran multi-day accumulations as recorded.
 */
function effectiveSettings(raw: RunInputsSnapshot['settings'] | undefined): Record<string, unknown> {
	const d = defaultProjectSettings() as unknown as Record<string, unknown>;
	const r = (raw ?? {}) as Record<string, unknown>;
	return {
		...d,
		...r,
		runoffModel: r.runoffModel ?? 'legacy',
		// Runs store settings merged over the defaults, so a snapshot without a
		// store size predates it (engine < 0.14.0) and carried no rain over.
		effectiveRainStoreMm: r.effectiveRainStoreMm ?? 0,
		zeroRainRuns: {
			mode: 'asRecorded',
			keepDry: [],
			missing: [],
			// Multi-day accumulations were left as recorded before engine 0.20.0.
			accumulationMode: 'asRecorded',
			keepReadings: [],
			addAccumulations: [],
			...((r.zeroRainRuns as object | undefined) ?? {})
		},
		// Likewise dams evaporated only from engine 0.16.0 (audit N2).
		lakeEvapFactor: r.lakeEvapFactor ?? 0,
		// Engine ≥ 0.32.0: absent means the default; it only changes a reported figure.
		assuranceAnnualThreshold: r.assuranceAnnualThreshold ?? DEFAULT_ANNUAL_THRESHOLD,
		allocationMode: r.allocationMode ?? 'none',
		allocationTolerance: r.allocationTolerance ?? DEFAULT_ALLOCATION_TOLERANCE,
		evidenceUncertaintyRule: r.evidenceUncertaintyRule ?? null,
		calibration: { ...(d.calibration as object), ...((r.calibration as object | undefined) ?? {}) },
		hiLoSplit: { ...(d.hiLoSplit as object), ...((r.hiLoSplit as object | undefined) ?? {}) },
		dataQuality: { ...(d.dataQuality as object), ...((r.dataQuality as object | undefined) ?? {}) },
		// Engine ≥ 1.22.0: absent means the defaults (a run before them had no gauged range, and its fit's flags don't reach it).
		qualityFlags: resolveQualityFlags(r.qualityFlags, []),
		gr4j: { ...(d.gr4j as object), ...((r.gr4j as object | undefined) ?? {}) },
		wr2012: { ...(d.wr2012 as object), ...((r.wr2012 as object | undefined) ?? {}) },
		// Engine ≥ 1.23.0: absent means no record was filled.
		flowGapFill: { ...defaultFlowGapFill(), ...((r.flowGapFill as object | undefined) ?? {}) }
	};
}

/** A record's gap-fill spec in words, for the settings diff (engine ≥ 1.23.0). */
function gapFillText(v: unknown): string {
	if (!v || typeof v !== 'object') return 'not filled';
	const s = v as Partial<FlowGapFillSpec>;
	const parts: string[] = [];
	if (s.interpolateMaxDays) parts.push(`interpolate gaps up to ${s.interpolateMaxDays} days`);
	if (s.donor) parts.push(`fill gaps up to ${s.donorMaxDays ?? '?'} days from the ${gapFillRecordLabel(s.donor)} (${s.donorMinOverlapDays ?? '?'} shared days at least)`);
	return parts.length ? parts.join(', ') : 'not filled';
}

/** What changed in settings.flowGapFill between two runs (engine ≥ 1.23.0). */
function diffFlowGapFill(ra: unknown, rb: unknown): InputChange[] {
	const a = (ra ?? {}) as Record<string, unknown>;
	const b = (rb ?? {}) as Record<string, unknown>;
	const out: InputChange[] = [];
	for (const k of GAP_FILL_KINDS) {
		if (same(a[k] ?? null, b[k] ?? null)) continue;
		const subject = `Gap filling of the ${gapFillRecordLabel(k)}`;
		out.push({ area: 'settings', kind: 'changed', subject, text: `${subject}: ${gapFillText(a[k])} → ${gapFillText(b[k])}` });
	}
	return out;
}

function diffSettings(
	ra: RunInputsSnapshot['settings'] | undefined,
	rb: RunInputsSnapshot['settings'] | undefined,
	siteName: (id: string | null) => string = (id) => (id === null ? 'the outlet' : id)
): InputChange[] {
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
	// Monthly lake factors (WP-3.5); null = the one factor in every month.
	const lk = optionalMonthlyChange(a.lakeEvapFactorMonthly, b.lakeEvapFactorMonthly, '', 'the one factor');
	if (lk) push('Monthly dam evaporation factors', `Monthly dam evaporation factors: ${lk}`);
	// Monthly effective-rain fractions (engine ≥ 0.43.0); null = the one fraction in every month.
	const er = optionalMonthlyChange(a.effectiveRainFractionMonthly, b.effectiveRainFractionMonthly, '', 'the one fraction');
	if (er) push('Monthly effective rain fractions', `Monthly effective rain fractions: ${er}`);
	const pe = peChange(a.pe, b.pe);
	if (pe) push(PE_LABEL, `${PE_LABEL}: ${pe}`);
	const areal = arealRainChange(a.arealRain, b.arealRain);
	if (areal) push(AREAL_RAIN_LABEL, `${AREAL_RAIN_LABEL}: ${areal}`);
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
	// The legacy runoff model's own settings (removed in engine 1.0.0) changed a
	// run only if it ran that model: compare them only between two legacy runs.
	// Otherwise the model line above says what changed.
	const bothLegacy = a.runoffModel === 'legacy' && b.runoffModel === 'legacy';
	const retired = new Set<string>(RETIRED_CALIBRATION_KEYS);
	const counts = (k: string) => bothLegacy || !retired.has(k);
	for (const [k, f] of Object.entries(CALIBRATION_FIELDS)) {
		if (counts(k) && !same(ka[k], kb[k])) push(`Calibration ${f.label}`, `Calibration ${f.label}: ${f.fmt(ka[k])} → ${f.fmt(kb[k])}`);
	}
	if (bothLegacy && !same(monthSet(ka.summerMonths), monthSet(kb.summerMonths))) {
		push(
			'Calibration summer months',
			`Calibration summer months: ${describeCalendarMonths((ka.summerMonths as number[]) ?? [])} → ${describeCalendarMonths((kb.summerMonths as number[]) ?? [])}`
		);
	}
	for (const [k, label] of Object.entries(CALIBRATION_ARRAYS)) {
		if (bothLegacy && !same(ka[k], kb[k])) push(`Calibration ${label}`, `Calibration ${label}: ${arrayChange(ka[k], kb[k])}`);
	}
	out.push(...diffWr2012(a.wr2012 as Partial<Wr2012Settings>, b.wr2012 as Partial<Wr2012Settings>));
	out.push(...diffEwrRules(a.ewrRules, b.ewrRules, siteName));
	out.push(...diffExclusions(a.calibrationExclusions, b.calibrationExclusions));
	const za = a.zeroRainRuns as Record<string, unknown>;
	const zb = b.zeroRainRuns as Record<string, unknown>;
	const zeroMode = (v: unknown) => (v === 'missing' ? 'treated as missing (CHIRPS fills them)' : v === 'asRecorded' ? 'run as recorded (dry)' : String(v));
	if (!same(za.mode, zb.mode)) push('Flagged zero-rain runs', `Flagged zero-rain runs: ${zeroMode(za.mode)} → ${zeroMode(zb.mode)}`);
	out.push(...diffExclusions(za.keepDry, zb.keepDry, 'Keep-dry period'));
	out.push(...diffExclusions(za.missing, zb.missing, 'Missing-rain period'));
	const accMode = (v: unknown) => (v === 'spread' ? 'spread over the days they cover (CHIRPS pattern)' : v === 'asRecorded' ? 'run as recorded (one day)' : String(v));
	if (!same(za.accumulationMode, zb.accumulationMode)) {
		push('Multi-day rain accumulations', `Multi-day rain accumulations: ${accMode(za.accumulationMode)} → ${accMode(zb.accumulationMode)}`);
	}
	out.push(...diffExclusions(za.keepReadings, zb.keepReadings, 'Keep-reading period'));
	out.push(...diffExclusions(za.addAccumulations, zb.addAccumulations, 'Listed accumulation'));
	out.push(...diffFlowGapFill(a.flowGapFill, b.flowGapFill));
	for (const c of qualityFlagChanges(a.qualityFlags as QualityFlagSettings, b.qualityFlags as QualityFlagSettings)) push(c.subject, c.text);
	// Automated calibration's rules (engine ≥ 1.25.0, issue #153): a snapshot without them ran the defaults.
	for (const c of calibrationRulesChanges(resolveCalibrationRules(a.calibrationRules, []), resolveCalibrationRules(b.calibrationRules, []))) push(c.subject, c.text);
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
		'ewrRules',
		'calibrationExclusions',
		'zeroRainRuns',
		'flowGapFill',
		'qualityFlags',
		'calibrationRules',
		'fitRecord',
		'pe',
		'lakeEvapFactorMonthly',
		'effectiveRainFractionMonthly'
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

const RULE_FIELDS: Record<string, ScalarField> = {
	source: { label: 'source', fmt: (v) => (v ? `"${String(v)}"` : 'none') },
	// Engine ≥ 1.5.0: gazetted, desktop estimate or other; absent = not stated.
	sourceKind: { label: 'kind of source', fmt: (v) => ewrSourceConfidence(v as EwrRuleSourceKind | null | undefined) ?? 'not stated' },
	// ER9: the recommended ecological category, a label (no result depends on it); absent = not given.
	category: { label: 'recommended ecological category (REC)', fmt: (v) => (v ? String(v) : 'not given') },
	component: { label: 'covers', fmt: (v) => (v === 'lowFlow' ? 'low flows' : v === 'total' ? 'total flow' : String(v)) },
	unit: { label: 'unit', fmt: (v) => (v === 'mcm' ? 'Mm³ per month' : v === 'm3s' ? 'm³/s' : String(v)) },
	naturalSource: { label: 'natural percentile from', fmt: (v) => (v === 'run' ? 'the run' : v === 'table' ? 'the table' : String(v)) },
	scale: { label: 'scale', fmt: (v) => fmtValue(v) },
	// Engine ≥ 1.11.0: the determination's natural MAR at the site; absent = not recorded.
	naturalMarMcm: { label: 'natural MAR (determination)', fmt: (v) => (v === null || v === undefined ? 'not recorded' : `${fmtValue(v)} Mm³/a`) },
	points: { label: '% points', fmt: (v) => (Array.isArray(v) ? v.join(', ') : String(v)) }
};

/** Reserve rule tables (engine ≥ 0.21.0) added, removed or changed, per EWR site. */
function diffEwrRules(ra: unknown, rb: unknown, siteName: (id: string | null) => string): InputChange[] {
	const list = (v: unknown) => (Array.isArray(v) ? (v as EwrRuleTable[]).filter((x) => x && typeof x === 'object') : []);
	const a = new Map(list(ra).map((t) => [t.siteNodeId ?? null, t]));
	const b = new Map(list(rb).map((t) => [t.siteNodeId ?? null, t]));
	const out: InputChange[] = [];
	const subject = (id: string | null) => `EWR rule table at ${siteName(id)}`;
	for (const [id, x] of a) if (!b.has(id)) out.push({ area: 'settings', kind: 'removed', subject: subject(id), text: `${subject(id)} removed (was ${RULE_FIELDS.source!.fmt(x.source)})` });
	for (const [id, y] of b) {
		const x = a.get(id);
		if (!x) {
			out.push({ area: 'settings', kind: 'added', subject: subject(id), text: `${subject(id)} added (${RULE_FIELDS.source!.fmt(y.source)}, ${y.points?.length ?? 0} % points, natural percentile from ${RULE_FIELDS.naturalSource!.fmt(y.naturalSource)})` });
			continue;
		}
		const xr = x as unknown as Record<string, unknown>;
		const yr = y as unknown as Record<string, unknown>;
		for (const [k, f] of Object.entries(RULE_FIELDS)) {
			if (!same(xr[k] ?? null, yr[k] ?? null)) out.push({ area: 'settings', kind: 'changed', subject: `${subject(id)} ${f.label}`, text: `${subject(id)}: ${f.label} ${f.fmt(xr[k])} → ${f.fmt(yr[k])}` });
		}
		const months = (g: unknown, h: unknown) => WY_MONTHS.filter((_, m) => !same((g as unknown[] | null)?.[m] ?? null, (h as unknown[] | null)?.[m] ?? null));
		const ew = months(x.ewr, y.ewr);
		if (ew.length) out.push({ area: 'settings', kind: 'changed', subject: `${subject(id)} EWR values`, text: `${subject(id)}: EWR values changed in ${ew.join(', ')}` });
		const nat = months(x.natural, y.natural);
		if (nat.length && (x.naturalSource === 'table' || y.naturalSource === 'table')) {
			out.push({ area: 'settings', kind: 'changed', subject: `${subject(id)} natural flows`, text: `${subject(id)}: natural flows changed in ${nat.join(', ')}` });
		}
		// Engine ≥ 0.33.0: the low-flow grid and the high-flow components; absent, null and [] are all "none".
		const xl = x.lowFlow ?? null;
		const yl = y.lowFlow ?? null;
		if (!xl !== !yl) out.push({ area: 'settings', kind: 'changed', subject: `${subject(id)} low flows`, text: `${subject(id)}: low-flow values ${yl ? 'added' : 'removed'}` });
		else if (xl && yl) {
			const low = months(xl, yl);
			if (low.length) out.push({ area: 'settings', kind: 'changed', subject: `${subject(id)} low flows`, text: `${subject(id)}: low-flow values changed in ${low.join(', ')}` });
		}
		const hf = (t: EwrRuleTable) => (Array.isArray(t.highFlows) ? t.highFlows : []);
		const hx = hf(x);
		const hy = hf(y);
		if (!same(hx, hy)) {
			const names = (l: readonly { label?: unknown }[]) => l.map((e) => String(e?.label ?? '')).join(', ') || 'none';
			out.push({ area: 'settings', kind: 'changed', subject: `${subject(id)} high flows`, text: `${subject(id)}: high-flow components ${names(hx)} → ${names(hy)}${names(hx) === names(hy) ? ' (values changed)' : ''}` });
		}
	}
	return out;
}

/** Calibration exclusions added, removed, or given another reason (matched by their period). */
function diffExclusions(ra: unknown, rb: unknown, noun = 'Calibration exclusion'): InputChange[] {
	const list = (v: unknown) => (Array.isArray(v) ? (v as CalibrationExclusion[]).filter((x) => x && typeof x === 'object') : []);
	const a = new Map(list(ra).map((x) => [exclusionKey(x), x]));
	const b = new Map(list(rb).map((x) => [exclusionKey(x), x]));
	const out: InputChange[] = [];
	for (const [k, x] of a) {
		if (!b.has(k)) out.push({ area: 'settings', kind: 'removed', subject: `${noun} ${exclusionLabel(x)}`, text: `${noun} ${exclusionLabel(x)} removed (was: “${x.reason}”)` });
	}
	for (const [k, y] of b) {
		const x = a.get(k);
		const subject = `${noun} ${exclusionLabel(y)}`;
		if (!x) out.push({ area: 'settings', kind: 'added', subject, text: `${subject} added: “${y.reason}”` });
		else if (x.reason !== y.reason) out.push({ area: 'settings', kind: 'changed', subject, text: `${subject}: reason “${x.reason}” → “${y.reason}”` });
	}
	return out;
}

const MODEL_NAME: Record<string, string> = { gr4j: 'GR4J', legacy: 'legacy' };

/** "GR4J fit of 2026-09-24 14:05 UTC (KGE′, seed 1)". */
export function describeFitRecord(r: Pick<FitRecord, 'model' | 'fittedAt' | 'objective' | 'seed' | 'auto'>): string {
	const when = typeof r.fittedAt === 'string' ? r.fittedAt.replace('T', ' ').replace(/:\d{2}(\.\d+)?Z$/, ' UTC') : 'unknown time';
	const objective = (OBJECTIVE_LABELS[r.objective as ObjectiveId] ?? String(r.objective)).replace(/ \([^()]*\)$/, '');
	return `${r.auto ? 'automated ' : ''}${MODEL_NAME[r.model] ?? String(r.model)} fit of ${when} (${objective}, seed ${r.seed}${r.auto ? `, calibration rules revision ${r.auto.rules.revision}` : ''})`;
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
	['damAreaFullM2', 'dam area when full', (v) => (v === null || v === undefined ? 'estimated (capacity ÷ 3 m)' : `${fmtValue(v, 0)} m²`)],
	['damAreaExponent', 'dam area exponent', plain],
	['damSeepagePerDay', 'dam seepage per day', pct],
	['divertCapacityM3Day', 'diversion capacity', withUnit('m³/day', 0)],
	['irrigationEfficiency', 'irrigation efficiency', pct],
	['lossReturnFraction', 'share of losses returning', pct],
	// Other water users (WP-1.33); the monthly demand is diffed month by month below.
	['userReturnPct', 'share returned', pct],
	['userPriority', 'priority', plain],
	// Boreholes (WP-1.34).
	['boreholeCapacityM3Day', 'borehole capacity', withUnit('m³/day', 0)],
	['boreholeRule', 'borehole rule', plain],
	['boreholeTriggerPct', 'borehole drought trigger', pct],
	['streamDepletionFrac', 'stream depletion share', pct],
	['streamDepletionLagDays', 'stream depletion lag', withUnit('days')],
	// Dam storage (WP-3.5); the curve and the monthly release are diffed below.
	['damReleaseRule', 'dam release rule', (v) => (v === 'passInflow' ? 'pass inflow' : v === 'fixed' ? 'fixed' : 'none')],
	['damOutletCapacityM3Day', 'dam outlet capacity', (v) => (v === null || v === undefined ? 'no limit' : `${fmtValue(v, 0)} m³/day`)],
	['damSeepageReturnPct', 'share of dam seepage returning', pct],
	// Development over the run (engine ≥ 1.30.0).
	['damSurveyDate', 'dam survey date', (v) => (v ? String(v) : 'none')],
	['damSedimentPctPerYear', 'dam capacity lost to sediment a year', (v) => (typeof v === 'number' && v > 0 ? pct(v) : 'none')],
	['damInServiceFrom', 'dam in service from', (v) => (v ? String(v) : 'the whole run')],
	['abstractionFrom', 'abstracts from', (v) => (v ? String(v) : 'the whole run')],
	// Supply rule and river pump (WP-3.8).
	['supplyRule', 'supply rule', (v) => (SUPPLY_RULE_LABEL as Record<string, string>)[String(v)] ?? String(v)],
	['pumpCapacityM3Day', 'river pump capacity', (v) => (v === null || v === undefined ? 'no limit' : `${fmtValue(v, 0)} m³/day`)],
	['supplyTriggerPct', 'supply switch-to-river level', pct],
	['supplyStopPct', 'supply switch-back level', pct],
	// Hands-off flow (engine ≥ 1.32.0); its monthly amounts and River to dam by month are diffed below.
	['handsOffEwr', 'hands-off keeps the EWR', (v) => (v === true ? 'yes' : 'no')],
	// EWR site flag (engine ≥ 1.5.0), gauges; the site list as a whole is diffed below.
	['ewrSite', 'EWR site', (v) => (v === false ? 'no' : 'yes')],
	// GN 538 property area and Table 2 rate (engine ≥ 1.12.0), context for the groundwater tables.
	['gaPropertyAreaHa', 'GN 538 property area', (v) => (v === null || v === undefined ? 'not set' : `${fmtValue(v)} ha`)],
	['gaRateM3HaYear', 'GN 538 rate', (v) => (v === null || v === undefined ? 'not set' : `${fmtValue(v, 0)} m³/ha/a`)]
];

/**
 * The EWR site list (engine ≥ 1.5.0), when it differs: one line naming the
 * sites in each run, with what was added and removed and why. Nodes are
 * paired as the node diff pairs them (by id, then by name).
 */
function diffEwrSites(a: readonly NetworkNode[], b: readonly NetworkNode[], nodes: { pairs: [NetworkNode, NetworkNode][]; onlyA: NetworkNode[]; onlyB: NetworkNode[] }): InputChange[] {
	const kindName = (k: NetworkNode['kind']) => (k === 'user' ? 'water user' : k);
	const name = (n: NetworkNode) => (n.downstreamNodeId === null ? `${n.name} (outlet)` : n.name);
	const added: string[] = nodes.onlyB.filter(isEwrSite).map((n) => `${name(n)} (new node)`);
	const removed: string[] = nodes.onlyA.filter(isEwrSite).map((n) => `${name(n)} (node removed)`);
	for (const [x, y] of nodes.pairs) {
		const sx = isEwrSite(x);
		const sy = isEwrSite(y);
		if (sx === sy) continue;
		const why =
			x.kind !== y.kind
				? sy
					? `was a ${kindName(x.kind)}`
					: `now a ${kindName(y.kind)}`
				: x.downstreamNodeId === null || y.downstreamNodeId === null
					? sy
						? 'now the outlet'
						: 'no longer the outlet'
					: sy
						? 'marked as an EWR site'
						: 'taken off the EWR sites';
		(sy ? added : removed).push(`${name(sy ? y : x)} (${why})`);
	}
	if (!added.length && !removed.length) return [];
	const list = (l: readonly NetworkNode[]) => {
		const sites = l.filter(isEwrSite).sort((x, y) => (x.downstreamNodeId === null ? -1 : y.downstreamNodeId === null ? 1 : x.name.localeCompare(y.name)));
		return sites.length ? sites.map(name).join(', ') : 'none';
	};
	const parts = [...(added.length ? [`added ${added.join(', ')}`] : []), ...(removed.length ? [`removed ${removed.join(', ')}`] : [])];
	return [{ area: 'network', kind: 'changed', subject: 'EWR sites', text: `EWR sites: ${list(a)} → ${list(b)} (${parts.join('; ')})` }];
}

const ha = (m2: number) => `${fmtValue(m2 / 10_000, 2)} ha`;

function diffModel(ma: ProjectModel | undefined, mb: ProjectModel | undefined): InputChange[] {
	// A run saved by an older engine is compared as migration 006 stored its model (return flow % → efficiency).
	const a: ProjectModel = upgradeLegacyModel({ nodes: [], crops: [], cropAreas: [], transfers: [], ...(ma ?? {}) });
	const b: ProjectModel = upgradeLegacyModel({ nodes: [], crops: [], cropAreas: [], transfers: [], ...(mb ?? {}) });
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
			text:
				n.kind === 'user'
					? `Other water user "${n.name}" added (${n.userPriority ?? 'senior'}, demand ${fmtValue(meanOf(n.userDemandM3Day), 0)} m³/day on average over the months${into ? `, drains into ${into}` : ''})`
					: `${cap(n.kind)} "${n.name}" added (${fmtValue(n.areaKm2)} km²${dam}${into ? `, drains into ${into}` : ''})`
		});
	}
	for (const [x, y] of nodes.pairs) {
		const parts: string[] = [];
		if (x.name !== y.name) parts.push(`renamed from "${x.name}"`);
		for (const [k, label, fmt] of NODE_FIELDS) {
			if (!same(x[k], y[k])) parts.push(`${label} ${fmt(x[k])} → ${fmt(y[k])}`);
		}
		if (x.kind === 'user' || y.kind === 'user') {
			const d = monthlyChange(x.userDemandM3Day ?? [], y.userDemandM3Day ?? [], 'm³/day');
			if (d) parts.push(`demand ${d}`);
		}
		// Demand factor (engine ≥ 0.41.0, the demand.scale scenario op).
		const df = optionalMonthlyChange(x.demandFactor, y.demandFactor, '×', 'none');
		if (df) parts.push(`demand factor ${df}`);
		// Dam storage (WP-3.5).
		const rel = optionalMonthlyChange(x.damReleaseM3Day, y.damReleaseM3Day, 'm³/day', 'none');
		if (rel) parts.push(`dam release ${rel}`);
		// Operating rules (engine ≥ 1.32.0).
		const ho = optionalMonthlyChange(x.handsOffM3Day, y.handsOffM3Day, 'm³/day', 'none');
		if (ho) parts.push(`hands-off flow ${ho}`);
		const dv = optionalMonthlyChange(x.divertMonthlyM3Day, y.divertMonthlyM3Day, 'm³/day', 'the one diversion capacity');
		if (dv) parts.push(`River to dam by month ${dv}`);
		if (!same(x.damCurve ?? null, y.damCurve ?? null)) {
			const rows = (c: typeof x.damCurve) => (c && c.length ? `${c.length} rows` : 'none (power law)');
			parts.push(`dam survey curve ${rows(x.damCurve)} → ${rows(y.damCurve)}${x.damCurve?.length && y.damCurve?.length ? ' (values changed)' : ''}`);
		}
		const da = na.node(x.downstreamNodeId);
		const db = nb.node(y.downstreamNodeId);
		if (!same(da && nameKey(da), db && nameKey(db))) parts.push(`drains into ${db ?? 'nothing (outflow)'} (was ${da ?? 'nothing (outflow)'})`);
		for (const p of parts) out.push({ area: 'network', kind: 'changed', subject: y.name, text: `${y.name}: ${p}` });
	}

	// --- EWR sites (engine ≥ 1.5.0) ---
	// The outlet and every gauge not taken off the list: a gauge added, removed,
	// turned into a farm or its flag changed moves where the EWR is assessed
	// and who is charged for a shortfall.
	out.push(...diffEwrSites(a.nodes, b.nodes, nodes));

	// --- crops ---
	const crops = matchByIdThenName(a.crops, b.crops, (c) => c.id, (c) => c.name);
	for (const c of crops.onlyA) out.push({ area: 'crops', kind: 'removed', subject: c.name, text: `Crop "${c.name}" removed` });
	for (const c of crops.onlyB) out.push({ area: 'crops', kind: 'added', subject: c.name, text: `Crop "${c.name}" added` });
	for (const [x, y] of crops.pairs) {
		if (x.name !== y.name) out.push({ area: 'crops', kind: 'changed', subject: y.name, text: `Crop "${y.name}" renamed from "${x.name}"` });
		const c = monthlyChange((x as CropDef).cropFactor, (y as CropDef).cropFactor, '');
		if (c) out.push({ area: 'crops', kind: 'changed', subject: y.name, text: `Crop "${y.name}" crop factor: ${c}` });
		// A crop's own irrigation efficiency (engine ≥ 0.43.0); none = the farm's.
		const ea = (x as CropDef).irrigationEfficiency ?? null;
		const eb = (y as CropDef).irrigationEfficiency ?? null;
		const eff = (v: number | null) => (v === null ? "the farm's" : pct(v));
		if (!same(ea, eb)) out.push({ area: 'crops', kind: 'changed', subject: y.name, text: `Crop "${y.name}" irrigation efficiency: ${eff(ea)} → ${eff(eb)}` });
	}

	// --- land cover (WP-1.35), keyed by (farm name, class) so copies line up ---
	{
		const nodeRenameLc = new Map(nodes.pairs.map(([x, y]) => [x.id, y.name] as [string, string]));
		const key = (farm: string, cls: string) => `${nameKey(farm)}\u0000${cls}`;
		// Each group's patches sorted before summing (engine ≥ 1.35.0): the same patches in another order sum to the same
		// floats, and their reductions compare as a set, as the run reads them (resolveLandCover sorts by node and patch id).
		const group = (m: ProjectModel, farmOf: (id: string) => string) => {
			const raw = new Map<string, { farm: string; cls: string; ps: LandCoverPatch[] }>();
			for (const p of m.landCover ?? []) {
				const farm = farmOf(p.nodeId);
				const k = key(farm, p.coverClass);
				const cur = raw.get(k) ?? { farm, cls: p.coverClass, ps: [] };
				cur.ps.push(p);
				raw.set(k, cur);
			}
			const g = new Map<string, { farm: string; cls: string; km2: number; condensed: number; factors: string; patches: string }>();
			for (const [k, { farm, cls, ps }] of raw) {
				const token = (p: LandCoverPatch) => `${p.areaKm2}@${p.densityPct}@${p.factors ? `${p.factors.mar}/${p.factors.lowFlow}` : 'default'}`;
				const sorted = [...ps].sort((x, y) => (token(x) < token(y) ? -1 : token(x) > token(y) ? 1 : 0));
				g.set(k, {
					farm,
					cls,
					km2: sorted.reduce((t, p) => t + p.areaKm2, 0),
					condensed: sorted.reduce((t, p) => t + p.areaKm2 * p.densityPct, 0),
					factors: sorted.map((p) => (p.factors ? `${p.factors.mar}/${p.factors.lowFlow}` : 'default')).join(';'),
					patches: sorted.map((p) => `${p.areaKm2}@${p.densityPct}`).join(';')
				});
			}
			return g;
		};
		const ga = group(a, (id) => nodeRenameLc.get(id) ?? na.node(id) ?? '');
		const gb = group(b, (id) => nb.node(id) ?? '');
		const km2 = (v: number) => `${fmtValue(v, 3)} km²`;
		for (const [k, x] of ga) if (!gb.has(k)) out.push({ area: 'network', kind: 'removed', subject: x.farm, text: `Land cover "${x.cls}" removed from ${x.farm} (was ${km2(x.condensed)} condensed)` });
		for (const [k, y] of gb) {
			const x = ga.get(k);
			if (!x) out.push({ area: 'network', kind: 'added', subject: y.farm, text: `Land cover "${y.cls}" added to ${y.farm} (${km2(y.condensed)} condensed)` });
			// The area on its own too (engine ≥ 1.35.0, landCover.set): a patch at no cover can grow without its condensed area moving.
			// Also a patch's cover on its own (a patch of no area, or two patches that cancel out): the patches changed.
			if (!x) continue;
			const [px, py] = [x.patches, y.patches];
			if (!same(x.condensed, y.condensed) || !same(x.km2, y.km2) || x.factors !== y.factors || px !== py) {
				const area = !same(x.km2, y.km2) ? ` (area ${km2(x.km2)} → ${km2(y.km2)})` : '';
				const cover = !area && same(x.condensed, y.condensed) && px !== py ? ', its patches’ cover changed' : '';
				out.push({
					area: 'network',
					kind: 'changed',
					subject: y.farm,
					text: `${y.farm}: land cover "${y.cls}" ${km2(x.condensed)} → ${km2(y.condensed)} condensed${area}${cover}${x.factors !== y.factors ? ', reductions changed' : ''}`
				});
			}
		}
	}

	// --- individual boreholes (WP-3.9), by id, then by (node name, borehole name) so copies line up ---
	{
		const nodeRenameBh = new Map(nodes.pairs.map(([x, y]) => [x.id, y.name] as [string, string]));
		const ownerA = (bh: Borehole) => nodeRenameBh.get(bh.nodeId) ?? na.node(bh.nodeId) ?? '';
		const ownerB = (bh: Borehole) => nb.node(bh.nodeId) ?? '';
		const bores = matchByIdThenName(a.boreholes ?? [], b.boreholes ?? [], (x) => x.id, (x) => `${(b.boreholes ?? []).includes(x) ? ownerB(x) : ownerA(x)}\u0000${x.name}`);
		const describe = (x: Borehole) =>
			`${fmtValue(x.capacityM3Day, 0)} m³/day, ${x.mode}${x.target === 'dam' ? ' into the dam' : ''}, annual cap ${x.annualCapM3 === null ? 'none' : `${fmtValue(x.annualCapM3, 0)} m³`}, depletion ${fmtValue(x.depletionFactor)}`;
		for (const x of bores.onlyA) out.push({ area: 'network', kind: 'removed', subject: ownerA(x), text: `Borehole "${x.name}" removed from ${ownerA(x)} (was ${describe(x)})` });
		for (const y of bores.onlyB) out.push({ area: 'network', kind: 'added', subject: ownerB(y), text: `Borehole "${y.name}" added to ${ownerB(y)} (${describe(y)})` });
		for (const [x, y] of bores.pairs) {
			const moved = nameKey(ownerA(x)) !== nameKey(ownerB(y));
			const fields = ['name', 'capacityM3Day', 'annualCapM3', 'mode', 'emergencyBelowPct', 'target', 'depletionFactor'] as const;
			if (moved || fields.some((f) => !same(x[f], y[f])))
				out.push({ area: 'network', kind: 'changed', subject: ownerB(y), text: `${ownerB(y)}: borehole "${y.name}" ${describe(x)} → ${describe(y)}${moved ? ` (moved from ${ownerA(x)})` : ''}${x.name !== y.name ? ` (was "${x.name}")` : ''}${x.emergencyBelowPct !== y.emergencyBelowPct ? `, emergency level ${fmtValue(x.emergencyBelowPct)} → ${fmtValue(y.emergencyBelowPct)}` : ''}` });
		}
	}

	// --- demand objects (engine ≥ 1.7.0, issue #54 2b), by id, then by (unit name, object name) so copies line up ---
	{
		const nodeRenameDo = new Map(nodes.pairs.map(([x, y]) => [x.id, y.name] as [string, string]));
		const ownerA = (o: DemandObject) => nodeRenameDo.get(o.nodeId) ?? na.node(o.nodeId) ?? '';
		const ownerB = (o: DemandObject) => nb.node(o.nodeId) ?? '';
		const objs = matchByIdThenName(a.demandObjects ?? [], b.demandObjects ?? [], (x) => x.id, (x) => `${(b.demandObjects ?? []).includes(x) ? ownerB(x) : ownerA(x)}\u0000${x.name}`);
		const size = (x: DemandObject) =>
			x.sizing === 'perUnit'
				? `${fmtValue(x.count ?? 0, 0)} × ${fmtValue(x.litresPerUnitDay ?? 0, 0)} l/day${x.lossPct > 0 ? `, losses ${fmtValue(x.lossPct)}` : ''}`
				: `${fmtValue((x.monthlyM3Day ?? []).reduce((s, v) => s + v, 0) / 12, 0)} m³/day on average`;
		const describe = (x: DemandObject) =>
			`${DEMAND_OBJECT_CATEGORY_LABEL[x.category] ?? x.category}, ${size(x)}, ${x.destination === 'external' ? 'piped out' : `return ${fmtValue(x.returnPct)}`}, priority ${x.priority}${x.schedule?.length ? `, ${x.schedule.length} schedule window${x.schedule.length === 1 ? '' : 's'}` : ''}${x.enabled ? '' : ', off'}`;
		// No schedule, null and an empty one all run the same (engine ≥ 1.17.0). Each window in a fixed
		// key order, since a model read back from jsonb has its keys in Postgres's order, not the editor's.
		const scheduleOf = (x: DemandObject) =>
			x.schedule?.length
				? x.schedule.map((w) => [w.label, w.span, w.from, w.to, w.easterFrom, w.easterTo, w.weekdays, w.factor])
				: null;
		for (const x of objs.onlyA) out.push({ area: 'network', kind: 'removed', subject: ownerA(x), text: `Demand object "${x.name}" removed from ${ownerA(x)} (was ${describe(x)})` });
		for (const y of objs.onlyB) out.push({ area: 'network', kind: 'added', subject: ownerB(y), text: `Demand object "${y.name}" added to ${ownerB(y)} (${describe(y)})` });
		for (const [x, y] of objs.pairs) {
			const moved = nameKey(ownerA(x)) !== nameKey(ownerB(y));
			const fields = ['name', 'category', 'sizing', 'monthlyM3Day', 'count', 'litresPerUnitDay', 'lossPct', 'monthlyFactor', 'returnPct', 'priority', 'destination', 'enabled'] as const;
			const scheduleChanged = !same(scheduleOf(x), scheduleOf(y));
			if (moved || scheduleChanged || fields.some((f) => !same(x[f], y[f])))
				out.push({ area: 'network', kind: 'changed', subject: ownerB(y), text: `${ownerB(y)}: demand object "${y.name}" ${describe(x)} → ${describe(y)}${moved ? ` (moved from ${ownerA(x)})` : ''}${x.name !== y.name ? ` (was "${x.name}")` : ''}${!same(x.monthlyM3Day, y.monthlyM3Day) || !same(x.monthlyFactor, y.monthlyFactor) ? ', monthly values changed' : ''}${scheduleChanged ? ', schedule changed' : ''}` });
		}
	}

	// --- registered volumes (engine ≥ 1.18.0, issue #72), by id, then by (unit name, water source) so copies line up ---
	{
		const nodeRenameAl = new Map(nodes.pairs.map(([x, y]) => [x.id, y.name] as [string, string]));
		const ownerA = (x: AllocationEntry) => (x.nodeId ? (nodeRenameAl.get(x.nodeId) ?? na.node(x.nodeId) ?? 'a unit not in the run') : 'no unit');
		const ownerB = (x: AllocationEntry) => (x.nodeId ? (nb.node(x.nodeId) ?? 'a unit not in the run') : 'no unit');
		const allocs = matchByIdThenName(a.allocations ?? [], b.allocations ?? [], (x) => x.id, (x) => `${(b.allocations ?? []).includes(x) ? ownerB(x) : ownerA(x)}\u0000${x.waterSource}`);
		// Registered storage and the licence conditions (months, the maximum rate) are part of it: a run stores them, so a change is listed.
		const describe = (x: AllocationEntry) =>
			`${x.waterSource} ${fmtValue(x.volumeM3PerYear, 0)} m³/a${x.validFrom || x.validTo ? `, valid ${x.validFrom ?? '…'} to ${x.validTo ?? '…'}` : ''}${x.storageM3 != null ? `, storage ${fmtValue(x.storageM3, 0)} m³` : ''}${x.months?.length ? `, months ${[...x.months].sort((p, q) => p - q).join(' ')}` : ''}${x.maxRateM3s != null ? `, at most ${fmtValue(x.maxRateM3s, 4)} m³/s` : ''}`;
		for (const x of allocs.onlyA) out.push({ area: 'network', kind: 'removed', subject: ownerA(x), text: `Registered volume removed from ${ownerA(x)} (was ${describe(x)})` });
		for (const y of allocs.onlyB) out.push({ area: 'network', kind: 'added', subject: ownerB(y), text: `Registered volume added to ${ownerB(y)} (${describe(y)})` });
		for (const [x, y] of allocs.pairs) {
			const moved = ownerA(x) !== ownerB(y);
			const fields = ['waterSource', 'volumeM3PerYear', 'validFrom', 'validTo', 'storageM3', 'maxRateM3s'] as const;
			const months = (v: AllocationEntry) => (v.months?.length ? [...v.months].sort((p, q) => p - q) : null);
			if (moved || fields.some((f) => !same(x[f] ?? null, y[f] ?? null)) || !same(months(x), months(y)))
				out.push({ area: 'network', kind: 'changed', subject: ownerB(y), text: `${ownerB(y)}: registered volume ${describe(x)} → ${describe(y)}${moved ? ` (moved from ${ownerA(x)})` : ''}` });
		}
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
	// A rule with monthly rates (engine ≥ 1.14.0) is described and compared by its rate in each month.
	const describeTransfer = (t: Transfer) =>
		`${isRiverOfftake(t) ? 'a river off-take, ' : ''}${hasMonthlyRates(t) ? `monthly rates up to ${fmtValue(t.maxRateM3s)} m³/s` : `${fmtValue(t.maxRateM3s)} m³/s`}, ${describeCalendarMonths(t.months)}${t.enabled ? '' : ', disabled'}`;
	// A river off-take's own fields (engine ≥ 1.14.0), compared with a dam transfer's defaults when absent.
	const offtakeParts = (x: Transfer, y: Transfer): string[] => {
		const parts: string[] = [];
		const src = (t: Transfer) => (isRiverOfftake(t) ? 'the river (an off-take)' : 'the source dam');
		if (isRiverOfftake(x) !== isRiverOfftake(y)) parts.push(`takes from ${src(x)} → ${src(y)}`);
		const handsOff = (t: Transfer) => withUnit('m³/day', 0)(t.handsOffM3Day ?? null);
		if ((x.handsOffM3Day ?? null) !== (y.handsOffM3Day ?? null)) parts.push(`hands-off flow ${handsOff(x)} → ${handsOff(y)}`);
		if (!!x.handsOffEwr !== !!y.handsOffEwr) parts.push(y.handsOffEwr ? 'now leaves the EWR in the river' : 'no longer leaves the EWR in the river');
		if ((x.lossPct ?? 0) !== (y.lossPct ?? 0)) parts.push(`conveyance losses ${pct(x.lossPct ?? 0)} → ${pct(y.lossPct ?? 0)}`);
		const sizing = (t: Transfer) => (t.sizing === 'capacity' ? 'up to capacity' : "to the destination's need");
		if ((x.sizing ?? 'demand') !== (y.sizing ?? 'demand')) parts.push(`sized ${sizing(x)} → ${sizing(y)}`);
		if (!!x.topUpDam !== !!y.topUpDam) parts.push(y.topUpDam ? "now tops up the destination's dam" : "no longer tops up the destination's dam");
		return parts;
	};
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
		if (hasMonthlyRates(x) || hasMonthlyRates(y)) {
			const rx = transferRatesM3s(x);
			const ry = transferRatesM3s(y);
			const changed = WY_MONTHS.flatMap((m, k) => (rx[k] !== ry[k] ? [`${m} ${fmtValue(rx[k])} → ${fmtValue(ry[k])}`] : []));
			if (changed.length) parts.push(`max rate by month ${changed.join(', ')} m³/s (0 = off)`);
		} else {
			if (!same(monthSet(x.months), monthSet(y.months))) parts.push(`months ${describeCalendarMonths(x.months)} → ${describeCalendarMonths(y.months)}`);
			if (x.maxRateM3s !== y.maxRateM3s) parts.push(`max rate ${fmtValue(x.maxRateM3s)} → ${fmtValue(y.maxRateM3s)} m³/s`);
		}
		if (x.dailyCapM3 !== y.dailyCapM3) parts.push(`daily cap ${withUnit('m³', 0)(x.dailyCapM3)} → ${withUnit('m³', 0)(y.dailyCapM3)}`);
		if (x.minStoragePct !== y.minStoragePct) parts.push(`minimum source storage ${pct(x.minStoragePct)} → ${pct(y.minStoragePct)}`);
		if (x.priority !== y.priority) parts.push(`priority ${fmtValue(x.priority)} → ${fmtValue(y.priority)}`);
		parts.push(...offtakeParts(x, y));
		for (const p of parts) out.push({ area: 'transfers', kind: 'changed', subject: r, text: `Transfer ${r}: ${p}` });
	}
	return out;
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
/** Mean of a monthly table (0 without one). */
const meanOf = (v: readonly number[] | null | undefined) => (v && v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);

const SERIES_LABELS: Record<string, string> = {
	rain_catchment_mm: 'Rainfall (catchment)',
	rain_chirps_mm: 'Rainfall (CHIRPS)',
	rain_forecast_mm: 'Rainfall (forecast)',
	flow_observed_m3s: 'Observed flow',
	flow_logger_m3s: 'Logger flow',
	flow_reference_m3s: 'Reference gauge (other catchment)',
	evap_apan_mm: 'A-pan evaporation (daily)'
};

/** A run's stored input values by series kind (backend: run_input_series + series_blob), when it has them. */
export type StoredSeriesValues = Partial<Record<string, readonly (number | null)[]>>;

/**
 * The days two versions of a series share, compared value by value: how many
 * differ, and the change in their total over the days both have a number.
 */
export function sharedDaysChange(
	x: { startDate: string; values: readonly (number | null)[] },
	y: { startDate: string; values: readonly (number | null)[] }
): { shared: number; changed: number; first: string; last: string; totalA: number; totalB: number } | null {
	const x0 = toEpochDay(x.startDate);
	const y0 = toEpochDay(y.startDate);
	const from = Math.max(x0, y0);
	const to = Math.min(x0 + x.values.length, y0 + y.values.length) - 1;
	if (to < from) return null;
	let changed = 0;
	let totalA = 0;
	let totalB = 0;
	for (let d = from; d <= to; d++) {
		const va = x.values[d - x0] ?? null;
		const vb = y.values[d - y0] ?? null;
		if (va !== vb) changed++;
		if (va !== null && vb !== null) {
			totalA += va;
			totalB += vb;
		}
	}
	return { shared: to - from + 1, changed, first: fromEpochDay(from), last: fromEpochDay(to), totalA, totalB };
}

function sharedDaysText(label: string, c: NonNullable<ReturnType<typeof sharedDaysChange>>): string {
	const total =
		c.totalA === c.totalB
			? ''
			: c.totalA !== 0
				? `; their total ${c.totalB > c.totalA ? 'rose' : 'fell'} ${fmtValue((Math.abs(c.totalB - c.totalA) / Math.abs(c.totalA)) * 100, 1)}% (${fmtValue(c.totalA)} → ${fmtValue(c.totalB)})`
				: `; their total went from 0 to ${fmtValue(c.totalB)}`;
	return `${label} values changed on ${fmtValue(c.changed, 0)} of the ${fmtValue(c.shared, 0)} days both runs cover (${c.first} to ${c.last})${total}`;
}

/** A series key's label: its kind's, or a gauge node's own record (`<kind>@<node id>`, engine ≥ 1.4.0) named by its gauge. */
function seriesLabel(key: string, nodeName: (id: string) => string): string {
	const g = parseGaugeSeriesKey(key);
	return g ? `${OBSERVED_SERIES_LABEL[g.kind]} at gauge ${nodeName(g.nodeId)}` : (SERIES_LABELS[key] ?? key);
}

function diffSeries(
	sa: RunInputsSnapshot['series'] | undefined,
	sb: RunInputsSnapshot['series'] | undefined,
	values: { a?: StoredSeriesValues; b?: StoredSeriesValues } = {},
	nodeName: (id: string) => string = (id) => id
): InputChange[] {
	const a = sa ?? {};
	const b = sb ?? {};
	const out: InputChange[] = [];
	const range = (s: RunSeriesSnapshot) => {
		const start = toEpochDay(s.startDate);
		return { start: s.startDate, end: fromEpochDay(start + Math.max(0, s.length - 1)), empty: !(s.length > 0) };
	};
	const kinds = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
	for (const k of kinds) {
		const label = seriesLabel(k, nodeName);
		const x = a[k];
		const y = b[k];
		if (x && !y) out.push({ area: 'series', kind: 'removed', subject: label, text: `${label} series removed` });
		else if (!x && y) {
			const r = range(y);
			out.push({ area: 'series', kind: 'added', subject: label, text: `${label} series added (${r.empty ? 'no values' : `${r.start} to ${r.end}`})` });
		} else if (x && y) {
			const ra = range(x);
			const rb = range(y);
			// A different product or version (CHIRPS v2.0 → v3.0): its own line,
			// whatever the dates do, since the values change by an era-dependent
			// factor and any fit made on the old one no longer holds. Only when
			// both runs recorded it: an older run has nothing to compare.
			if (x.provenance !== undefined && y.provenance !== undefined && !sameProvenance(x.provenance, y.provenance)) {
				out.push({
					area: 'series',
					kind: 'changed',
					subject: label,
					text: `${label} is now ${provenanceLabel(y.provenance)} (was ${provenanceLabel(x.provenance)})${k === 'rain_chirps_mm' ? ': the monthly CHIRPS factors are fitted on the new values, and a calibration made on the old ones no longer holds' : ''}`
				});
			}
			// Where the values came from, or the unit they were given in (107_series_source.sql): its own line too. Only when both runs recorded it.
			if (x.origin !== undefined && y.origin !== undefined && !sameOrigin(x.origin, y.origin)) {
				out.push({ area: 'series', kind: 'changed', subject: label, text: `${label} now comes from ${originLabel(y.origin)} (was ${originLabel(x.origin)})` });
			}
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
			// The days both cover: compared value by value when both runs stored
			// their values (021_series_blob), so an edit can't hide behind a date
			// change; else the hash can only speak for identical dates.
			const sameRange = ra.start === rb.start && ra.end === rb.end;
			if (sameRange && x.valuesSha256 && y.valuesSha256 && x.valuesSha256 === y.valuesSha256) continue;
			const va = values.a?.[k];
			const vb = values.b?.[k];
			const shared = va && vb ? sharedDaysChange({ startDate: x.startDate, values: va }, { startDate: y.startDate, values: vb }) : null;
			if (shared) {
				if (shared.changed) out.push({ area: 'series', kind: 'changed', subject: label, text: sharedDaysText(label, shared) });
			} else if (sameRange && x.valuesSha256 && y.valuesSha256) {
				out.push({ area: 'series', kind: 'changed', subject: label, text: `${label} values changed (same dates, ${ra.start} to ${ra.end})` });
			} else if (!sameRange && !(va && vb) && ra.end >= rb.start && rb.end >= ra.start) {
				out.push({
					area: 'series',
					kind: 'changed',
					subject: label,
					text: `${label}: the days both runs cover were not checked for edits (a run from before runs stored their input series)`
				});
			}
		}
	}
	return out;
}

/**
 * Human-readable list of what differs between the inputs of run A and run B:
 * settings, network nodes, crops and crop areas, transfers, and the date range
 * of each driving series. Values edited within the same dates show up through
 * each run's stored values (`values`) on the days both cover, or, without
 * them, through the series' content hash when the dates are the same.
 */
export function diffInputs(
	a: RunInputsSnapshot | null | undefined,
	b: RunInputsSnapshot | null | undefined,
	values: { a?: StoredSeriesValues; b?: StoredSeriesValues } = {}
): InputChange[] {
	// Rule tables name their site by node id: show the node's name (run B's, else A's).
	const names = new Map<string, string>();
	for (const m of [a?.model, b?.model]) for (const n of m?.nodes ?? []) names.set(n.id, n.name);
	const siteName = (id: string | null) => (id === null ? 'the outlet' : (names.get(id) ?? id));
	return [
		...diffModel(a?.model, b?.model),
		...diffSettings(a?.settings, b?.settings, siteName),
		...diffSeries(a?.series, b?.series, values, (id) => names.get(id) ?? id)
	];
}

// ---------------------------------------------------------------------------
// Field history (WP-2.4 UI, docs/api.md § Field history): which input a change
// line is about. The change list stores sentences, not paths; these tables say
// which setting a settings line's subject names and which node field a node
// line's label names, so the backend can count changes per field. Labels only:
// nothing a run computes depends on them.
// ---------------------------------------------------------------------------

/** A settings change's subject → the setting's path (`gr4j.x1`, `calibration.rainThresholdMm`). */
export function settingsChangePaths(): [subject: string, path: string][] {
	const out: [string, string][] = [];
	for (const [k, f] of Object.entries(SETTINGS_FIELDS)) out.push([f.label, k]);
	for (const [k, f] of Object.entries(SETTINGS_MONTHLY)) out.push([f.label, k]);
	out.push(
		['Monthly dam evaporation factors', 'lakeEvapFactorMonthly'],
		['Monthly effective rain fractions', 'effectiveRainFractionMonthly'],
		[PE_LABEL, 'pe'],
		['Hi/lo MAP split', 'hiLoSplit']
	);
	for (const [k, f] of Object.entries(DATA_QUALITY_FIELDS)) out.push([`Data quality ${f.label}`, `dataQuality.${k}`]);
	for (const [k, f] of Object.entries(GR4J_FIELDS)) out.push([`GR4J ${f.label}`, `gr4j.${k}`]);
	for (const [k, f] of Object.entries(CALIBRATION_FIELDS)) out.push([`Calibration ${f.label}`, `calibration.${k}`]);
	out.push(['Flagged zero-rain runs', 'zeroRainRuns.mode'], ['Multi-day rain accumulations', 'zeroRainRuns.accumulationMode']);
	for (const k of GAP_FILL_KINDS) out.push([`Gap filling of the ${gapFillRecordLabel(k)}`, `flowGapFill.${k}`]);
	return out;
}

/** A node change's label (the words after "Name: ") → the node's field. */
export function nodeChangeFields(): [label: string, key: string][] {
	return [
		...NODE_FIELDS.map(([k, label]): [string, string] => [label, String(k)]),
		['demand', 'userDemandM3Day'],
		['demand factor', 'demandFactor'],
		['dam release', 'damReleaseM3Day'],
		// Operating rules (engine ≥ 1.32.0): the monthly rows diffModel words itself.
		['hands-off flow', 'handsOffM3Day'],
		['River to dam by month', 'divertMonthlyM3Day'],
		['dam survey curve', 'damCurve'],
		['drains into', 'downstreamNodeId']
	];
}
