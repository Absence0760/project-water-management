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
	type FitScores,
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
	{ key: 'kgeLowHigh', label: 'KGE′ on Q and 1/Q', unit: '', ideal: '1' },
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
}

/** What a score table is built from: a fresh report, or a stored fit record (same shape). */
export type ScoredFit = Pick<CalibrationReport, 'before' | 'fit' | 'splitSample' | 'differential' | 'independentRecord'>;

/** The report's periods as table columns: before, fitted, then each test's calibration and validation part. */
export function scoreColumns(r: ScoredFit): ScoreColumn[] {
	const p = (x: { start: string; end: string }) => `${x.start} – ${x.end}`;
	const cols: ScoreColumn[] = [
		{ id: 'before', label: 'Current parameters', period: p(r.before), scores: r.before.scores, validation: false },
		{ id: 'fit', label: 'Fitted', period: p(r.fit), scores: r.fit.scores, validation: false }
	];
	if (r.splitSample) {
		cols.push(
			{ id: 'split-cal', label: 'Split: fitted half', period: p(r.splitSample.calibration), scores: r.splitSample.calibration.scores, validation: false },
			{ id: 'split-val', label: 'Split: other half', period: p(r.splitSample.validation), scores: r.splitSample.validation.scores, validation: true }
		);
	}
	if (r.differential) {
		// The dry and wet years interleave, so their first–last dates overlap: list the years scored.
		const d = r.differential;
		cols.push(
			{ id: 'dsst-cal', label: 'Dry years (fitted)', period: waterYearsText(d.calibration.waterYears), scores: d.calibration.scores, validation: false },
			{ id: 'dsst-val', label: 'Wet years', period: waterYearsText(d.validation.waterYears), scores: d.validation.scores, validation: true }
		);
	}
	if (r.independentRecord) {
		const v = r.independentRecord.validation;
		cols.push({ id: 'record-val', label: `Independent record: ${FLOW_KIND_LABEL[r.independentRecord.flowKind]}`, period: p(v), scores: v.scores, validation: true });
	}
	return cols;
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
