// Automated calibration in the browser (issue #153): what the worker is
// given, and how its report is shown and applied. Pure, so it is unit-tested;
// the worker (./autocal.worker.ts) runs the engine's autoCalibrate and the
// panel (AutoFitPanel.svelte) is thin. The rules come from the saved
// settings only: the panel refuses to run while they have unsaved edits.
import {
	autoFitRecordOf,
	FILTER_LABEL,
	PAN_COEFFICIENT_PRESET_SOURCE,
	ruleCaseCount,
	SELECTION_TEST_LABEL,
	type AutoCalibrationProgress,
	type AutoCalibrationReport,
	type AutoCase,
	type CalibrationRules,
	type FitRecord,
	type ModelInput,
	type ProjectSettings
} from '@water-management/engine';
import { fmtNum } from '$lib/format/number';
import { fitRecordFor, fmtScore, objectiveName, progressFraction, stageText, totalRuns } from './fit';

/** The seed, starts and model runs are the rules' own (rules.run): the page can't choose them. */
export interface AutoFitRequest {
	kind: 'auto';
	input: ModelInput;
}

export type AutoWorkerMessage =
	| { type: 'auto-progress'; progress: AutoCalibrationProgress }
	| { type: 'auto-done'; report: AutoCalibrationReport }
	| { type: 'error'; message: string };

/** Model runs the rules make: each case is a full fit with both validation tests (and one without the WR2012 penalty when it is on). */
export const autoRunsTotal = (rules: CalibrationRules, penalty: boolean) => ruleCaseCount(rules) * totalRuns(rules.run.budget, true, penalty, rules.run.starts);

/** Overall progress 0–1: the cases before this one, then this case's own. */
export const autoProgressFraction = (p: AutoCalibrationProgress, penalty: boolean, starts: number) =>
	Math.min(1, (p.caseIndex + progressFraction(p.progress, true, penalty, starts)) / p.cases);

/** "Fit 2 of 4 (typical bounds): Dry → wet test". */
export const autoStageText = (p: AutoCalibrationProgress, label?: string) => `Fit ${p.caseIndex + 1} of ${p.cases}${label ? ` (${label})` : ''}: ${stageText(p.progress)}`;

/**
 * The saved rules differ from the form's: the panel won't run until they are
 * saved, since a fit must run under rules fixed before its result is seen.
 */
export const rulesUnsaved = (saved: CalibrationRules, form: CalibrationRules) => JSON.stringify(saved) !== JSON.stringify(form);

export interface AutoCaseRow {
	label: string;
	verdict: 'Kept' | 'Passed' | 'Not kept';
	score: string;
	mar: string;
	filters: string;
	reasons: string[];
}

const FILTER_STATUS: Record<string, string> = { pass: 'passed', fail: 'failed', notApplicable: 'not applied' };

/** One row per case: whether it was kept, its held-out score, its MAR, the filters, and why it wasn't kept. */
export function autoCaseRows(r: AutoCalibrationReport): AutoCaseRow[] {
	return r.cases.map((c, i) => ({
		label: caseLabel(c),
		verdict: i === r.chosen ? 'Kept' : c.eligible ? 'Passed' : 'Not kept',
		score: fmtScore(c.score),
		mar: c.naturalMarMm3 === null ? '–' : fmtNum(c.naturalMarMm3, 2),
		filters: c.filters.length ? c.filters.map((f) => `${FILTER_LABEL[f.id]}: ${FILTER_STATUS[f.status]}`).join('; ') : 'none',
		reasons: c.reasons
	}));
}

/** "The project’s pan coefficient, typical bounds, KGE′". */
export const caseLabel = (c: Pick<AutoCase, 'pan' | 'bounds' | 'objective'>) => `${c.pan.label}, ${c.bounds} bounds, ${objectiveName(c.objective).replace(/ \([^()]*\)$/, '')}`;

/** What the fit is chosen by, in words: "the best KGE′ on the dry → wet test (wet years)". */
export const selectionText = (rules: CalibrationRules) =>
	`the best ${objectiveName(rules.selection.score).replace(/ \([^()]*\)$/, '')} on the ${SELECTION_TEST_LABEL[rules.selection.test]}`;

/** The pan coefficient the kept case was fitted under, when it isn't the project's own: Apply writes it too. */
export function keptPan(r: AutoCalibrationReport): { values: number[]; source: string } | null {
	const c = r.chosen === null ? null : r.cases[r.chosen]!;
	if (!c?.pan.values) return null;
	return { values: [...c.pan.values], source: `${c.pan.label} preset (automated calibration): ${PAN_COEFFICIENT_PRESET_SOURCE}` };
}

/**
 * The fit record Apply stores for the kept case: the case's report as a
 * normal fit record (with the forcing it ran under), plus how the rules chose
 * it (FitRecord.auto). Null when nothing was kept.
 */
export function autoFitRecordFor(r: AutoCalibrationReport, settings: ProjectSettings, opts: Omit<Parameters<typeof fitRecordFor>[2], 'validate' | 'validationRecord'>): FitRecord | null {
	if (r.chosen === null) return null;
	const kept = r.cases[r.chosen]!;
	if (!kept.report) return null;
	const pan = keptPan(r);
	const ran = pan ? { ...settings, panCoefficient: pan.values as unknown as ProjectSettings['panCoefficient'], panCoefficientSource: pan.source } : settings;
	return fitRecordFor(kept.report, ran, { ...opts, validate: true, validationRecord: r.validationRecord, auto: autoFitRecordOf(r as AutoCalibrationReport & { chosen: number }) });
}
