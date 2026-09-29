// Automated calibration in the page (issue #153): how a server run of the
// calibration rules (api.autoCalibrations, docs/api.md § Automated
// calibration) is shown. Pure, so it is unit-tested; the panel
// (AutoFitPanel.svelte) is thin. The server fits every case, one job each,
// from the saved rules only, and applies the kept fit itself.
import { canonicalJson, FILTER_LABEL, ruleCaseCount, SELECTION_TEST_LABEL, type CalibrationRules } from '@water-management/engine';
import type { AutoCalibration, AutoCalibrationCase } from '$lib/api/types';
import { fmtNum } from '$lib/format/number';
import { fmtScore, objectiveName, totalRuns } from './fit';

/** Model runs the rules make: each case is a full fit with both validation tests (and one without the WR2012 penalty when it is on). */
export const autoRunsTotal = (rules: CalibrationRules, penalty: boolean) => ruleCaseCount(rules) * totalRuns(rules.run.budget, true, penalty, rules.run.starts);

/**
 * The saved rules differ from the form's (whatever order their keys are in):
 * the panel won't run or apply until they are saved, since a fit must run
 * under rules fixed before its result is seen.
 */
export const rulesUnsaved = (saved: CalibrationRules, form: CalibrationRules) => canonicalJson(saved) !== canonicalJson(form);

export interface AutoCaseRow {
	label: string;
	verdict: 'Kept' | 'Passed' | 'Not kept';
	score: string;
	mar: string;
	filters: string;
	reasons: string[];
}

const FILTER_STATUS: Record<string, string> = { pass: 'passed', fail: 'failed', notApplicable: 'not applied' };

/** "The project’s pan coefficient, typical bounds, KGE′". */
export const caseLabel = (c: Pick<AutoCalibrationCase, 'pan' | 'bounds' | 'objective'>) => `${c.pan.label}, ${c.bounds} bounds, ${objectiveName(c.objective).replace(/ \([^()]*\)$/, '')}`;

/** One row per fitted case: whether it was kept, its held-out score, its MAR, the filters, and why it wasn't kept. */
export function autoCaseRows(a: Pick<AutoCalibration, 'cases' | 'chosen' | 'status'>): AutoCaseRow[] {
	return a.cases.map((c, i) => ({
		label: caseLabel(c),
		verdict: i === a.chosen ? 'Kept' : a.status === 'complete' && c.eligible ? 'Passed' : 'Not kept',
		score: fmtScore(c.score),
		mar: c.naturalMarMm3 === null ? '–' : fmtNum(c.naturalMarMm3, 2),
		filters: c.filters.length ? c.filters.map((f) => `${FILTER_LABEL[f.id]}: ${FILTER_STATUS[f.status]}`).join('; ') : 'none',
		reasons: c.error ? [c.error] : c.reasons
	}));
}

/** What keeps a fit, in words: "the best KGE′ on the dry → wet test (wet years)". */
export const selectionText = (rules: CalibrationRules) =>
	`the best ${objectiveName(rules.selection.score).replace(/ \([^()]*\)$/, '')} on the ${SELECTION_TEST_LABEL[rules.selection.test]}`;

export type AutoState =
	| { kind: 'running'; text: string; progress: number | null }
	| { kind: 'stopped'; text: string }
	| { kind: 'failed'; text: string }
	| { kind: 'complete' };

/**
 * Where a run of the rules stands: running (fit i of n, the job's progress),
 * stopped (its job died, so it will never finish), failed (the run's own
 * reason) or complete.
 */
export function autoState(a: Pick<AutoCalibration, 'status' | 'cases' | 'plan' | 'job' | 'error'>): AutoState {
	if (a.status === 'complete') return { kind: 'complete' };
	if (a.status === 'failed') return { kind: 'failed', text: a.error ?? 'the run of the rules failed' };
	const n = a.plan.cases.length;
	if (a.job && a.job.status === 'dead') return { kind: 'stopped', text: a.job.error ? `The run stopped: ${a.job.error}` : 'The run stopped.' };
	return { kind: 'running', text: `Fitting ${Math.min(a.cases.length + 1, n)} of ${n} on the server…`, progress: n ? Math.round((100 * a.cases.length) / n) : null };
}

/** Why the kept fit can't be applied now, or null: nothing kept, applied already, unsaved rules or form edits, or a viewer. */
export function applyBlocker(a: Pick<AutoCalibration, 'status' | 'chosen' | 'appliedAt'>, o: { rulesUnsaved: boolean; formDirty: boolean; readonly: boolean }): string | null {
	if (o.readonly) return 'Only an editor can apply a fit.';
	if (a.status !== 'complete' || a.chosen === null) return null;
	if (a.appliedAt) return null;
	if (o.rulesUnsaved) return 'Save the calibration rules first.';
	if (o.formDirty) return 'Save or discard the other changes to the settings first: applying saves the kept fit at once.';
	return null;
}

/** "Started by A. User" / "Queued by new data". */
export const triggerText = (a: Pick<AutoCalibration, 'trigger' | 'createdBy'>) => (a.trigger === 'new_data' ? 'Queued by new data' : `Started by ${a.createdBy ?? 'a former member'}`);
