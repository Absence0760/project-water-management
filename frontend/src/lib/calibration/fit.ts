// Automatic calibration in the browser (issue #4 phase 5): what the worker is
// given, and how its report is shown and applied. Pure, so it is unit-tested;
// the worker (./autocal.worker.ts) and the panel (FitPanel.svelte) are thin.
import {
	CALIBRATION_PARAMS,
	OBJECTIVE_LABELS,
	waterYearLabel,
	type CalibrationFlowKind,
	type CalibrationProgress,
	type CalibrationReport,
	type CalibrationStage,
	type FitScores,
	type ModelInput,
	type ObjectiveId,
	type ProjectModel,
	type ProjectSettings,
	type RunoffModelId
} from '@water-management/engine';
import { FLOW_KIND_LABEL } from '$lib/components/calibration/metrics';

export interface FitRequest {
	input: ModelInput;
	model: RunoffModelId;
	objective: ObjectiveId;
	budget: number;
	free: string[];
	validate: boolean;
	seed: number;
	/** A second observed record to validate the fit against; undefined = none. */
	validationRecord?: CalibrationFlowKind;
}

export type WorkerMessage =
	| { type: 'progress'; progress: CalibrationProgress }
	| { type: 'done'; report: CalibrationReport }
	| { type: 'error'; message: string };

/**
 * The engine input for a fit: what the server would run, with the unsaved
 * Settings form and (when given) the unsaved network in place of the saved
 * ones, so a fit reflects what the user sees.
 */
export function fitInput(server: ModelInput, settings: ProjectSettings, model?: ProjectModel): ModelInput {
	return { settings: settings as unknown as ModelInput['settings'], model: model ?? server.model, series: server.series };
}

/** Parameters the form offers to fit, with which are ticked by default. */
export function fitParams(model: RunoffModelId, x2Open = false) {
	return CALIBRATION_PARAMS[model]
		.filter((p) => !(model === 'gr4j' && p.key === 'x2' && !x2Open))
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

/** "WY 1983/84, 1992/93": a set of water years, never a date envelope (the years need not be consecutive). */
export function waterYearsText(years: readonly number[]): string {
	return years.length ? `WY ${years.map(waterYearLabel).join(', ')}` : '–';
}

/** Runs the fit will make: one optimisation, or three with validation, plus one without the WR2012 penalty when it is on. */
export const totalRuns = (budget: number, validate: boolean, penalty = false) => budget * ((validate ? 3 : 1) + (penalty ? 1 : 0));

export const STAGE_LABEL: Record<CalibrationStage, string> = {
	full: 'Fitting the whole record',
	split: 'Split-sample test',
	dsst: 'Dry → wet test',
	unpenalised: 'Fitting again without the WR2012 penalty'
};

/** Overall progress 0–1 across the stages (validation stages run after the full fit, the unpenalised fit last). */
export function progressFraction(p: CalibrationProgress, validate: boolean, penalty = false): number {
	const stages: CalibrationStage[] = [...(validate ? (['full', 'split', 'dsst'] as const) : (['full'] as const)), ...(penalty ? (['unpenalised'] as const) : [])];
	const i = Math.max(0, stages.indexOf(p.stage));
	return Math.min(1, (i + p.evaluations / p.budget) / stages.length);
}

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
	{ key: 'volumeErrorPct', label: 'Volume error', unit: '%', ideal: '0' },
	{ key: 'fdcHighPct', label: 'High flows (top 2 %)', unit: '%', ideal: '0' },
	{ key: 'fdcMidSlopePct', label: 'FDC mid-slope', unit: '%', ideal: '0' },
	{ key: 'fdcLowPct', label: 'Low flows (bottom 30 %)', unit: '%', ideal: '0' }
];

export interface ScoreColumn {
	id: string;
	label: string;
	/** "2013-04-15 – 2015-10-02", or "WY 1983/84, 1992/93" for a set of water years. */
	period: string;
	scores: FitScores;
	/** Validation columns are scored on days the parameters were not fitted to. */
	validation: boolean;
}

/** The report's periods as table columns: before, fitted, then each test's calibration and validation part. */
export function scoreColumns(r: CalibrationReport): ScoreColumn[] {
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

/**
 * The form's settings with the fitted parameters written in: settings.gr4j
 * for GR4J, settings.calibration for the legacy model. Nothing is saved.
 */
export function applyReport<S extends Pick<ProjectSettings, 'gr4j' | 'calibration'>>(settings: S, r: CalibrationReport): S {
	const fitted = Object.fromEntries(r.free.map((k) => [k, r.params[k]!]));
	return r.model === 'gr4j'
		? { ...settings, gr4j: { ...settings.gr4j, ...fitted } }
		: { ...settings, calibration: { ...settings.calibration, ...fitted } };
}
