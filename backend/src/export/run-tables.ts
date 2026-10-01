// Pure builders for a run's CSV exports: column order for the daily table and
// the multi-block summary sheet. Unit-tested in run-tables.test.ts.
import {
	demandPctNote,
	DOUBLE_MASS_MIN_DAYS,
	DOUBLE_MASS_MIN_YEARS,
	EQUITABLE_SHARE_FOOTNOTE,
	FARM_COLUMNS as FARM_DAILY_COLUMNS,
	fitPeriodText,
	gapFillRecordLabel,
	provenanceLabel,
	rainSourceFactorOrigin,
	rainSourceFallbackText,
	rainSourceIntensityReferenceText,
	rainSourceKindName,
	rainSourceQuantileMapText,
	chirpsQuantileMapText,
	FLOW_DM_MIN_DAYS,
	FLOW_DM_MIN_YEARS,
	LOW_FLOW_MIN_DAYS,
	LOW_FLOW_WARN_FACTOR,
	RECESSION_MIN_SEGMENTS,
	BFI_MIN_RUN_DAYS,
	BFI_WARN_DIFF,
	FDC_LOW_WARN_PCT,
	HOLDOUT_SKILL_WARN,
	SIGNATURE_MIN_DAYS,
	GAUGE_COLUMNS,
	OBSERVED_FLOW_COLUMNS,
	USER_COLUMNS,
	waterYearLabel,
	describeDroughtRestriction,
	describeRestrictionLevel,
	type CalibrationStats,
	type EwrAgreement,
	type EwrAgreementScores,
	type FdcPercentileRow,
	type FdcPercentileTable,
	type RunSummary,
	type WaterBalanceRow,
	type Wr2012FitStatKey,
	type Wr2012FitStats,
	type Wr2012FlagLevel,
	type Wr2012Scaling
} from '@water-management/engine';
import type { RunEvidence } from '../runs/evidence.js';
import { csvRow } from './csv.js';
import { supplyAssuranceLines } from './supply-assurance.js';

/**
 * Column order for daily exports: the order the engine emits series in
 * (packages/engine/src/run.ts), so the file reads like the workbook sheets.
 * run_series has no ordinal column, so the order lives here; keys the engine
 * adds later go after these, alphabetically. Node and catchment series share
 * some keys (`ewr`, `ewr_shortfall`), hence one order per scope.
 */
const CATCHMENT_ORDER = [
	'natural_flow',
	'simulated_outflow',
	'observed_flow',
	'observed_flow_other',
	// Gap filling (engine ≥ 1.23.0, issue #66): beside the records they fill.
	'observed_flow_fill',
	'observed_flow_filled',
	'observed_flow_other_fill',
	'observed_flow_other_filled',
	// The scored record's per-day quality flags (engine ≥ 1.48.0, CR-18): after the records and their fill.
	'observed_flow_quality',
	'ewr',
	'ewr_shortfall',
	'ewr_charged',
	'ewr_natural',
	'rain_used',
	'rain_final',
	'rain_areal',
	'rain_chirps',
	'rain_chirps_corrected',
	'rain_chirps_mapped',
	'chirps_factor',
	'rain_catchment_missing',
	'rain_catchment_spread',
	'rain_source',
	'is_summer',
	'rain_flow',
	'base_flow',
	'response_flow',
	'resultant_flow'
];
// A farm's columns in FarmTemplate order (F … AB), intermediate ones included
// (engine ≥ 0.12.0), so the file reads left to right like the formulas.
const NODE_ORDER = FARM_DAILY_COLUMNS.map((c) => c.key);
/** The series keys a farm can have, the optional ones included (land cover, boreholes, senior users): what the all-farms export (`farms.csv?key=`) accepts. */
export const FARM_SERIES_KEYS: ReadonlySet<string> = new Set(NODE_ORDER);
const rank = (keys: string[]) => new Map(keys.map((k, i) => [k, i]));
const RANK = { catchment: rank(CATCHMENT_ORDER), node: rank(NODE_ORDER) };

/** Sort comparator for series keys of the catchment or of one node. */
export function seriesKeyOrder(scope: 'catchment' | 'node') {
	const r = RANK[scope];
	return (a: string, b: string): number => {
		const ra = r.get(a) ?? Infinity;
		const rb = r.get(b) ?? Infinity;
		return ra !== rb ? ra - rb : a.localeCompare(b);
	};
}

/**
 * Header of one node daily column: the label, the FarmTemplate (or
 * GaugeTemplate) column letter in brackets, then the unit, e.g.
 * "Irrigation supplied [G] (m³/day)". The summary CSV's column guide gives
 * each letter's formula.
 */
export function nodeColumnHeader(key: string, label: string, unit: string | null | undefined, kind: 'farm' | 'gauge' | 'user'): string {
	const letter = (kind === 'gauge' ? GAUGE_COLUMNS : kind === 'user' ? USER_COLUMNS : FARM_DAILY_COLUMNS).find((c) => c.key === key)?.letter;
	const withLetter = letter ? `${label} [${letter}]` : label;
	return unit ? `${withLetter} (${unit})` : withLetter;
}

export interface SummaryMeta {
	projectName: string;
	runLabel: string;
	engineVersion: string;
	startDate: string;
	endDate: string;
	createdAt: string;
	/** The modeller's written explanation of the run (007_run_notes); '' or absent = none. */
	notes?: string;
	/** When and by whom the notes last changed (ISO timestamp, display name). */
	notesUpdatedAt?: string | null;
	notesUpdatedBy?: string | null;
	/** The run's place in the evidence history (010_run_nomination); null or absent = never nominated. */
	evidence?: RunEvidence | null;
	/** The FDC chart's Q10–Q95 table over the run's catchment flows in m³/s (export/fdc.ts); absent = not loaded. */
	flowDuration?: FdcPercentileTable | null;
	/** The runoff model the run used (settings.runoffModel as the run stored it); absent = not written. */
	runoffModel?: string;
	/** Each farm's dam capacity as the run's model had it, m³ by node id, so storage can be checked against it; absent = no column. */
	damCapacityM3?: Record<string, number>;
	/**
	 * The capacity on the summary's last day of each dam whose capacity changes
	 * over the run (sediment, an in-service date; engine ≥ 1.30.0), m³ by node
	 * id: the dam's end-of-run storage is bounded by it, not by the entered
	 * capacity. Absent or empty = no such dam, no column.
	 */
	damCapacityEndM3?: Record<string, number>;
	/**
	 * The project's node names by id, for the drought restriction rule's dams,
	 * units and EWR site in words (engine ≥ 1.54.0); absent = the summary's
	 * farm names, and an id no name is known for is printed as it is.
	 */
	nodeNames?: Record<string, string>;
}

/**
 * Engine fractions (0–1) are written as percentages, the way the UI and the
 * workbook's Shortfalls sheet show them. Trimmed to 12 significant digits so
 * binary noise (0.07 × 100 = 7.000000000000001) doesn't reach the sheet.
 */
const pct = (v: unknown): unknown => (typeof v === 'number' ? Number((v * 100).toPrecision(12)) : v);
/** Fields converted with `pct` (the engine's own key names). */
const PERCENT_KEYS = new Set(['flowShare', 'fractionSupplied', 'ewrFractionDaysNotMet']);

const FARM_COLUMNS: [key: string, header: string][] = [
	// Engine ≥ 0.27.0; empty on older runs. The share of both the flow (I) and the EWR (Y).
	['flowShare', 'Flow share (%)'],
	['avgCropRequirementM3Day', 'Average crop water requirement (m³/day)'],
	['avgDemandM3Day', 'Average abstraction demand (m³/day)'],
	['avgSuppliedM3Day', 'Average supplied (m³/day)'],
	['avgDeficitM3Day', 'Average deficit (m³/day)'],
	['fractionSupplied', 'Demand supplied (%)'],
	// Engine ≥ 0.17.0: the EWR charge at the EWR sites (audit Q17); older runs: the reach shortfall AB.
	['avgEwrShortfallM3Day', 'Average EWR charge (m³/day charged)'],
	['daysEwrNotMet', 'Days charged for the EWR']
];

/** Farm summary columns only some runs have (a feature's own), labelled when present (WP-1.34). */
const OPTIONAL_FARM_LABELS: Record<string, string> = {
	avgGroundwaterM3Day: 'Average groundwater pumped (m³/day)',
	avgBaseflowDepletionM3Day: 'Average stream depletion (m³/day)',
	avgGroundwaterToDamM3Day: 'Average groundwater pumped into the dam (m³/day)',
	avgRiverAbstractionM3Day: 'Average pumped from the river (m³/day)',
	// Engine ≥ 1.2.0 (issue #55): the dam's storage figures.
	damEndM3: 'Dam storage on the last day (m³)',
	damAgoM3: 'Dam storage 30 days before the last day (m³)',
	damLowM3: 'Lowest dam storage in the last 365 days (m³)',
	damLowDate: 'Date of the lowest dam storage',
	damDaysAtMin: 'Days at or below the minimum operating level in the last 365 days'
};

const CATCHMENT_ROWS: Record<string, string> = {
	meanNaturalFlowM3Day: 'Mean natural flow (m³/day)',
	meanSimulatedOutflowM3Day: 'Mean simulated outflow (m³/day)',
	runoffCoefficient: 'Runoff coefficient (natural flow ÷ rain, as depths over the catchment)',
	ewrDaysNotMet: 'Days EWR not met at the outflow gauge',
	ewrFractionDaysNotMet: 'Days EWR not met at the outflow gauge (%)'
};

const CALIBRATION_ROWS: Record<string, string> = {
	days: 'Days with observed and simulated flow',
	nse: 'NSE',
	pbias: 'PBIAS (%)',
	rmseM3s: 'RMSE (m³/s)',
	meanObservedM3s: 'Mean observed flow (m³/s)',
	meanSimulatedM3s: 'Mean simulated flow (m³/s)',
	// Engine ≥ 0.39.0 (issue #45): only 'fitted' scores are in-sample; notFitted / edited / otherPeriod say why not.
	fitStatus: 'Parameters fitted on these days (fitted = in-sample scores)',
	windowStart: 'Calibration window start',
	windowEnd: 'Calibration window end',
	firstObservedDate: 'First observed day in the window',
	lastObservedDate: 'Last observed day in the window',
	excludedDays: 'Observed days left out by the calibration exclusions',
	kge: 'KGE (Kling–Gupta efficiency)',
	kgeR: 'KGE r (correlation)',
	kgeAlpha: 'KGE α (σ simulated ÷ σ observed)',
	kgeBeta: 'KGE β (mean simulated ÷ mean observed)',
	r2: 'r²',
	logNse: 'log-NSE (NSE on ln(Q + ε))',
	logEpsilonM3s: 'log-NSE ε (m³/s)',
	volumeErrorPct: 'Volume error (%, + = model too wet)',
	flowKind: 'Observed record scored',
	simulatedKey: 'Simulated series scored',
	// Engine ≥ 1.41.0: scored at a gauge inside the network (settings.calibrationSiteNodeId); absent at the outlet.
	siteName: 'Scored at the gauge (calibration site)',
	siteNodeId: 'Calibration site node id'
};

type Cell = string | number | null;
/** Scalars only: nested values (future arrays/objects) are skipped, not stringified. */
const scalar = (v: unknown): Cell | undefined =>
	typeof v === 'number' || typeof v === 'string' || v === null ? v : undefined;

/** Known keys with friendly labels first, then any extra scalar fields under their raw key. */
function labelledRows(obj: Record<string, unknown>, labels: Record<string, string>): [string, Cell][] {
	const out: [string, Cell][] = [];
	for (const [k, label] of Object.entries(labels)) {
		if (k in obj) out.push([label, scalar(PERCENT_KEYS.has(k) ? pct(obj[k]) : obj[k]) ?? null]);
	}
	for (const [k, v] of Object.entries(obj)) {
		const s = scalar(v);
		if (!(k in labels) && s !== undefined) out.push([k, s]);
	}
	return out;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Water-year order (Oct … Sep), as the app's monthly settings and the run warning list them. */
const WY_MONTHS = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const SOURCE_TEXT = { month: 'own month', pooled: 'pooled (all months)', record: 'all ranges (range too thin)' } as const;

/**
 * The 12 CHIRPS bias factors the run applied (model.md §2.4b), one row per
 * calendar month; then (engine ≥ 0.29.0) the fit period, the water years
 * the factors were fitted on and, with listed ranges, each range's factors.
 */
export function* chirpsFactorLines(c: RunSummary['chirpsCorrection']): Generator<string> {
	yield csvRow(['CHIRPS bias correction']);
	if (c === undefined) {
		yield csvRow(['Run made before engine 0.7.0: CHIRPS used as uploaded']);
		return;
	}
	if (c === null) {
		yield csvRow(['No CHIRPS series — nothing to correct']);
		return;
	}
	if (c.mode === 'none') {
		yield csvRow(["Setting 'none': CHIRPS used as uploaded"]);
		return;
	}
	const header = ['Month', 'Factor applied', 'Source', 'Own factor', 'Clamped', 'Shared days', 'Catchment rain on them (mm)', 'CHIRPS on them (mm)', 'Days CHIRPS filled in'];
	type Fit = NonNullable<RunSummary['chirpsCorrection']>;
	function* monthRows(months: Fit['months'], pooled: Fit['pooled'], fallbackDays: number): Generator<string> {
		for (const m of WY_MONTHS) {
			const f = months[m - 1]!;
			yield csvRow([
				MONTH_NAMES[m - 1]!,
				f.factor,
				f.source ? SOURCE_TEXT[f.source] : 'none (CHIRPS used as uploaded)',
				f.ownFactor,
				f.clamped ? 'yes' : 'no',
				f.days,
				f.catchmentMm,
				f.chirpsMm,
				f.fallbackDays
			]);
		}
		yield csvRow(['Pooled', pooled.factor, 'all months together', pooled.ownFactor, pooled.clamped ? 'yes' : 'no', pooled.days, pooled.catchmentMm, pooled.chirpsMm, fallbackDays]);
	}
	yield csvRow(header);
	yield* monthRows(c.months, c.pooled, c.fallbackDays);
	if (c.excludedWaterYears.length) yield csvRow(['Water years left out of the fit', c.excludedWaterYears.join(' ')]);
	// Engine ≥ 0.18.0: why, and the days left out one by one (absent on older runs).
	if (c.lowVsChirpsYears?.length) yield csvRow(['of which far below CHIRPS', c.lowVsChirpsYears.join(' ')]);
	for (const d of c.doubtfulKeepDry ?? []) {
		yield csvRow(['of which a kept-dry run CHIRPS contradicts', d.waterYears.join(' '), `${d.start} to ${d.end}`, d.days, 'CHIRPS on the kept-dry days (mm)', d.chirpsMm, 'limit (mm)', d.limitMm]);
	}
	if (c.flaggedDaysLeftOut) yield csvRow(['Days of flagged zero runs left out (treated as missing)', c.flaggedDaysLeftOut]);
	if (c.missingDaysLeftOut) yield csvRow(['Days listed as missing left out', c.missingDaysLeftOut]);
	if (c.keptDryDaysInFit) yield csvRow(['Kept-dry days kept in the fit', c.keptDryDaysInFit]);
	// Engine ≥ 1.53.0 (CR-23): the gap map, when it was on.
	if (c.quantileMap) {
		const q = c.quantileMap;
		yield csvRow(['CHIRPS quantile map', chirpsQuantileMapText(q)]);
		yield csvRow(['Month', 'Mapped on', 'Catchment wet days', 'CHIRPS wet days', 'CHIRPS wet-day threshold (mm)']);
		for (const m of WY_MONTHS) {
			const x = q.months[m - 1]!;
			yield csvRow([MONTH_NAMES[m - 1]!, x.basis === 'month' ? 'own month' : x.basis === 'season' ? '3-month season' : 'not mapped (monthly factor alone)', x.catchmentWetDays, x.chirpsWetDays, x.chirpsWetMm]);
		}
		yield csvRow(['Gap days the map changed', q.mappedDays, 'gap days left to the monthly factor alone', q.unmappedDays, 'in a month CHIRPS does not yet cover whole', q.partialMonthDays]);
		yield csvRow(['Gap rain by the monthly factor alone (mm)', q.factorOnlyMm, 'after the map (mm)', q.mappedMm]);
	}

	// Engine ≥ 0.29.0: the fit period and the reference window, then one block per listed range. Absent before: those runs fitted the whole record.
	if (!c.fitPeriod) return;
	const segs = c.fitPeriod.segments;
	const window = (w: typeof c.fitWindow) => (w ? [w.fromWaterYear, w.toWaterYear] : ['no shared days', '']);
	yield csvRow(['Fit period', fitPeriodText(c.fitPeriod)]);
	yield csvRow([segs.length ? 'All ranges together: fitted on water years' : 'Fitted on water years', ...window(c.fitWindow)]);
	if (!segs.length) return;
	yield csvRow(['A range month too thin for its own or its range’s pooled factor takes the all-ranges factor above']);
	if (c.outsideRangeDaysLeftOut) yield csvRow(['Shared days outside the listed fit ranges left out of every fit', c.outsideRangeDaysLeftOut]);
	for (const s of segs) {
		yield csvRow([
			'Fit range',
			s.fromWaterYear,
			s.toWaterYear,
			'reason',
			s.reason,
			'fitted on water years',
			...window(s.fitWindow),
			'fills water years',
			s.fillFrom ?? 'record start',
			s.fillTo ?? 'record end'
		]);
		yield csvRow(header);
		yield* monthRows(s.months, s.pooled, s.fallbackDays);
	}
}

/**
 * The double-mass check of catchment rain against CHIRPS (engine ≥ 0.18.0,
 * model.md §2.10a): whole-record slope, the segments between reported
 * breaks, the breaks, then one row per judged water year.
 */
export function* doubleMassLines(dm: NonNullable<RunSummary['dataQuality']>['doubleMass']): Generator<string> {
	yield csvRow(['Double-mass check: catchment rain vs CHIRPS']);
	if (dm === undefined) {
		yield csvRow(['Run made before engine 0.18.0: no double-mass check']);
		return;
	}
	if (dm === null) {
		yield csvRow([`Not checked: needs catchment rain and CHIRPS with at least ${DOUBLE_MASS_MIN_YEARS} water years of ${DOUBLE_MASS_MIN_DAYS}+ shared days`]);
		return;
	}
	yield csvRow(['Whole-record slope: catchment / CHIRPS (×)', dm.wholeSlope]);
	yield csvRow(['Segment from water year', 'to water year', 'Years', 'Shared days', 'Slope (×)']);
	for (const s of dm.segments) yield csvRow([s.fromWaterYear, s.toWaterYear, s.years, s.days, s.slope]);
	if (dm.breaks.length) {
		yield csvRow(['Break after water year', 'Slope before (×)', 'Slope after (×)', 'Change (%)', 'Pettitt p', 'BIC gain']);
		for (const b of dm.breaks) yield csvRow([b.afterWaterYear, b.slopeBefore, b.slopeAfter, b.change * 100, b.pettittP, b.bicGain]);
	} else {
		yield csvRow(['No break found']);
	}
	yield csvRow(['Water year', 'Shared days', 'Catchment rain (mm)', 'CHIRPS (mm)', 'Ratio (×)', 'Cumulative catchment (mm)', 'Cumulative CHIRPS (mm)', 'Residual (%)']);
	for (const y of dm.years) yield csvRow([y.waterYear, y.days, y.catchmentMm, y.chirpsMm, y.ratio, y.cumCatchmentMm, y.cumChirpsMm, y.residualPct]);
	if (dm.skippedYears.length) yield csvRow(['Water years too short to judge', dm.skippedYears.join(' ')]);
}

type Plausibility = NonNullable<RunSummary['plausibility']>;
const RECORD_TEXT: Record<string, string> = {
	flow_observed_m3s: 'observed gauge',
	flow_logger_m3s: 'logger',
	simulated_outflow: 'simulated outflow',
	natural_flow: 'simulated natural flow'
};
const HINT_TEXT: Record<string, string> = {
	rain: 'the model shows it with the same rain',
	newUse: 'new use upstream (the dry season lost more)',
	gauge: 'the gauge (the wet season lost more, or a rise)',
	unclear: 'unclear'
};
const yesNo = (v: boolean | null) => (v === null ? '' : v ? 'yes' : 'no');

/**
 * The hydrologist plausibility checks (engine ≥ 0.25.0, model.md §2.10d): the
 * dry season, then natural vs observed + abstraction per water year, EWR days
 * by rain source, the double-mass check of observed flow against rain and the
 * dry-season low-flow duration curves, the recession diagnostics (engine ≥
 * 1.19.0), then the first and last of those again at each gauge node with a
 * record of its own (engine ≥ 1.4.0). Unrounded.
 */
export function* plausibilityLines(p: RunSummary['plausibility']): Generator<string> {
	yield csvRow(['Plausibility checks']);
	if (p === undefined) {
		yield csvRow(['Run made before engine 0.25.0: no plausibility checks']);
		return;
	}
	yield csvRow([
		'Dry season (months)',
		p.drySeason ? p.drySeason.months.map((m) => MONTH_NAMES[m - 1]).join(' ') : 'none: no record covers every calendar month',
		p.drySeason ? `lowest mean flow in the ${RECORD_TEXT[p.drySeason.source]}` : ''
	]);
	yield '';
	yield* naturalisedLines(p.naturalised);
	yield '';
	yield* rainSourceLines(p.rainSource);
	yield '';
	yield* flowDoubleMassLines(p.flowDoubleMass);
	yield '';
	yield* lowFlowLines(p.lowFlow);
	yield '';
	yield* recessionLines(p.recession);
	yield '';
	yield* signatureLines(p.signatures);
	// Checks 1 and 4 at each gauge node with a record of its own (engine ≥ 1.4.0), against the simulated flow there.
	for (const g of p.gauges ?? []) {
		yield '';
		yield csvRow([`At gauge ${g.name}`, 'Share of the catchment natural flow above it (%)', pct(g.naturalShare) as Cell]);
		yield* naturalisedLines(g.naturalised);
		yield '';
		yield* lowFlowLines(g.lowFlow);
	}
}

function* naturalisedLines(c: Plausibility['naturalised']): Generator<string> {
	yield csvRow(['Natural flow vs observed flow + net abstraction']);
	if (!c) {
		yield csvRow(['Not checked: the run has no observed flow record']);
		return;
	}
	yield csvRow(['Record', RECORD_TEXT[c.flowKind]]);
	yield csvRow(['Tolerance (% of observed)', pct(c.tolerance) as Cell, 'floor (% of the record mean over the same days)', pct(c.floor) as Cell, 'judged with days ≥', c.minDays]);
	yield csvRow(['Water years judged', c.judgedYears, 'failed', c.failedYears.length]);
	yield csvRow([
		'Water year',
		'Observed days',
		'Natural N (Mm³)',
		'Observed O (Mm³)',
		'Net abstraction A = N − S (Mm³)',
		'of which dams (Mm³)',
		'land cover (Mm³)',
		'use net of returns (Mm³)',
		'O + A (Mm³)',
		'Gap O + A − N (Mm³)',
		'Gap (% of N)',
		'Tolerance (Mm³)',
		'Passed'
	]);
	for (const y of c.years) {
		yield csvRow([
			waterYearText(y.waterYear),
			y.days,
			y.naturalMm3,
			y.observedMm3,
			y.abstractionMm3,
			y.damsMm3,
			y.landCoverMm3,
			y.useMm3,
			y.naturalisedMm3,
			y.gapMm3,
			y.gapPct,
			y.toleranceMm3,
			y.judged ? yesNo(y.passed) : 'not judged'
		]);
	}
}

function* rainSourceLines(r: Plausibility['rainSource']): Generator<string> {
	yield csvRow(['EWR days not met by rain source']);
	if (!r) {
		yield csvRow(['Not checked: the run has no rainfall series']);
		return;
	}
	yield csvRow(['Group', 'Water years', 'Days', 'Days EWR not met', 'Days EWR not met (%)']);
	yield csvRow(['Good-rain years', r.good.years, r.good.days, r.good.ewrDaysNotMet, pct(r.good.fractionNotMet) as Cell]);
	yield csvRow(['Fallback-rain years', r.fallback.years, r.fallback.days, r.fallback.ewrDaysNotMet, pct(r.fallback.fractionNotMet) as Cell]);
	for (const s of r.reserve) {
		const name = s.isOutlet ? `${s.name} (outlet)` : s.name;
		yield csvRow(['Reserve months met', name, 'good-rain years', s.good.met, 'of', s.good.months, pct(s.good.rate) as Cell, 'fallback-rain years', s.fallback.met, 'of', s.fallback.months, pct(s.fallback.rate) as Cell]);
	}
	yield csvRow(['Water year', 'Days', 'Station days', 'Rain (mm)', 'Fallback rain (mm)', 'Fallback rain (%)', 'Fallback days (%)', 'Fallback year', 'Days EWR not met']);
	for (const y of r.years) {
		yield csvRow([waterYearText(y.waterYear), y.days, y.stationDays, y.rainMm, y.fallbackRainMm, pct(y.fallbackRainShare) as Cell, pct(y.fallbackDayShare) as Cell, yesNo(y.fallback), y.ewrDaysNotMet]);
	}
}

function* flowDoubleMassLines(dm: Plausibility['flowDoubleMass']): Generator<string> {
	yield csvRow(['Double-mass check: observed flow vs rain']);
	if (!dm) {
		yield csvRow([`Not checked: needs an observed flow record, rain and a catchment area, with at least ${FLOW_DM_MIN_YEARS} water years of ${FLOW_DM_MIN_DAYS}+ days with both`]);
		return;
	}
	yield csvRow(['Record', RECORD_TEXT[dm.flowKind]]);
	yield csvRow(['Whole-record slope: observed / rain (runoff ratio)', dm.wholeSlope]);
	yield csvRow(['Segment from water year', 'to water year', 'Years', 'Days', 'Slope']);
	for (const s of dm.segments) yield csvRow([s.fromWaterYear, s.toWaterYear, s.years, s.days, s.slope]);
	if (dm.breaks.length) {
		yield csvRow(['Break after water year', 'Slope before', 'Slope after', 'Change (%)', 'Pettitt p', 'BIC gain', 'Simulated slope before', 'Simulated slope after', 'Beyond the model (%)', 'Dry season beyond the model (%)', 'Wet season beyond the model (%)', 'Points to']);
		for (const b of dm.breaks) {
			yield csvRow([
				b.afterWaterYear,
				b.slopeBefore,
				b.slopeAfter,
				pct(b.change) as Cell,
				b.pettittP,
				b.bicGain,
				b.simulatedSlopeBefore,
				b.simulatedSlopeAfter,
				pct(b.unexplained) as Cell,
				pct(b.unexplainedDry) as Cell,
				pct(b.unexplainedWet) as Cell,
				HINT_TEXT[b.hint] ?? b.hint
			]);
		}
	} else {
		yield csvRow(['No break found']);
	}
	yield csvRow(['Water year', 'Days', 'Rain (mm)', 'Observed (mm)', 'Simulated (mm)', 'Ratio', 'Cumulative rain (mm)', 'Cumulative observed (mm)', 'Cumulative simulated (mm)']);
	for (const y of dm.years) yield csvRow([y.waterYear, y.days, y.rainMm, y.observedMm, y.simulatedMm, y.ratio, y.cumRainMm, y.cumObservedMm, y.cumSimulatedMm]);
	if (dm.skippedYears.length) yield csvRow(['Water years too short to judge', dm.skippedYears.join(' ')]);
}

function* lowFlowLines(lf: Plausibility['lowFlow']): Generator<string> {
	yield csvRow(['Dry-season low-flow duration curves (m³/s)']);
	if (!lf) {
		yield csvRow(['Not computed: no dry season']);
		return;
	}
	yield csvRow(['Runoff model', lf.runoffModel]);
	if (lf.comparison) {
		const c = lf.comparison;
		yield csvRow(['Q90 on the calibration record\'s dry-season days', RECORD_TEXT[c.flowKind], 'days', c.days, 'observed', c.observedQ90M3s, 'simulated', c.simulatedQ90M3s, 'ratio', c.ratio, `within a factor of ${LOW_FLOW_WARN_FACTOR}`, yesNo(c.withinFactor)]);
	}
	if (!lf.curves.length) {
		yield csvRow([`No curve: every source has fewer than ${LOW_FLOW_MIN_DAYS} dry-season days`]);
		return;
	}
	yield csvRow(['Curve', 'On the days of', 'Days', ...lf.points.map((p) => `Q${p}`)]);
	for (const c of lf.curves) yield csvRow([RECORD_TEXT[c.source] ?? c.source, c.pairedWith ? RECORD_TEXT[c.pairedWith] : 'every dry-season day', c.days, ...c.flowsM3s]);
}

/** The recession diagnostics (engine ≥ 1.19.0, model.md §2.10d, CR-13): the settings, both fits and the comparison. */
function* recessionLines(r: Plausibility['recession']): Generator<string> {
	yield csvRow(['Recession diagnostics (−dQ/dt = a·Q^b on rain-free recession segments)']);
	if (r === undefined) {
		yield csvRow(['Run made before engine 1.19.0: no recession diagnostics']);
		return;
	}
	if (r === null) {
		yield csvRow(['Not checked: needs an observed flow record and catchment rain']);
		return;
	}
	const o = r.options;
	yield csvRow([
		'Record',
		RECORD_TEXT[r.flowKind],
		'segments',
		r.segments.length,
		'min. length (days)',
		o.recessionLength,
		'days dropped after the peak',
		o.nStart,
		'allowed rise (m³/s)',
		o.epsM3s,
		'rain threshold (mm/day)',
		o.rainThresholdMm,
		'−dQ/dt method',
		o.dQdtMethod
	]);
	yield csvRow(['Flow', 'a ((m³/s)^(1−b) per day)', 'b', '−dQ/dt ÷ Q at the reference flow (per day)', 'Points', 'Segments']);
	for (const [label, f, rate] of [
		[RECORD_TEXT[r.flowKind], r.observed, r.observedRate],
		['simulated outflow', r.simulated, r.simulatedRate]
	] as const) {
		yield csvRow(f ? [label, f.a, f.b, rate, f.points, f.segments] : [label, 'too few points to fit']);
	}
	yield csvRow(['Reference flow (m³/s)', r.referenceFlowM3s, 'rate ratio (simulated ÷ observed)', r.rateRatio, 'b difference (simulated − observed)', r.bDiff]);
	yield csvRow([
		'Simulated recession agrees (indicative)',
		r.agrees === null ? `not judged (fewer than ${RECESSION_MIN_SEGMENTS} segments, or no observed fit)` : yesNo(r.agrees)
	]);
}

/**
 * The validation signatures (engine ≥ 1.55.0, model.md §2.10d, CR-16): the base-flow index by both filters,
 * the low-flow FDC's slope and biases, and the skill on held-out recession segments, of the scored record.
 */
function* signatureLines(s: Plausibility['signatures']): Generator<string> {
	yield csvRow(['Validation signatures (the scored record against the simulated outflow on the same days)']);
	if (s === undefined) {
		yield csvRow(['Run made before engine 1.55.0: no validation signatures']);
		return;
	}
	if (s === null) {
		yield csvRow(['Not computed: the run has no observed flow record']);
		return;
	}
	yield csvRow(['Record', RECORD_TEXT[s.flowKind], 'at', s.siteName ? `gauge ${s.siteName}` : 'the outlet']);
	const bf = s.baseflow;
	if (!bf) {
		yield csvRow([`Base-flow index: not computed (fewer than ${SIGNATURE_MIN_DAYS} scored days in stretches of ${BFI_MIN_RUN_DAYS}+)`]);
	} else {
		yield csvRow(['Base-flow index', 'Parameters', 'Days', 'Stretches', 'Observed', 'Simulated', 'Difference (simulated − observed)', `Within ±${BFI_WARN_DIFF}`]);
		const h = bf.hughesFilter;
		const e = bf.eckhardtFilter;
		for (const [label, params, p] of [
			['Hughes et al. (2003)', `α ${h.alpha}; β ${h.beta}; ${h.passes} pass${h.passes === 1 ? '' : 'es'}`, bf.hughes],
			['Eckhardt (2005)', `a ${e.a}; BFImax ${e.bfiMax}`, bf.eckhardt]
		] as const) {
			yield csvRow(p ? [label, params, bf.days, bf.runs, p.observed, p.simulated, p.difference, yesNo(Math.abs(p.difference) <= BFI_WARN_DIFF)] : [label, params, bf.days, bf.runs, 'no flow']);
		}
	}
	const f = s.lowFlowFdc;
	if (!f) {
		yield csvRow([`Low-flow FDC: not computed (fewer than ${SIGNATURE_MIN_DAYS} scored days)`]);
	} else {
		const [hi, lo] = f.range;
		yield csvRow([
			'Low-flow FDC',
			'Days',
			`Observed Q${hi} (m³/s)`,
			`Observed Q${lo} (m³/s)`,
			`Simulated Q${hi} (m³/s)`,
			`Simulated Q${lo} (m³/s)`,
			`Observed slope ln(Q${hi}/Q${lo})/${(lo - hi) / 100}`,
			'Simulated slope',
			'Slope bias (%)',
			'%BiasFLV',
			`Within ±${FDC_LOW_WARN_PCT} %`
		]);
		yield csvRow(['', f.days, f.observedQ70M3s, f.observedQ95M3s, f.simulatedQ70M3s, f.simulatedQ95M3s, f.observedSlope, f.simulatedSlope, f.slopeBiasPct, f.lowVolumeBiasPct, yesNo(f.withinLimit)]);
	}
	const r = s.recessionHoldout;
	if (!r) {
		yield csvRow(['Held-out recessions: not computed (no catchment rain)']);
		return;
	}
	yield csvRow([
		'Held-out recessions',
		'Segments',
		'Held out (every nth)',
		'Held out',
		'Days scored',
		'Law a (other segments)',
		'Law b',
		'Skill, simulated',
		'Skill, law',
		'Log RMSE, simulated',
		'Log RMSE, law',
		`Simulated skill ≥ ${HOLDOUT_SKILL_WARN}`
	]);
	yield csvRow([
		'',
		r.segments,
		r.every,
		r.heldOut.length,
		r.days,
		r.law?.a ?? null,
		r.law?.b ?? null,
		r.modelSkill,
		r.lawSkill,
		r.modelLogRmse,
		r.lawLogRmse,
		r.agrees === null ? `not judged (fewer than ${RECESSION_MIN_SEGMENTS} segments)` : yesNo(r.agrees)
	]);
}

/** Catchment rain the run treated as missing (engine ≥ 0.15.0, model.md §2.4c, CR-20), one row per period. */
export function* zeroRainLines(z: RunSummary['zeroRainInfill']): Generator<string> {
	yield csvRow(['Catchment rain treated as missing']);
	if (z === undefined) {
		yield csvRow(['Run made before engine 0.15.0: flagged zero-rain runs ran as recorded (dry)']);
		return;
	}
	if (z === null) {
		yield csvRow(['No catchment rain series']);
		return;
	}
	yield csvRow(['Flagged zero runs', z.mode === 'missing' ? 'treated as missing' : 'run as recorded (dry)']);
	if (z.asRecordedDays > 0) yield csvRow(['Days of flagged runs run as recorded', z.asRecordedDays]);
	if (z.periods.length) {
		yield csvRow(['Start', 'End', 'Source', 'Reason', 'Days set aside', 'Catchment rain recorded (mm)', 'Rain used instead (mm)', 'Days with nothing to fill them']);
		for (const p of z.periods) {
			yield csvRow([p.start, p.end, p.source === 'flagged' ? 'flagged zero run' : 'listed in settings', p.reason ?? '', p.days, p.recordedMm, p.filledMm, p.unfilledDays]);
		}
		yield csvRow(['Total', '', '', '', z.days, z.recordedMm, z.filledMm, z.unfilledDays]);
	} else {
		yield csvRow(['No days set aside']);
	}
	for (const k of z.keptDry) yield csvRow(['Kept as recorded (dry)', k.start, k.end, k.reason, k.days]);
}

/**
 * The observed flow records the run filled (engine ≥ 1.23.0, model.md §2.10i,
 * issue #66), one row per record; nothing at all when no record is filled, so
 * a run that never set it exports as before.
 */
export function* flowGapFillLines(f: RunSummary['flowGapFill']): Generator<string> {
	if (!f?.length) return;
	yield csvRow(['Gaps filled in the observed flow records (in the run only; the stored records are unchanged)']);
	yield csvRow([
		'Record',
		'Interpolated up to (days)',
		'Days interpolated',
		'Donor record',
		'Donor ratio',
		'Shared days',
		'Correlation r',
		'Days from the donor',
		'Days clamped to the record maximum',
		'Donor refused because',
		'Gaps left open',
		'Days left open'
	]);
	for (const s of f) {
		yield csvRow([
			gapFillRecordLabel(s.kind),
			s.spec.interpolateMaxDays,
			s.interpolatedDays,
			s.spec.donor ? gapFillRecordLabel(s.spec.donor) : 'none',
			s.donor?.ratio ?? '',
			s.donor?.overlapDays ?? '',
			s.donor?.correlation ?? '',
			s.donorDays,
			s.clampedDays,
			s.donorRefused ?? '',
			s.openGaps,
			s.openDays
		]);
	}
}

const WY_CALENDAR_MONTHS = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * The rain-source periods (engine ≥ 0.30.0, model.md §2.4e, issue #40 (b)):
 * one row per period with its reason, where its days' rain came from, and
 * its factors (Oct … Sep) with their origin and the fallback.
 */
export function* rainSourceCsvLines(r: RunSummary['rainSource']): Generator<string> {
	yield csvRow(['Rain-source periods']);
	if (r === undefined) {
		yield csvRow(['Run made before engine 0.30.0: the catchment series throughout']);
		return;
	}
	if (r === null || !r.periods.length) {
		yield csvRow(['None: the catchment series throughout']);
		return;
	}
	yield csvRow([
		'Start',
		'End',
		'Series',
		'Reason',
		'Run days',
		'From the series',
		'From CHIRPS',
		'From reanalysis',
		'From forecast',
		'No value',
		'Series rain (mm)',
		'Rain used from it (mm)',
		'Factors',
		'Gaps from'
	]);
	for (const p of r.periods) {
		const series = `${rainSourceKindName(p.series)}${p.seriesProvenance !== undefined ? ` (${provenanceLabel(p.seriesProvenance)})` : ''}`;
		yield csvRow([p.start, p.end, series, p.reason, p.runDays, p.seriesDays, p.chirpsDays, p.reanalysisDays, p.forecastDays, p.noneDays, p.seriesRawMm, p.seriesMm, rainSourceFactorOrigin(p), rainSourceFallbackText(p.fallback)]);
	}
	yield csvRow(['Factor per month', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']);
	for (const p of r.periods) yield csvRow([`${p.start} to ${p.end}`, ...WY_CALENDAR_MONTHS.map((m) => p.factors[m - 1] ?? '')]);
	// The daily-intensity check and the quantile map (engine ≥ 1.21.0, issue #66): absent on older runs.
	const withIntensity = r.periods.filter((p) => p.intensity);
	if (!withIntensity.length) return;
	yield csvRow([
		'Daily intensity',
		'Heavy day (mm)',
		'Reference',
		'Reference heavy-day share (%)',
		'Series × factor heavy-day share (%)',
		'After the quantile map (%)',
		'Band (points)',
		'Differs by more than the band',
		'Quantile map'
	]);
	const pct = (x: number | null | undefined) => (x == null ? '' : x * 100);
	for (const p of withIntensity) {
		const i = p.intensity!;
		yield csvRow([
			`${p.start} to ${p.end}`,
			i.heavyDayMm,
			rainSourceIntensityReferenceText(i.reference),
			pct(i.reference.share),
			pct(i.scaled.share),
			pct(i.mapped?.share),
			i.band * 100,
			i.differs === null ? '' : i.differs ? 'yes' : 'no',
			rainSourceQuantileMapText(p.quantileMap) ?? 'none: the monthly factor alone'
		]);
	}
}

const ACCUMULATION_STATUS: Record<string, string> = {
	spread: 'spread by CHIRPS',
	noChirps: 'left on the reading day (no CHIRPS rain)',
	asRecorded: 'run as recorded',
	kept: 'kept as recorded (settings)',
	noReading: 'nothing to spread'
};

/** Multi-day accumulations in the catchment rain (engine ≥ 0.20.0, model.md §2.4d, audit B4), one row per window. */
export function* accumulationLines(a: RunSummary['rainAccumulation']): Generator<string> {
	yield csvRow(['Multi-day rain accumulations']);
	if (a === undefined) {
		yield csvRow(['Run made before engine 0.20.0: accumulations ran as recorded']);
		return;
	}
	if (a === null) {
		yield csvRow(['No catchment rain series']);
		return;
	}
	yield csvRow(['Accumulations', a.mode === 'spread' ? 'spread over the days they cover' : 'run as recorded']);
	const c = a.criteria;
	yield csvRow([
		'Detected when',
		`reading ≥ ${c.minMm} mm after ≥ ${c.minRunDays} days of 0 or blank; CHIRPS ±1 day < ${c.readingDayShare * 100} % of it; CHIRPS over the run ≥ ${c.runShare * 100} % of it; window ≤ ${c.maxRunDays} days + the reading day`
	]);
	if (a.windows.length) {
		yield csvRow([
			'Start',
			'End (reading day)',
			'Source',
			'Reason',
			'What the run did',
			'Days in the run',
			'Recorded total (mm)',
			'Reading (mm)',
			'Zero or blank days before',
			'CHIRPS around the reading (mm)',
			'CHIRPS over the run (mm)',
			'CHIRPS over the window (mm)',
			'Rain used from it (mm)'
		]);
		for (const w of a.windows) {
			yield csvRow([
				w.start,
				w.end,
				w.source === 'detected' ? 'detected' : 'listed in settings',
				w.reason ?? w.keptReason ?? '',
				ACCUMULATION_STATUS[w.status] ?? w.status,
				w.daysInRun,
				w.totalMm,
				w.readingMm,
				w.runDays,
				w.nearChirpsMm,
				w.runChirpsMm,
				w.chirpsMm,
				w.usedMm
			]);
		}
		yield csvRow(['Windows spread', a.spreadWindows]);
		yield csvRow(['Run days from a window', a.spreadDays]);
		yield csvRow(['Rain on them (mm)', a.spreadMm]);
	} else {
		yield csvRow(['None detected or listed']);
	}
	for (const x of a.skipped) yield csvRow([x]);
}

/**
 * Whether the run is the project's nominated evidence run (010_run_nomination):
 * always a status row, then this run's nomination (when, who, why) and, for a
 * replaced one, what replaced it (another run, or a withdrawal: 098). A reader of the sheet alone can tell a run
 * the project stands behind from one it has moved away from.
 */
export function* evidenceLines(e: RunEvidence | null): Generator<string> {
	if (!e) {
		yield csvRow(['Evidence nomination', 'not nominated']);
		return;
	}
	const after = e.replacedBy;
	yield csvRow(['Evidence nomination', e.status === 'current' ? 'the nominated evidence run' : after?.withdrawn ? 'nominated before, since withdrawn' : 'nominated before, since replaced']);
	yield csvRow(['Nominated', e.nominatedAt, e.nominatedBy ?? '', e.reason]);
	if (after?.withdrawn) yield csvRow(['Withdrawn', after.nominatedAt, after.nominatedBy ?? '', after.reason]);
	else if (after) yield csvRow(['Replaced by', after.runLabel || 'Untitled run', after.nominatedAt, after.nominatedBy ?? '', after.reason]);
}

/**
 * The run summary as one CSV sheet of blocks separated by a blank line: run
 * details, the per-farm table, the catchment figures, the curtailment and EWR
 * site tables, Reserve compliance, the CHIRPS bias factors,
 * the catchment rain treated as missing, the multi-day accumulations, the
 * double-mass check, calibration,
 * the WR2012 check, the column guide, warnings. The run details carry the run notes.
 * Fields the engine adds to the summary later still appear (under their key).
 */
/**
 * A forecast run's forecast days (WP-2.12, summary.forecast): kept out of
 * every other block of the sheet, which covers the days before them.
 */
export function* forecastLines(f: NonNullable<RunSummary['forecast']>): Generator<string> {
	yield csvRow(['Forecast days (modelled on forecast rain, not recorded rain; every other figure in this sheet covers the days before them)']);
	yield csvRow(['First forecast day', f.from]);
	yield csvRow(['Last forecast day', f.to]);
	yield csvRow(['Days', f.days]);
	yield csvRow(['Last observed rain', f.lastObserved]);
	yield csvRow(['Forecast rain (mm)', f.rainMm]);
	yield csvRow(['Outlet EWR days at risk', f.outletEwrDaysAtRisk]);
	yield csvRow(['Farm', 'Lowest dam level (%)', 'Days short', 'Demand (m³)', 'Supplied (m³)', 'Supplied (% of demand)']);
	for (const p of f.perFarm) {
		yield csvRow([
			p.name,
			p.minDamPct === null ? null : p.minDamPct * 100,
			p.deficitDays,
			p.demandM3,
			p.suppliedM3,
			p.suppliedFraction === null ? null : p.suppliedFraction * 100
		]);
	}
}

export function* summaryCsvLines(meta: SummaryMeta, summary: RunSummary): Generator<string> {
	yield csvRow(['Project', meta.projectName]);
	yield csvRow(['Run', meta.runLabel]);
	yield csvRow(['Run created', meta.createdAt]);
	yield csvRow(['Engine version', meta.engineVersion]);
	if (meta.runoffModel) yield csvRow(['Runoff model', meta.runoffModel]);
	yield csvRow(['Period start', meta.startDate]);
	yield csvRow(['Period end', meta.endDate]);
	// Always written, so the row is there (empty) for a reader looking for it.
	yield csvRow(['Run notes', meta.notes ?? '']);
	if (meta.notes && meta.notesUpdatedAt) yield csvRow(['Notes last changed', meta.notesUpdatedAt, meta.notesUpdatedBy ?? '']);
	yield* evidenceLines(meta.evidence ?? null);
	yield '';

	yield* verificationLines(summary.verification);
	yield '';

	yield csvRow(['Farm summary']);
	const farms = summary.farms as unknown as Record<string, unknown>[];
	const known = new Set(['nodeId', 'name', ...FARM_COLUMNS.map(([k]) => k)]);
	const extra = [...new Set(farms.flatMap((f) => Object.keys(f)))].filter(
		(k) => !known.has(k) && farms.some((f) => scalar(f[k]) !== undefined)
	);
	// The dam's capacity beside its storage figures, so "storage stays within the dam" can be checked from this sheet.
	const capacity = meta.damCapacityM3;
	// A dam whose capacity changes over the run (sediment, an in-service date) is bounded by the day's capacity.
	const endCapacity = capacity && meta.damCapacityEndM3 && Object.keys(meta.damCapacityEndM3).length ? meta.damCapacityEndM3 : null;
	yield csvRow([
		'Farm',
		...FARM_COLUMNS.map(([, h]) => h),
		...(capacity ? ['Dam capacity (m³)'] : []),
		...(endCapacity ? ['Dam capacity on the last day (m³)'] : []),
		...extra.map((k) => OPTIONAL_FARM_LABELS[k] ?? k)
	]);
	for (const f of farms) {
		const id = String(f.nodeId);
		yield csvRow([
			String(f.name ?? ''),
			...FARM_COLUMNS.map(([k]) => scalar(PERCENT_KEYS.has(k) ? pct(f[k]) : f[k]) ?? null),
			...(capacity ? [capacity[id] ?? null] : []),
			...(endCapacity ? [endCapacity[id] ?? capacity![id] ?? null] : []),
			...extra.map((k) => scalar(f[k]) ?? null)
		]);
	}
	yield '';

	yield csvRow(['Catchment']);
	for (const row of labelledRows(summary.catchment as unknown as Record<string, unknown>, CATCHMENT_ROWS)) yield csvRow(row);
	if (summary.catchment.ewrAgreement) yield* ewrAgreementLines(summary.catchment.ewrAgreement);
	// Engine ≥ 1.41.0: the same test at each gauge EWR site with a record of its own.
	for (const site of summary.catchment.ewrAgreementSites ?? []) {
		yield* ewrAgreementLines(site.agreement, `EWR test at ${site.name}: its ${RECORD_TEXT[site.flowKind]} vs the simulated flow there and its own EWR, on the days with an observation`);
	}
	yield '';

	if (summary.forecast) {
		yield* forecastLines(summary.forecast);
		yield '';
	}

	yield* curtailmentLines(summary.curtailment);
	if (summary.landCover) {
		yield '';
		yield* landCoverLines(summary.landCover);
	}
	if (summary.groundwaterAnnualUse?.length) {
		yield '';
		yield* groundwaterAnnualLines(summary.groundwaterAnnualUse);
	}
	if (summary.allocations?.mode === 'cap') {
		yield '';
		yield* allocationCapLines(summary.allocations);
	}
	if (summary.droughtRestriction) {
		yield '';
		const names = new Map<string, string>([...summary.farms.map((f) => [f.nodeId, f.name] as [string, string]), ...Object.entries(meta.nodeNames ?? {})]);
		yield* droughtRestrictionLines(summary.droughtRestriction, (id) => names.get(id) ?? id);
	}
	if (summary.users?.length || summary.curtailment?.otherUsers?.length) {
		yield '';
		yield* otherUserLines(summary);
	}
	if (summary.farms?.some((f) => f.demandObjects?.length)) {
		yield '';
		yield* demandObjectLines(summary);
	}
	yield '';

	yield* ewrSiteLines(summary.curtailment);
	yield '';

	yield* ewrAssuranceLines(summary.ewrAssurance);
	yield '';

	yield* waterBalanceLines(summary.waterBalance);
	yield '';

	yield* supplyAssuranceLines(summary.supplyAssurance);
	yield '';

	yield* chirpsFactorLines(summary.chirpsCorrection);
	yield '';

	yield* zeroRainLines(summary.zeroRainInfill);
	yield '';

	// Only on a run that filled a record (engine ≥ 1.23.0): other exports are unchanged.
	if (summary.flowGapFill?.length) {
		yield* flowGapFillLines(summary.flowGapFill);
		yield '';
	}

	yield* rainSourceCsvLines(summary.rainSource);
	yield '';

	yield* accumulationLines(summary.rainAccumulation);
	yield '';

	yield* doubleMassLines(summary.dataQuality ? summary.dataQuality.doubleMass : undefined);
	yield '';

	yield* plausibilityLines(summary.plausibility);
	yield '';

	yield csvRow(['Calibration (outflow gauge vs observed)']);
	if (summary.calibration) {
		// The WR2012 table is a list of its own (calibrationDetailLines), not a scalar row, even when null.
		const { wr2012Fit: _wr2012Fit, ...calibrationScalars } = summary.calibration;
		for (const row of labelledRows(calibrationScalars as unknown as Record<string, unknown>, CALIBRATION_ROWS)) {
			yield csvRow(row);
		}
		yield* calibrationDetailLines(summary.calibration);
	} else {
		yield csvRow(['No observed flow series — calibration not computed']);
	}
	yield '';

	if (meta.flowDuration !== undefined) {
		yield* flowDurationLines(meta.flowDuration);
		yield '';
	}

	yield* wr2012Lines(summary.wr2012, meta.notes ?? '');
	yield '';

	yield* columnGuideLines();

	if (summary.warnings.length) {
		yield '';
		yield csvRow(['Warnings']);
		for (const w of summary.warnings) yield csvRow([w]);
	}
}

/**
 * An EWR charge or shortfall the engine keeps ≤ 0 (the workbook's sign), as
 * the positive volume charged: one convention across the UI and every export
 * (issue #45). Absent (older runs) stays empty.
 */
const charged = (v: number | null | undefined): Cell => (v == null ? null : 0 - v);

type Curtailment = NonNullable<RunSummary['curtailment']>;
type CurtailmentRow = Curtailment['farms'][number];

/** The curtailment table's columns (model.md §2.11), workbook letter in brackets where it has one. Unrounded. */
const CURTAILMENT_COLUMNS: [header: string, value: (f: CurtailmentRow, siteName: (id: string) => string) => Cell][] = [
	['Average demand [H] (m³/day)', (f) => f.demandM3Day],
	['Average supplied [I] (m³/day)', (f) => f.suppliedM3Day],
	['Deficit [J] (m³/day)', (f) => f.deficitM3Day],
	['Supplied [K] (% of demand)', (f) => pct(f.fractionSupplied) as Cell],
	// Q11 (engine ≥ 0.17.0 labels): the equitable share is a fairness benchmark, never water a farm may "gain".
	['Equitable share volume [M] (m³/day)', (f) => f.targetM3Day],
	['Above (−) / below (+) equitable share [N] (m³/day)', (f) => f.reduceGainM3Day],
	['Above (−) / below (+) equitable share [O] (l/s)', (f) => f.reduceGainLs],
	['Equitable share [P] (% of demand)', (f) => pct(f.targetFraction) as Cell],
	// Issue #45: the charge is a volume charged, positive, as in the farm summary and every table
	// (the engine and the workbook keep R ≤ 0 so S = N + R holds; the header says so).
	['EWR charge [R] (m³/day charged; workbook R × −1)', (f) => charged(f.ewrShortfallM3Day)],
	['EWR charge met by irrigating less (m³/day charged)', (f) => charged(f.ewrChargeIrrigationM3Day)],
	['EWR charge met by storing less / passing inflow (m³/day charged)', (f) => charged(f.ewrChargeStorageM3Day)],
	['Supply cut for the EWR (m³/day)', (f) => f.ewrSupplyCutM3Day ?? null],
	['Supply cut for the EWR (l/s)', (f) => f.ewrSupplyCutLs ?? null],
	['EWR site setting the charge', (f, site) => (f.ewrBindingSiteId ? site(f.ewrBindingSiteId) : '')],
	['Total change [S] (m³/day)', (f) => f.totalChangeM3Day],
	['Total change [T] (l/s)', (f) => f.totalChangeLs],
	['Volume left [U] (m³/day)', (f) => f.volumeLeftM3Day],
	['Demand left [V] (%)', (f) => pct(f.fractionOfDemandLeft) as Cell],
	// Why V is empty or not meaningful (audit Q13): no_demand | below_floor (demand under DEMAND_PCT_FLOOR_M3_DAY) | empty.
	['demand_pct_note', (f) => demandPctNote(f.demandM3Day)],
	['EWR cut beyond equitable share (m³/day)', (f) => f.ewrCutBeyondShareM3Day ?? null]
];

/**
 * The curtailment report over its reporting window (model.md §2.11), one row
 * per farm plus the totals, every number unrounded. From engine 0.17.0 the
 * EWR column is the farm's charge at the EWR sites (audit Q17), a header
 * row names the rule, and the fixed footnote closes the table (Q11).
 */
export function* curtailmentLines(c: RunSummary['curtailment']): Generator<string> {
	yield csvRow(['Curtailment targets']);
	if (!c) {
		yield csvRow(['Run made before engine 0.3.0: no curtailment report. Run it again to see it.']);
		return;
	}
	yield csvRow(['Reporting window', c.reportStart, c.reportEnd, `${c.days} days`]);
	yield csvRow(['Equitable share of supply (fairness benchmark) [K total] (%)', pct(c.equitableFraction) as Cell]);
	yield csvRow([
		'EWR attribution',
		c.ewrAttribution === 'netImpactProRata'
			? `net impact pro rata (Q17), sites: outlet + gauges (${(c.ewrSites ?? []).length})`
			: 'run made before engine 0.17.0: incremental shortfall (workbook AB)'
	]);
	const names = new Map((c.ewrSites ?? []).map((s) => [s.nodeId, s.name]));
	for (const f of c.farms) if (!names.has(f.nodeId)) names.set(f.nodeId, f.name);
	const site = (id: string) => names.get(id) ?? id;
	// The basic-needs floor (engine ≥ 1.44.0, issue #123): two columns at the end, only when a farm has one.
	const floor = c.farms.some((f) => f.basicNeedsM3Day !== undefined);
	const floorHeaders = floor ? ['Basic-needs floor (m³/day)', 'Held back of the cut for basic needs (m³/day)'] : [];
	const floorCells = (f: CurtailmentRow): Cell[] => (floor ? [f.basicNeedsM3Day ?? null, f.basicNeedsHeldM3Day ?? null] : []);
	yield csvRow(['Farm', ...CURTAILMENT_COLUMNS.map(([h]) => h), ...floorHeaders]);
	for (const f of c.farms) yield csvRow([f.name, ...CURTAILMENT_COLUMNS.map(([, v]) => v(f, site)), ...floorCells(f)]);
	const t = c.totals;
	yield csvRow([
		'Total',
		t.demandM3Day,
		t.suppliedM3Day,
		t.deficitM3Day,
		pct(c.equitableFraction) as Cell,
		t.targetM3Day,
		t.reduceGainM3Day,
		t.reduceGainLs,
		'',
		charged(t.ewrShortfallM3Day),
		charged(t.ewrChargeIrrigationM3Day),
		charged(t.ewrChargeStorageM3Day),
		t.ewrSupplyCutM3Day ?? null,
		'',
		'',
		t.totalChangeM3Day,
		'',
		t.volumeLeftM3Day,
		'',
		'',
		t.ewrCutBeyondShareM3Day ?? null,
		...(floor ? [t.basicNeedsM3Day ?? null, t.basicNeedsHeldM3Day ?? null] : [])
	]);
	yield csvRow([EQUITABLE_SHARE_FOOTNOTE]);
}

/** Each EWR site over the reporting window (engine ≥ 0.17.0, audit Q17): charged + natural = shortfall. */
export function* ewrSiteLines(c: RunSummary['curtailment']): Generator<string> {
	yield csvRow(['EWR sites (reporting window)']);
	if (!c?.ewrSites) {
		yield csvRow(['Run made before engine 0.17.0: the EWR was assessed farm by farm (workbook AB), not at sites.']);
		return;
	}
	yield csvRow(['Site', 'Outlet', 'Farms upstream', 'Days not met', 'Average shortfall (m³/day, positive)', 'Charged to farms (m³/day, positive)', 'Natural (m³/day, positive)']);
	for (const s of c.ewrSites) yield csvRow([s.name, s.isOutlet ? 'yes' : 'no', s.farmCount, s.daysNotMet, charged(s.shortfallM3Day), charged(s.chargedM3Day), charged(s.naturalM3Day)]);
}

const RULE_UNIT_TEXT = { mcm: 'Mm³ per month', m3s: 'm³/s (mean over the month)' } as const;
const RULE_UNIT_SHORT = { mcm: 'Mm³', m3s: 'm³/s' } as const;

/**
 * Monthly compliance with the Reserve's assurance rules at each EWR site with
 * a rule table (engine ≥ 0.21.0, model.md §2.9c): the table's provenance and
 * method, the headline (months met), the deficit and contiguity, the FDC
 * check, then per month of the year and month by month. Flows are in the
 * table's unit; deficits in m³.
 */
export function* ewrAssuranceLines(sites: RunSummary['ewrAssurance']): Generator<string> {
	yield csvRow(['Reserve compliance by month (EWR rule tables)']);
	if (!sites?.length) {
		yield csvRow(['Not assessed: no EWR rule table in the settings the run used (or a run made before engine 0.21.0)']);
		return;
	}
	for (const [i, r] of sites.entries()) {
		if (i > 0) yield '';
		const u = RULE_UNIT_SHORT[r.unit];
		yield csvRow(['Site', r.name, r.isOutlet ? 'outlet' : 'gauge']);
		yield csvRow(['Source', r.source]);
		yield csvRow(['Covers', r.component === 'total' ? 'total flow (low and high flows)' : 'low flows only']);
		yield csvRow(['Unit', RULE_UNIT_TEXT[r.unit]]);
		yield csvRow(['Natural-flow percentile from', r.naturalSource === 'run' ? "the run's simulated natural flow at the site" : "the table's natural flows"]);
		yield csvRow(['Scale applied to the table', r.scale]);
		yield csvRow(['% points', ...r.points]);
		// Engine ≥ 1.11.0 (model.md §2.9c): the run's natural MAR against the determination's, only when the table records one.
		if (r.naturalMar) yield csvRow(['Natural MAR (Mm³/a): run', r.naturalMar.runMcm, 'determination', r.naturalMar.tableMcm, 'Difference (%)', r.naturalMar.differencePct]);
		const o = r.overall;
		yield csvRow(['Months met', o.met, 'of', o.months, 'Met (%)', pct(o.rate) as Cell]);
		yield csvRow(['Deficit over the run (m³)', o.deficitM3]);
		yield csvRow(['Longest run of months not met', o.longestNotMetRun]);
		yield csvRow(['Mean shortfall in months not met (% of required)', o.meanShortfallPct]);
		yield csvRow(['FDC check: month × % point cells met', r.fdc.met, 'of', r.fdc.cells, 'Met (%)', pct(r.fdc.rate) as Cell]);
		// Engine ≥ 1.19.0 (model.md §2.9c, CR-29): daily compliance and the EWR as %nMAR, only on runs that have them.
		if (r.daily)
			yield csvRow(['From daily data: days below the day\'s requirement', r.daily.daysNotMet, 'of', r.daily.days, 'Time not met (%)', pct(r.daily.timeNotMet) as Cell, 'Volume not met (%)', pct(r.daily.volumeNotMet) as Cell]);
		if (r.ewrPctNmar) {
			const e = r.ewrPctNmar;
			yield csvRow(['EWR as % of natural MAR', e.pct, 'EWR (Mm³/a)', e.ewrMcm, 'Natural MAR at the site (Mm³/a)', e.naturalMarMcm]);
			if (e.lowFlowMcm !== undefined) yield csvRow(['Low flows as % of natural MAR', e.lowFlowPct ?? null, 'Low flows (Mm³/a)', e.lowFlowMcm]);
		}
		// Engine ≥ 0.33.0 (model.md §2.9d): the low flows of a total table, as extra lines and columns only when the table has them.
		const low = r.lowFlow;
		if (low) {
			yield csvRow(['Low flows: months met', low.met, 'of', low.months, 'Met (%)', pct(low.rate) as Cell]);
			yield csvRow(['Low flows: deficit over the run (m³)', low.deficitM3]);
			yield csvRow(['Low flows: longest run of months not met', low.longestNotMetRun]);
		}
		yield csvRow(['Month', 'Complete years', 'Months met', 'Met (%)', 'Deficit (m³)', `Mean required (${u})`, `Mean simulated (${u})`, 'FDC points met', ...(low ? ['Low flows met (%)'] : [])]);
		for (const m of r.byMonth) {
			const fdcMet = m.fdc.filter((f) => f.met).length;
			yield csvRow([
				MONTH_NAMES[m.month - 1]!,
				m.years,
				m.met,
				pct(m.rate) as Cell,
				m.deficitM3,
				m.meanRequired,
				m.meanActual,
				m.years ? `${fdcMet} of ${m.fdc.length}` : '',
				...(low ? [pct(m.lowFlowRate ?? null) as Cell] : [])
			]);
		}
		if (r.byMonth.some((m) => m.daily)) {
			yield csvRow(['Month', 'Days assessed', 'Days not met', 'Time not met (%)', 'Required (m³)', 'Shortfall (m³)', 'Volume not met (%)']);
			for (const m of r.byMonth) {
				const d = m.daily;
				yield csvRow([MONTH_NAMES[m.month - 1]!, d?.days ?? null, d?.daysNotMet ?? null, pct(d?.timeNotMet ?? null) as Cell, d?.requiredM3 ?? null, d?.shortfallM3 ?? null, pct(d?.volumeNotMet ?? null) as Cell]);
			}
		}
		// Engine ≥ 1.19.0 (CR-29): the duration curves at each % point, for the FDC overlay.
		if (r.byMonth.some((m) => m.fdc.some((f) => f.natural !== undefined))) {
			yield csvRow(['Month', '% point', `EWR (${u})`, `Natural flow duration (${u})`, `Simulated flow duration (${u})`, 'Met']);
			for (const m of r.byMonth)
				for (const f of m.fdc) yield csvRow([MONTH_NAMES[m.month - 1]!, f.point, f.required, f.natural ?? null, f.impacted, f.met === null ? '' : f.met ? 'yes' : 'no']);
		}
		yield csvRow([
			'Year',
			'Month',
			'Water year',
			`Natural (${u})`,
			'Natural condition (% exceedance)',
			'Beyond the table',
			`Required (${u})`,
			`Simulated (${u})`,
			'Met',
			'Deficit (m³)',
			...(low ? [`Low flow required (${u})`, 'Low flows met', `High-flow part (${u})`] : [])
		]);
		for (const m of r.months) {
			yield csvRow([
				m.year,
				MONTH_NAMES[m.month - 1]!,
				waterYearText(m.waterYear),
				m.natural,
				m.percentile,
				m.beyond === 'wetter' ? 'wetter than the first point' : m.beyond === 'drier' ? 'drier than the last point' : '',
				m.required,
				m.actual,
				m.met ? 'yes' : 'no',
				m.deficitM3,
				...(low ? [m.requiredLowFlow ?? null, m.lowFlowMet ? 'yes' : 'no', m.requiredHighFlow ?? null] : [])
			]);
		}
		for (const h of r.highFlows ?? []) {
			yield csvRow(['High flow', h.label, 'peaks in', h.months.map((m) => MONTH_NAMES[m - 1]!).join(' '), 'peak (m³/s)', h.peakAppliedM3s, 'event days', h.durationDays, 'per water year', h.perYear]);
			yield csvRow(['Water years met', h.overall.met, 'of', h.overall.required, 'that had it naturally', 'Met (%)', pct(h.overall.rate) as Cell, 'Water years assessed', h.overall.years]);
			yield csvRow(['Water year', 'Natural events', 'Simulated events', 'Required', 'Met']);
			for (const y of h.years) yield csvRow([waterYearText(y.waterYear), y.natural, y.actual, y.required, y.required === 0 ? 'not required' : y.met ? 'yes' : 'no']);
		}
	}
}

const pctCell = (v: number | null | undefined): Cell => (v == null ? null : (pct(v) as number));
const AGREEMENT_HEADER = [
	'Days counted',
	'Both below the EWR',
	'Model below, river not (false alarm)',
	'River below, model not (miss)',
	'Both at or above',
	'Hit rate (%)',
	'False-alarm ratio (%)',
	'Frequency bias (1 = unbiased)',
	'Model days below (%)',
	'Observed days below (%)'
];
const agreementCells = (a: EwrAgreementScores): Cell[] => [
	a.days,
	a.bothBelow,
	a.falseAlarm,
	a.miss,
	a.bothAbove,
	pctCell(a.hitRate),
	pctCell(a.falseAlarmRatio),
	a.frequencyBias,
	pctCell(a.modelFractionBelow),
	pctCell(a.observedFractionBelow)
];

/**
 * The outlet EWR test on the observed record vs the simulated outflow
 * (engine ≥ 0.5.3, issue #4): does the model fail the EWR on the days the
 * river did? The whole record, then each water year.
 */
export function* ewrAgreementLines(a: EwrAgreement, heading = 'Outlet EWR test: observed record vs simulated outflow, on the days with an observation'): Generator<string> {
	yield csvRow([heading]);
	yield csvRow(['Observed days', a.firstObservedDate ?? '', a.lastObservedDate ?? '', `${a.excludedDays} left out by the calibration exclusions`]);
	yield csvRow(['Water year', ...AGREEMENT_HEADER]);
	yield csvRow(['Whole record', ...agreementCells(a.overall)]);
	for (const y of a.byWaterYear) yield csvRow([waterYearText(y.waterYear), ...agreementCells(y)]);
}

/** The calibration's lists: the exclusions it applied and the annual volumes it compared (both skipped by the scalar rows). */
export function* calibrationDetailLines(c: CalibrationStats): Generator<string> {
	if (c.exclusions?.length) {
		yield csvRow(['Calibration exclusions (days not scored)']);
		yield csvRow(['From', 'To', 'Reason']);
		for (const e of c.exclusions) yield csvRow([e.start, e.end, e.reason]);
	}
	if (c.annualVolumes?.length) {
		yield csvRow(['Annual volumes on the observed days (water years, Oct–Sep)']);
		yield csvRow(['Water year', 'Days observed', 'Days in the window', 'Observed (Mm³)', 'Simulated (Mm³)', 'Simulated − observed (%)']);
		for (const y of c.annualVolumes) yield csvRow([waterYearText(y.waterYear), y.days, y.daysInWindow, y.observedMm3, y.simulatedMm3, y.diffPct]);
	}
	if (c.wr2012Fit !== undefined) yield* wr2012FitLines(c.wr2012Fit);
}

const WR2012_FIT_ROW_LABEL: Record<Wr2012FitStatKey, string> = {
	mar: 'MAR (Mm³/a)',
	meanLog: 'Mean of log10 annual flows (log10 Mm³)',
	sd: 'SD of annual flows (Mm³)',
	logSd: 'SD of log10 annual flows (log10 Mm³)',
	seasonalIndex: 'Seasonal index (%)'
};

/**
 * The WR2012 five-statistic table (CR-28, engine ≥ 1.19.0; model.md §2.10):
 * absent on older runs, a line saying why when there is no complete water year.
 */
export function* wr2012FitLines(w: Wr2012FitStats | null): Generator<string> {
	yield csvRow(['WR2012 statistics on monthly flows (complete water years, Oct–Sep)']);
	if (!w) {
		yield csvRow(['Not computed: no water year has all 12 months observed (a month needs 90 % of its days)']);
		return;
	}
	yield csvRow(['Water years', w.waterYears.map(waterYearText).join(' '), 'Years in the log statistics', w.logYears]);
	yield csvRow(['Bands', w.bandsConfirmed ? 'good-fit bands' : 'indicative, to be confirmed against WRC TT 689/16 and TT 690/16']);
	yield csvRow(['Statistic', 'Observed', 'Simulated', 'Simulated − observed (%)', 'Band (|%| below)', 'Within band']);
	for (const x of w.stats)
		yield csvRow([WR2012_FIT_ROW_LABEL[x.key], x.observed, x.simulated, x.diffPct, x.bandPct, x.withinBand === null ? '' : x.withinBand ? 'yes' : 'no']);
}

/** The engine's self-checks on the run (engine ≥ 0.12.0, model.md §6 "Verification"). */
export function* verificationLines(v: RunSummary['verification']): Generator<string> {
	yield csvRow(['Self-checks']);
	if (!v) {
		yield csvRow(['Run made before engine 0.12.0: no self-checks recorded. Run it again to check it.']);
		return;
	}
	yield csvRow(['All passed', v.passed ? 'yes' : 'NO']);
	yield csvRow(['Check', 'Result', 'First problem found']);
	for (const c of v.checks) yield csvRow([c.label, c.passed ? 'passed' : 'FAILED', c.detail ?? '']);
	if (v.maxResidual) {
		yield csvRow(['Largest daily balance check [V] (m³/day)', v.maxResidual.valueM3Day, `${v.maxResidual.name} on ${v.maxResidual.date}`]);
	}
}

/** A column marked optional appears only when some row has it (a term only some networks have, WP-1.33–1.35). */
const BALANCE_COLUMNS: [header: string, value: (r: WaterBalanceRow) => number | null, optional?: true][] = [
	['Days', (r) => r.days],
	['Rain (mm)', (r) => r.rainMm],
	['Natural flow (mm)', (r) => r.naturalFlowMm],
	['Runoff coefficient', (r) => r.runoffCoefficient],
	['Actual evaporation (mm)', (r) => r.runoff?.aetMm ?? null],
	['Groundwater exchange (mm)', (r) => r.runoff?.exchangeMm ?? null],
	['Change in runoff-model storage (mm)', (r) => r.runoff?.storageChangeMm ?? null],
	['Runoff-model residual (mm)', (r) => r.runoff?.residualMm ?? null],
	['Natural flow (m³)', (r) => r.naturalFlowM3],
	['Farm runoff (m³)', (r) => r.farmRunoffM3],
	['Dam storage at start (m³)', (r) => r.openingStorageM3],
	['Irrigation abstraction demand (m³)', (r) => r.demandM3],
	['Irrigation supplied (m³)', (r) => r.suppliedM3],
	['Return flow (m³)', (r) => r.returnFlowM3],
	['Consumptive use (m³)', (r) => r.consumptiveUseM3],
	['Transfers, net (m³)', (r) => r.transfersM3],
	['Rain on dams (m³)', (r) => r.rainOnDamsM3 ?? null],
	['Dam evaporation (m³)', (r) => r.damEvaporationM3 ?? null],
	['Other users’ use: taken − returned (m³)', (r) => r.otherUseM3 ?? null, true],
	['Groundwater pumped (m³)', (r) => r.groundwaterM3 ?? null, true],
	['Stream depletion from pumping (m³)', (r) => r.streamDepletionM3 ?? null, true],
	['Storage set into (+) / out of (−) the dams by a storage reset (m³)', (r) => r.storageSetM3 ?? null, true],
	['Runoff removed by land cover (m³)', (r) => r.landCoverReductionM3 ?? null, true],
	['Dam seepage lost from the catchment (m³)', (r) => r.damSeepageLostM3 ?? null, true],
	['Released below dams (part of outflow) (m³)', (r) => r.damReleaseM3 ?? null, true],
	['Spill (m³)', (r) => r.spillM3],
	['Outflow (m³)', (r) => r.outflowM3],
	['Dam storage at end (m³)', (r) => r.closingStorageM3],
	['Residual (m³)', (r) => r.residualM3]
];

/** Optional balance terms: [field, gain (in) or loss (out), words]. Land cover and release are memo columns, already in runoff and outflow. */
const OPTIONAL_TERMS: [keyof WaterBalanceRow, 'in' | 'out', string][] = [
	['groundwaterM3', 'in', 'groundwater pumped'],
	['storageSetM3', 'in', 'storage set'],
	['otherUseM3', 'out', 'other users’ use'],
	['streamDepletionM3', 'out', 'stream depletion'],
	['damSeepageLostM3', 'out', 'seepage lost']
];

/** The equation the rows close, naming only the terms this run has, so every term in it is a column. */
export function balanceEquation(rows: readonly WaterBalanceRow[]): string {
	const has = (k: keyof WaterBalanceRow) => rows.some((r) => r[k] !== undefined && r[k] !== null);
	const terms = (side: 'in' | 'out') => OPTIONAL_TERMS.filter(([k, s]) => s === side && has(k)).map(([, , w]) => ` + ${w}`).join('');
	return `Start storage + farm runoff + transfers + rain on dams${terms('in')} = consumptive use + dam evaporation${terms('out')} + outflow + end storage + residual`;
}

/**
 * Where the water went, one row per water year and one for the run (engine ≥
 * 0.12.0). The network closes: start storage + farm runoff + transfers +
 * rain on dams = consumptive use + dam evaporation + outflow + end storage +
 * residual (the dam terms from engine 0.16.0; blank on older runs).
 */
export function* waterBalanceLines(wb: RunSummary['waterBalance']): Generator<string> {
	yield csvRow(['Water balance by water year (Oct–Sep)']);
	if (!wb) {
		yield csvRow(['Run made before engine 0.12.0: no water balance recorded. Run it again to see it.']);
		return;
	}
	const rows = [...wb.years, wb.total];
	yield csvRow([`${balanceEquation(rows)}; the residual should be 0`]);
	const cols = BALANCE_COLUMNS.filter(([, f, optional]) => !optional || rows.some((r) => f(r) !== null));
	yield csvRow(['Water year', ...cols.map(([h]) => h)]);
	for (const r of rows) {
		const year = r.waterYear === null ? 'Whole run' : `${r.waterYear}/${String((r.waterYear + 1) % 100).padStart(2, '0')}`;
		yield csvRow([year, ...cols.map(([, f]) => f(r))]);
	}
}

const WR2012_FLAG_TEXT: Record<Wr2012FlagLevel, string> = {
	ok: 'within the note threshold',
	note: 'note the difference',
	query: 'query',
	unusable: 'not usable for EWR findings'
};
const SCALING_TEXT: Record<Wr2012Scaling, string> = { area: 'area ratio', areaRain: 'area and rainfall ratio' };
/** Water year labelled by the calendar year it starts in: 2001 → "2001/02". */
const waterYearText = (y: number) => `${y}/${String((y + 1) % 100).padStart(2, '0')}`;

const FDC_RECORD_LABEL: Record<FdcPercentileRow['record'], string> = { natural: 'Natural', simulated: 'Simulated outflow', observed: 'Observed' };

/**
 * The Runs tab's flow-duration percentile table (issue #45): Q10, Q50, Q90
 * and Q95 of natural flow, simulated outflow and the observed record, in
 * m³/s, from the same engine function the chart's table reads
 * (views/fdc.ts). Every record over the whole run, then, when the observed
 * record misses some of the run's days, natural and simulated ranked on only
 * its days (the chart's default, like with like). Unrounded.
 */
export function* flowDurationLines(t: FdcPercentileTable | null): Generator<string> {
	yield csvRow(['Flow-duration percentiles (flow equalled or exceeded on 10/50/90/95 % of days; Weibull plotting positions)']);
	if (!t || !t.wholeRun.length) {
		yield csvRow(['No catchment flow series stored for this run']);
		return;
	}
	yield csvRow(['Days ranked', 'Flow record', 'Q10 (m³/s)', 'Q50 (m³/s)', 'Q90 (m³/s)', 'Q95 (m³/s)', 'Days']);
	const rows = (label: string, list: FdcPercentileRow[]) => list.map((r) => csvRow([label, FDC_RECORD_LABEL[r.record], r.q10, r.q50, r.q90, r.q95, r.n]));
	if (t.forecastDays > 0) yield csvRow([`The ${t.forecastDays} forecast days are left out: every row ranks the ${t.runDays} days before them`]);
	yield* rows(t.forecastDays > 0 ? 'Whole run before the forecast' : 'Whole run', t.wholeRun);
	if (t.onObservedDays) yield* rows(`Observed days only (${t.observedDays} of ${t.runDays})`, t.onObservedDays);
}

/**
 * The WR2012 check (model.md §2.10c): reference, scaling, the MAR ratios over
 * the overlapping years and the whole run, the 12 monthly means, the dry
 * season, the pattern correlation and the flag. A query or not-usable flag
 * says whether the run carries a written explanation (the run notes, in the
 * run details block at the top).
 */
export function* wr2012Lines(w: RunSummary['wr2012'], notes: string): Generator<string> {
	yield csvRow(['WR2012 check: simulated natural flow vs WR2012 naturalised flow']);
	if (!w) {
		yield csvRow(['Not checked: no WR2012 reference in the settings the run used']);
		return;
	}
	yield csvRow(['Quaternary', w.quaternary]);
	yield csvRow(['Source', w.source]);
	yield csvRow(['Reference period (water years)', waterYearText(w.referencePeriod.start), waterYearText(w.referencePeriod.end)]);
	const s = w.scaling;
	const fell = s.rule !== s.requested ? ` (${SCALING_TEXT[s.requested]} asked for; its data is missing)` : '';
	yield csvRow(['Scaling', `${SCALING_TEXT[s.rule]}${fell}`]);
	yield csvRow(['Scaling factor', s.factor]);
	yield csvRow(['Area factor', s.areaFactor, 'Modelled area (km²)', s.modelAreaKm2, 'Quaternary area (km²)', s.referenceAreaKm2]);
	yield csvRow(['Rainfall factor', s.rainFactor, 'Modelled MAP (mm)', s.modelMapMm, 'Quaternary MAP (mm)', s.referenceMapMm]);
	yield csvRow(['WR2012 MAR (Mm³/a)', w.referenceMarMm3]);
	yield csvRow(['WR2012 MAR scaled to the modelled catchment (Mm³/a)', w.scaledMarMm3]);
	yield csvRow(['Over', 'Water years', 'Simulated natural MAR (Mm³/a)', 'Scaled WR2012 MAR (Mm³/a)', 'Ratio (simulated ÷ WR2012)']);
	if (w.overlap) {
		const y = w.overlap.years;
		yield csvRow(['Overlapping years', `${waterYearText(y[0]!)} to ${waterYearText(y[y.length - 1]!)} (${y.length})`, w.overlap.simulatedMarMm3, w.scaledMarMm3, w.overlap.ratio]);
	} else {
		yield csvRow(['Overlapping years', 'no complete water year inside the reference period']);
	}
	yield csvRow(['Whole run', `${w.whole.days} days`, w.whole.simulatedMarMm3, w.scaledMarMm3, w.whole.ratio]);
	yield csvRow([`Monthly means over ${w.monthlyBasis === 'overlap' ? 'the overlapping years' : 'the whole run'} (Mm³ per month)`]);
	yield csvRow(['Month', 'Simulated natural (Mm³)', 'Scaled WR2012 (Mm³)', 'Ratio', 'Dry season']);
	for (const m of w.months) yield csvRow([MONTH_NAMES[m.month - 1]!, m.simulatedMm3, m.referenceMm3, m.ratio, m.lowFlow ? 'yes' : 'no']);
	yield csvRow([
		'Dry-season ratio',
		w.lowFlowRatio,
		w.lowFlowMonths.map((m) => MONTH_NAMES[m - 1]).join(' '),
		w.lowFlowSource === 'setting' ? 'months set in Settings' : 'the months the run’s natural flow is lowest'
	]);
	yield csvRow(['Monthly pattern correlation (Pearson r)', w.patternCorrelation]);
	const f = w.flag;
	yield csvRow(['Flag', WR2012_FLAG_TEXT[f.level], 'judged on', f.basis === 'overlap' ? 'the overlapping years' : 'the whole run', 'Deviation (%)', f.deviationPct]);
	yield csvRow([
		'Thresholds (%)',
		'note',
		f.thresholds.notePct,
		'query',
		f.thresholds.queryPct,
		'query if wetter by',
		f.thresholds.queryWetterPct,
		'not usable',
		f.thresholds.unusablePct
	]);
	if (f.text) yield csvRow(['Flag detail', f.text]);
	if (f.level === 'query' || f.level === 'unusable') {
		yield csvRow(['Written explanation', notes ? 'see Run notes at the top of this file' : 'none recorded for this run']);
	}
}

/** What each farm daily column means: its FarmTemplate letter and formula; then the observed flow record's columns (verify/columns.ts). */
export function* columnGuideLines(): Generator<string> {
	yield csvRow(['Farm daily columns (the daily CSV of a farm)']);
	yield csvRow(['Column', 'Series', 'Formula']);
	for (const c of FARM_DAILY_COLUMNS) yield csvRow([c.letter ?? '', c.key, c.formula]);
	yield csvRow(['Observed flow columns (the catchment daily CSV or a calibration site’s)']);
	yield csvRow(['Column', 'Series', 'Meaning']);
	for (const c of OBSERVED_FLOW_COLUMNS) yield csvRow(['', c.key, c.formula]);
}

/**
 * Other water users (engine ≥ 0.22.0, WP-1.33): the whole-run means, then the
 * reporting window's EWR charge and whether it is curtailed (a senior user is
 * not; docs/model.md §2.11). Only in runs that have users.
 */
export function* otherUserLines(summary: RunSummary): Generator<string> {
	yield csvRow(['Other water users (whole run)']);
	yield csvRow(['User', 'Priority', 'Average demand (m³/day)', 'Average taken (m³/day)', 'Average deficit (m³/day)', 'Demand supplied (%)', 'Average returned (m³/day)', 'Average EWR charge (m³/day charged)', 'Days charged for the EWR']);
	for (const u of summary.users ?? []) {
		yield csvRow([u.name, u.priority, u.avgDemandM3Day, u.avgSuppliedM3Day, u.avgDeficitM3Day, pct(u.fractionSupplied) as Cell, u.avgReturnedM3Day, u.avgEwrChargeM3Day, u.daysEwrNotMet]);
	}
	const rows = summary.curtailment?.otherUsers ?? [];
	if (!rows.length) return;
	yield '';
	yield csvRow(['Other water users: EWR charge and curtailment (reporting window)']);
	yield csvRow(['User', 'Priority', 'Demand (m³/day)', 'Taken (m³/day)', 'Returned (m³/day)', 'EWR charge (m³/day charged)', 'Curtailed', 'Supply cut (m³/day)', 'Supply cut (l/s)', 'Charge not removed by a cut (m³/day charged)']);
	for (const r of rows) {
		yield csvRow([r.name, r.priority, r.demandM3Day, r.suppliedM3Day, r.returnedM3Day, charged(r.ewrChargeM3Day), r.curtailed ? 'yes' : 'no (senior)', r.supplyCutM3Day, r.supplyCutLs, charged(r.uncurtailedChargeM3Day)]);
	}
	yield csvRow(['Other water users are outside the irrigation equitable-share benchmark. A senior user is not curtailed for the EWR: its charge stands, and is not moved onto the farms.']);
}

/**
 * Each unit's demand objects over the whole run (engine ≥ 1.7.0, docs/model.md
 * §2.7f): demand, supply, deficit and days short, the days a schedule
 * switched one off (engine ≥ 1.17.0), and a domestic or municipal one's
 * basic-needs floor (engine ≥ 1.44.0, issue #123): the people it serves, the
 * floor, the days and the volume supplied below it (apart from the
 * shortfall) and what it got per person. Only in runs with objects; the
 * floor columns only when an object has one.
 */
export function* demandObjectLines(summary: RunSummary): Generator<string> {
	const rows = (summary.farms ?? []).flatMap((f) => (f.demandObjects ?? []).map((o) => ({ unit: f.name, o })));
	if (!rows.length) return;
	const off = rows.some(({ o }) => o.daysOff !== undefined);
	const floor = rows.some(({ o }) => o.basicNeedsM3Day !== undefined);
	yield csvRow(['Demand objects (whole run)']);
	yield csvRow([
		'Hydrological unit',
		'Demand object',
		'Category',
		'Priority',
		'Destination',
		'Average demand (m³/day)',
		'Average supplied (m³/day)',
		'Average deficit (m³/day)',
		'Demand supplied (%)',
		'Average returned (m³/day)',
		'Days short',
		...(off ? ['Days off'] : []),
		...(floor ? ['People served', 'Basic-needs floor (m³/day, 25 l/person/day)', 'Days below the floor', 'Average below the floor (m³/day)', 'Supplied per person (l/person/day)'] : [])
	]);
	for (const { unit, o } of rows) {
		yield csvRow([
			unit,
			o.name,
			o.category,
			o.priority,
			o.destination,
			o.avgDemandM3Day,
			o.avgSuppliedM3Day,
			o.avgDeficitM3Day,
			pct(o.fractionSupplied) as Cell,
			o.avgReturnedM3Day,
			o.daysShort,
			...(off ? [o.daysOff ?? null] : []),
			...(floor ? [o.basicNeedsPopulation ?? null, o.basicNeedsM3Day ?? null, o.daysBelowBasicNeeds ?? null, o.avgBelowBasicNeedsM3Day ?? null, o.avgSuppliedLitresPerPersonDay ?? null] : [])
		]);
	}
}

/**
 * Groundwater abstraction per farm or user and water year (engine ≥ 0.36.0,
 * WP-3.9): pumped, into the dam, stream depletion, the boreholes' annual caps
 * and, for context, the GN 538 volume (the property's own, area × Table 2
 * rate capped at 40 000 m³/a, or the ceiling when unknown; engine ≥ 1.12.0)
 * with the most pumped in any 12 months (GN 538's year), then one row per
 * borehole. Only in runs with boreholes. The app shows modelled use against
 * the caps; it never decides legality. Older runs leave the last two blank
 * and read "ceiling".
 */
export function* groundwaterAnnualLines(rows: NonNullable<RunSummary['groundwaterAnnualUse']>): Generator<string> {
	yield csvRow(['Groundwater abstraction by water year (modelled use against the caps; GN 538 volume for context, not a decision on legality)']);
	yield csvRow([
		'Farm or user',
		'Water year',
		'Days',
		'Pumped (m³)',
		'Into the dam (m³)',
		'Stream depletion (m³)',
		'Annual caps (m³)',
		'GN 538 volume (m³/a)',
		'GN 538 volume from',
		'Most pumped in any 12 months (m³)'
	]);
	for (const r of rows)
		yield csvRow([
			r.name,
			r.label,
			r.days,
			r.abstractionM3,
			r.toDamM3,
			r.streamDepletionM3,
			r.annualCapM3,
			r.gaLimitM3,
			r.gaBasis === 'property' ? 'property area × rate' : 'ceiling only',
			r.rolling12MaxM3 ?? null
		]);
	yield csvRow(['Farm or user', 'Water year', 'Borehole', 'Pumped (m³)', 'Annual cap (m³)', 'Cap reached']);
	for (const r of rows) for (const b of r.boreholes) yield csvRow([r.name, r.label, b.name, b.abstractionM3, b.annualCapM3, b.annualCapM3 === null ? null : b.capReached ? 'yes' : 'no']);
}

/**
 * The drought restriction rule's effect (engine ≥ 1.54.0, WP-3.8, docs/model.md
 * §2.7i): the rule in words, the days at each level per water year and over
 * the run, and per unit its mean demand before and after the cut and what it
 * was supplied. Only in runs with the rule on.
 */
export function* droughtRestrictionLines(r: NonNullable<RunSummary['droughtRestriction']>, name: (id: string) => string = (id) => id): Generator<string> {
	yield csvRow(['Drought restrictions (the model rule; not the published restriction notice)']);
	yield csvRow(['Rule', describeDroughtRestriction(r.rule, name)]);
	if (r.rule.source?.trim()) yield csvRow(['Source', r.rule.source.trim()]);
	yield csvRow(['Reviews in the run', r.reviews]);
	if (r.ewrReviews !== undefined) yield csvRow(['Reviews after a day the EWR trigger’s site wasn’t met', r.ewrReviews]);
	const levels = ['No restriction', ...r.rule.levels.map((l, i) => describeRestrictionLevel(l, i))];
	yield csvRow(['Water year', 'Days', ...levels.map((l) => `Days: ${l}`)]);
	for (const y of r.years) yield csvRow([waterYearLabel(y.waterYear), y.days, ...y.daysByLevel]);
	yield csvRow(['Whole run', r.daysByLevel.reduce((a, b) => a + b, 0), ...r.daysByLevel]);
	yield csvRow(['Unit', 'Mean demand (m³/day)', 'Mean demand after the restriction (m³/day)', 'Mean cut (m³/day)', 'Mean cut on restricted days (m³/day)', 'Mean supplied (m³/day)', 'Days restricted']);
	for (const u of r.units)
		yield csvRow([u.name, u.avgDemandM3Day, u.avgRestrictedDemandM3Day, Math.max(0, u.avgDemandM3Day - u.avgRestrictedDemandM3Day), u.avgCutOnRestrictedDaysM3Day ?? null, u.avgSuppliedM3Day, u.daysByLevel ? u.daysByLevel.slice(1).reduce((a, b) => a + b, 0) : null]);
}

/**
 * An allocation cap's water years per farm or user and water source (engine
 * ≥ 1.18.0, docs/allocations.md § The cap): whether the use reached the
 * registered volume, and (engine ≥ 1.40.0) the days the licence limit bound
 * split by which limit: what was left of the volume, the maximum rate, or a
 * month outside the months of use. One row per year either happened in; a
 * run before 1.40.0 leaves the day columns blank. Only in cap runs.
 */
export function* allocationCapLines(a: NonNullable<RunSummary['allocations']>): Generator<string> {
	yield csvRow(['Allocation cap by water year (modelled use held to the registered volume and the licence’s months and rate; not a decision on legality)']);
	yield csvRow(['Farm or user', 'Water source', 'Water year', 'Registered volume (m³)', 'Used (m³)', 'Volume reached', 'Days the limit bound', 'Of which: volume used up', 'Of which: maximum rate', 'Of which: outside the months of use']);
	let rows = 0;
	for (const n of a.nodes)
		for (const src of n.sources) {
			const reached = new Map((src.capReached ?? []).map((y) => [y.waterYear, y]));
			const bound = new Map((src.limitBound ?? []).map((y) => [y.waterYear, y]));
			for (const wy of [...new Set([...reached.keys(), ...bound.keys()])].sort((x, y) => x - y)) {
				const r = reached.get(wy);
				const b = bound.get(wy);
				const days: Cell[] = src.limitBound ? [b?.days ?? 0, b?.volumeDays ?? 0, b?.rateDays ?? 0, b?.monthsDays ?? 0] : [null, null, null, null];
				yield csvRow([n.name, src.waterSource === 'surface' ? 'Surface water' : 'Groundwater', waterYearLabel(wy), r?.budgetM3 ?? null, r?.usedM3 ?? null, r ? 'yes' : 'no', ...days]);
				rows++;
			}
		}
	const counted = a.nodes.some((n) => n.sources.some((x) => x.limitBound));
	if (!rows) yield csvRow([counted ? 'The cap never bound: no water year reached its registered volume, and the licence held no day back.' : 'No water year reached its registered volume.']);
}

/**
 * Land-cover streamflow reductions (engine ≥ 0.24.0, WP-1.35): the low-flow
 * threshold, the total, and per class its condensed area, mean reduction and
 * mm/yr over that area. Only in runs with land cover.
 */
export function* landCoverLines(lc: NonNullable<RunSummary['landCover']>): Generator<string> {
	yield csvRow(['Land-cover streamflow reductions (invasive plants and forestry)']);
	yield csvRow(['Low-flow threshold: natural flow exceeded 75 % of days (m³/day)', lc.lowFlowThresholdM3Day]);
	yield csvRow(['Mean reduction (m³/day)', lc.reductionM3Day]);
	yield csvRow(['Share of natural flow (%)', pct(lc.fractionOfNatural) as Cell]);
	yield csvRow(['Cover class', 'Condensed area (km²)', 'Mean reduction (m³/day)', 'Reduction over the condensed area (mm/yr)']);
	for (const c of lc.byClass) yield csvRow([c.coverClass, c.condensedKm2, c.reductionM3Day, c.mmPerYear]);
}
