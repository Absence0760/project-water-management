// Automatic calibration in the browser (issue #4 phase 5): what the worker is
// given, and how its report is shown and applied. Pure, so it is unit-tested;
// the worker (./autocal.worker.ts) and the panel (FitPanel.svelte) are thin.
import {
	CALIBRATION_PARAMS,
	ENGINE_VERSION,
	fitRecordFromReport,
	withoutForecastTail,
	OBJECTIVE_LABELS,
	waterYearLabel,
	type CalibrationBounds,
	type FitRecord,
	type CalibrationFlowKind,
	type CalibrationProgress,
	type CalibrationReport,
	type CalibrationStage,
	type DifferentialTest,
	type FitScores,
	type ScoreInterval,
	type ScoreBenchmarks,
	type ScoreIntervals,
	type ScoredPeriod,
	type ModelInput,
	type ObjectiveId,
	type ProjectModel,
	type ProjectSettings,
	type RunoffModelId,
	type SeriesProvenance,
	type ApanDailyFingerprint
} from '@water-management/engine';
import { FLOW_KIND_LABEL } from '$lib/components/calibration/metrics';
import { fmtNum } from '$lib/format/number';

export interface FitRequest {
	input: ModelInput;
	model: RunoffModelId;
	objective: ObjectiveId;
	/** The box the search explores. Default 'wide' (each parameter's min/max). */
	bounds?: CalibrationBounds;
	budget: number;
	free: string[];
	validate: boolean;
	seed: number;
	/** Independent searches of the whole record (engine CalibrateOptions.starts). */
	starts: number;
	/** A second observed record to validate the fit against; undefined = none. */
	validationRecord?: CalibrationFlowKind;
}

/** The "Bounds" select's label for each option (issue #4 phase 6). */
export const BOUNDS_LABEL: Record<CalibrationBounds, string> = {
	wide: 'Wide (default)',
	typical: 'Typical (Perrin et al. 80 %)'
};

/** The hint shown under the "Bounds" select. */
export const boundsHint = (b: CalibrationBounds): string =>
	b === 'typical'
		? 'A tighter, published range — helps a short or drought-heavy record land on plausible values, at the cost of the fit if the catchment truly falls outside it.'
		: 'Each parameter’s full calibration range.';

export type WorkerMessage =
	| { type: 'progress'; progress: CalibrationProgress }
	| { type: 'done'; report: CalibrationReport }
	| { type: 'error'; message: string };

/**
 * The engine input for a fit: what the server would run, with the unsaved
 * Settings form and (when given) the unsaved network in place of the saved
 * ones, so a fit reflects what the user sees. Without the forecast tail
 * (engine withoutForecastTail, issue #51): the live input carries the
 * forecast series, and the fit, like every ordinary run (backend
 * runs/execute.ts), must see the record only. The cut is made after the
 * form's settings are in, as a run makes it after the project's, so a form
 * ending the run before the forecast leaves nothing to cut.
 */
export function fitInput(server: ModelInput, settings: ProjectSettings, model?: ProjectModel): ModelInput {
	return withoutForecastTail({ settings: settings as unknown as ModelInput['settings'], model: model ?? server.model, series: server.series });
}

/** GR4J parameters the form offers to fit, with which are ticked by default (X2 only when the form opened it). */
export function fitParams(x2Open = false) {
	return CALIBRATION_PARAMS.gr4j
		.filter((p) => !(p.key === 'x2' && !x2Open))
		.map((p) => ({ key: p.key, label: p.label, unit: p.unit, min: p.min, max: p.max, checked: !p.fixedByDefault }));
}

/**
 * Records the fit can be validated against independently: offered only when
 * the project has both a gauge and a logger record, and never the record the
 * fit itself uses (the form's choice, else the default gauge pick).
 * `seriesKinds` null = not known yet: nothing is offered.
 */
export function validationRecordOptions(seriesKinds: readonly string[] | null, calibrationKind: CalibrationFlowKind | null): CalibrationFlowKind[] {
	const both: CalibrationFlowKind[] = ['flow_observed_m3s', 'flow_logger_m3s'];
	if (!seriesKinds || !both.every((k) => seriesKinds.includes(k))) return [];
	const fitted = calibrationKind && seriesKinds.includes(calibrationKind) ? calibrationKind : 'flow_observed_m3s';
	return both.filter((k) => k !== fitted);
}

/** "WY 2001/02, 2004/05": a set of water years, never a date envelope (the years need not be consecutive). */
export function waterYearsText(years: readonly number[]): string {
	return years.length ? `WY ${years.map(waterYearLabel).join(', ')}` : '–';
}

/**
 * What ranked the dry → wet test's water years (engine ≥ 1.18.0), in words;
 * a test from before it (no `rankedBy`) ranked by the fitted record.
 */
export function rankedByText(d: Pick<DifferentialTest, 'rankedBy'>): string {
	return d.rankedBy === 'reference'
		? 'years ranked dry → wet by the reference gauge (other catchment), a regional wet/dry index that is never scored'
		: 'years ranked dry → wet by the fitted record’s own mean flow';
}

/** Runs the fit will make: one optimisation per start, two more with validation, plus one without the WR2012 penalty when it is on. */
export const totalRuns = (budget: number, validate: boolean, penalty = false, starts = 1) => budget * (starts + (validate ? 2 : 0) + (penalty ? 1 : 0));

export const STAGE_LABEL: Record<CalibrationStage, string> = {
	full: 'Fitting the whole record',
	split: 'Split-sample test',
	dsst: 'Dry → wet test',
	unpenalised: 'Fitting again without the WR2012 penalty'
};

/**
 * Overall progress 0–1 across the stages, each weighted by its runs: the
 * full fit once per start, then the validation stages, the unpenalised fit last.
 */
export function progressFraction(p: CalibrationProgress, validate: boolean, penalty = false, starts = 1): number {
	const stages: CalibrationStage[] = [...(validate ? (['full', 'split', 'dsst'] as const) : (['full'] as const)), ...(penalty ? (['unpenalised'] as const) : [])];
	const i = Math.max(0, stages.indexOf(p.stage));
	// Stages before this one: the full fit counts `starts` times.
	const before = i === 0 ? (p.start ?? 1) - 1 : starts + i - 1;
	return Math.min(1, (before + p.evaluations / p.budget) / (starts + stages.length - 1));
}

/** The stage being run, with which start for a multi-start full fit. */
export const stageText = (p: CalibrationProgress) => `${STAGE_LABEL[p.stage]}${p.starts ? ` (start ${p.start} of ${p.starts})` : ''}`;

export interface ScoreRow {
	key: keyof FitScores;
	label: string;
	/** Units shown after the value: '' for an efficiency, '%' for a bias. */
	unit: '' | '%';
	/** What "good" is, for the reader. */
	ideal: string;
}

export const SCORE_ROWS: ScoreRow[] = [
	{ key: 'kgePrime', label: 'KGE′', unit: '', ideal: '1' },
	{ key: 'kgeYearly', label: 'Year-balanced KGE′', unit: '', ideal: '1' },
	{ key: 'kgeNp', label: 'Non-parametric KGE', unit: '', ideal: '1' },
	{ key: 'nse', label: 'NSE', unit: '', ideal: '1' },
	{ key: 'nseSqrt', label: 'NSE on √Q', unit: '', ideal: '1' },
	{ key: 'nseLog', label: 'NSE on log Q', unit: '', ideal: '1' },
	{ key: 'kgeLowHigh', label: 'Low/high-flow KGE′ (Q and 1/Q)', unit: '', ideal: '1' },
	{ key: 'volumeErrorPct', label: 'Volume error', unit: '%', ideal: '0' },
	{ key: 'fdcHighPct', label: 'High flows (top 2 %)', unit: '%', ideal: '0' },
	{ key: 'fdcMidSlopePct', label: 'FDC mid-slope', unit: '%', ideal: '0' },
	{ key: 'fdcLowPct', label: 'Low flows (bottom 30 %)', unit: '%', ideal: '0' }
];

export interface ScoreColumn {
	id: string;
	label: string;
	/** "2002-04-15 – 2004-10-02", or "WY 2001/02, 2004/05" for a set of water years. */
	period: string;
	scores: FitScores;
	/** Validation columns are scored on days the parameters were not fitted to. */
	validation: boolean;
	/** 90 % bootstrap intervals (engine ≥ 1.18.0, CR-5); null when too few water years or on an older report. */
	intervals: ScoreIntervals | null;
	/** Mean-flow and climatology benchmark scores on the same days (engine ≥ 1.18.0, CR-5); null on an older report. */
	benchmarks: ScoreBenchmarks | null;
}

/** What a score table is built from: a fresh report, or a stored fit record (same shape). */
export type ScoredFit = Pick<CalibrationReport, 'before' | 'fit' | 'splitSample' | 'differential' | 'independentRecord'>;

/** The report's periods as table columns: before, fitted, then each test's calibration and validation part. */
export function scoreColumns(r: ScoredFit): ScoreColumn[] {
	const p = (x: { start: string; end: string }) => `${x.start} – ${x.end}`;
	const col = (id: string, label: string, period: string, x: ScoredPeriod, validation: boolean): ScoreColumn => ({
		id,
		label,
		period,
		scores: x.scores,
		validation,
		intervals: x.intervals ?? null,
		benchmarks: x.benchmarks ?? null
	});
	const cols: ScoreColumn[] = [col('before', 'Current parameters', p(r.before), r.before, false), col('fit', 'Fitted', p(r.fit), r.fit, false)];
	if (r.splitSample) {
		cols.push(
			col('split-cal', 'Split: fitted half', p(r.splitSample.calibration), r.splitSample.calibration, false),
			col('split-val', 'Split: other half', p(r.splitSample.validation), r.splitSample.validation, true)
		);
	}
	if (r.differential) {
		// The dry and wet years interleave, so their first–last dates overlap: list the years scored.
		const d = r.differential;
		cols.push(
			col('dsst-cal', 'Dry years (fitted)', waterYearsText(d.calibration.waterYears), d.calibration, false),
			col('dsst-val', 'Wet years', waterYearsText(d.validation.waterYears), d.validation, true)
		);
	}
	if (r.independentRecord) {
		const v = r.independentRecord.validation;
		cols.push(col('record-val', `Independent record: ${FLOW_KIND_LABEL[r.independentRecord.flowKind]}`, p(v), v, true));
	}
	return cols;
}

/** A score for the table: "0.62", "+4.1%", or "–" when missing (a score absent from an older report included). */
export const fmtScore = (v: number | null | undefined, unit: '' | '%' = ''): string =>
	v === null || v === undefined || !Number.isFinite(v) ? '–' : unit === '%' ? `${v > 0 ? '+' : ''}${fmtNum(v, 1)}%` : fmtNum(v, 2);

/** "(0.48–0.71)", or "(-0.30 to 0.05)" when a bound is negative, so the dash never reads as a minus. */
export const intervalText = (iv: { lo: number; hi: number }): string =>
	iv.lo < 0 || iv.hi < 0 ? `(${fmtScore(iv.lo)} to ${fmtScore(iv.hi)})` : `(${fmtScore(iv.lo)}–${fmtScore(iv.hi)})`;

/**
 * A score cell: the score, with its 90 % bootstrap interval when the column
 * has one for that score ("0.62 (0.48–0.71)"). The interval is looked up by
 * the score's own name (only KGE′, NSE and the low/high-flow KGE′ have one),
 * without importing the engine's list, so the panel's chunk stays free of
 * the scoring code (issue #9).
 */
export function scoreCellText(c: Pick<ScoreColumn, 'scores' | 'intervals'>, key: keyof FitScores, unit: '' | '%' = ''): string {
	const v = (c.scores[key] as number | null | undefined) ?? null;
	const found = c.intervals ? (c.intervals as unknown as Record<string, unknown>)[key] : null;
	const iv = found && typeof found === 'object' ? (found as ScoreInterval) : null;
	return v !== null && iv ? `${fmtScore(v, unit)} ${intervalText(iv)}` : fmtScore(v, unit);
}

export interface BenchmarkRow {
	label: string;
	/** One cell per column that has benchmarks, in column order. */
	cells: string[];
}

/** Columns that carry benchmarks (a report from engine ≥ 1.18.0). */
export const benchmarkColumns = (cols: readonly ScoreColumn[]) => cols.filter((c) => c.benchmarks);

/**
 * The model against the two benchmarks on the fit's objective, one row
 * each, over the columns that carry them; [] when none do (an older report).
 */
export function benchmarkRows(cols: readonly ScoreColumn[], objective: ObjectiveId): BenchmarkRow[] {
	const withB = benchmarkColumns(cols);
	if (!withB.length) return [];
	const w = withB[0]!.benchmarks!.halfWindowDays;
	return [
		{ label: 'Model', cells: withB.map((c) => scoreCellText(c, objective)) },
		{ label: 'Mean flow every day', cells: withB.map((c) => fmtScore(c.benchmarks!.meanFlow[objective])) },
		{ label: `Day-of-year climatology (±${w} days)`, cells: withB.map((c) => fmtScore(c.benchmarks!.climatology[objective])) }
	];
}

/**
 * One plain sentence when the fitted model doesn't beat the day-of-year
 * climatology on the fit's objective, on the fitted period or a validation
 * period; null when it beats it everywhere (or nothing can be compared).
 */
export function climatologyWarning(cols: readonly ScoreColumn[], objective: ObjectiveId): string | null {
	const losing = benchmarkColumns(cols).filter((c) => {
		if (c.id !== 'fit' && !c.validation) return false;
		const m = c.scores[objective] as number | null | undefined;
		const b = c.benchmarks!.climatology[objective] as number | null | undefined;
		return m != null && b != null && m <= b;
	});
	if (!losing.length) return null;
	const where = losing.map((c) => (c.id === 'fit' ? 'the fitted period' : c.id === 'record-val' ? 'the independent record' : `“${c.label}”`));
	const list = where.length === 1 ? where[0]! : `${where.slice(0, -1).join(', ')} and ${where[where.length - 1]}`;
	return `On ${list}, the model scores no better than repeating each calendar day’s average observed flow: it adds little beyond the seasonal cycle there.`;
}

/** The WR2012 MAR penalty will apply: it is switched on and there is a reference to pull towards. */
export const marPenaltyOn = (s: Pick<ProjectSettings, 'wr2012'>) => !!(s.wr2012?.calibrationPenalty?.enabled && s.wr2012.reference);

/** The objective's label, without the citation. */
export const objectiveName = (id: ObjectiveId) => OBJECTIVE_LABELS[id];

/** The form's settings with the fitted GR4J parameters written in. Nothing is saved. */
export function applyReport<S extends Pick<ProjectSettings, 'gr4j'>>(settings: S, r: CalibrationReport): S {
	const fitted = Object.fromEntries(r.free.map((k) => [k, r.params[k]!]));
	return { ...settings, gr4j: { ...settings.gr4j, ...fitted } };
}

/** Largest seed: the engine's generator takes a 32-bit integer. */
export const SEED_MAX = 2 ** 31 - 1;

/** Why a seed can't be used, or null. */
export function seedError(seed: number | null): string | null {
	if (seed === null) return 'Enter a seed.';
	return Number.isInteger(seed) && seed >= 0 && seed <= SEED_MAX ? null : `The seed must be a whole number from 0 to ${fmtNum(SEED_MAX)}.`;
}

/**
 * The fit record Apply stores with the parameters: the report plus the form
 * it ran on (window, exclusions), whether validation was asked for, the
 * engine version and the time.
 */
export function fitRecordFor(
	r: CalibrationReport,
	settings: Pick<ProjectSettings, 'calibrationStart' | 'calibrationEnd' | 'calibrationExclusions' | 'panCoefficient' | 'apanMm' | 'chirpsBiasCorrection' | 'zeroRainRuns' | 'chirpsFitPeriod'> & Partial<Pick<ProjectSettings, 'rainSource' | 'pe' | 'panCoefficientSource' | 'arealRain'>>,
	opts: { validate: boolean; validationRecord: CalibrationFlowKind | null; now?: Date; chirpsSource?: SeriesProvenance | null; apanDaily?: ApanDailyFingerprint | null }
): FitRecord {
	return fitRecordFromReport(r, {
		settings,
		validate: opts.validate,
		validationRecord: opts.validationRecord,
		engineVersion: ENGINE_VERSION,
		fittedAt: (opts.now ?? new Date()).toISOString(),
		// The CHIRPS series' product and version the fit ran on (issue #40c), when known.
		...(opts.chirpsSource !== undefined ? { chirpsSource: opts.chirpsSource } : {}),
		// The daily A-pan series it ran on (issue #45), when known.
		...(opts.apanDaily !== undefined ? { apanDaily: opts.apanDaily } : {})
	});
}

/** "2026-09-24 10:05 UTC" for a fit record's ISO timestamp. */
export const fittedAtText = (iso: string) => iso.replace('T', ' ').replace(/:\d{2}(\.\d+)?Z$/, ' UTC');
