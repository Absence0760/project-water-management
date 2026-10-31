// The assessors' "Assess together" view (CumulativeAssessment.svelte, roadmap
// WP-3.11, docs/ui.md § Applications › Assess together): which applications
// can be picked together, the report's rows as the matrix shows them, and its
// CSV. Pure, so it is unit-tested without a component.
import { CUMULATIVE_METRIC_LABEL, type CumulativeReport, type CumulativeRow } from '@water-management/engine';
import type { Assessment, AssessmentBackground, AssessorQuestion, Scenario } from '#lib/api/types.js';
import { fmtNum, fmtPct, fmtQty } from '#lib/format/number.js';

/** Applications an assessor can assess together: submitted or decided (a draft is the applicant's, a withdrawn one is off the table). */
export function assessable(items: readonly Scenario[]): Scenario[] {
	return items.filter((a) => a.status === 'submitted' || a.status === 'decided');
}

/**
 * Why `id` can't be ticked beside `picked` (null when it can): an
 * assessment is on one base run, so once one is picked the others must
 * share its base.
 */
export function pickBlocked(items: readonly Scenario[], picked: readonly string[], id: string): string | null {
	const first = items.find((a) => picked.includes(a.id) && a.id !== id);
	const me = items.find((a) => a.id === id);
	if (!first || !me || first.baseRunId === me.baseRunId) return null;
	return `based on another run than “${first.name}”`;
}

/** A row's measure and site, as the matrix's row header reads. */
export function rowLabel(r: Pick<CumulativeRow, 'metric' | 'site' | 'isOutlet'>): { measure: string; site: string } {
	return { measure: CUMULATIVE_METRIC_LABEL[r.metric], site: r.site === null ? 'Catchment' : r.isOutlet ? `Outlet (${r.site})` : r.site };
}

/** One value in its unit: days and months whole, volumes in m³ or m³/day, a share as a percentage. */
export function valueText(v: number | null, unit: string): string {
	if (v === null) return '–';
	if (unit === 'fraction') return fmtPct(v);
	if (unit === 'days' || unit === 'months') return fmtNum(v);
	return `${fmtQty(v)} ${unit}`;
}

/** A change, signed (+, − or ±0), in its unit; a share's change in percentage points. */
export function changeText(v: number | null, unit: string): string {
	if (v === null) return '–';
	const sign = v > 0 ? '+' : v < 0 ? '−' : '±';
	const a = Math.abs(v);
	if (unit === 'fraction') return `${sign}${fmtNum(a * 100, 1)} pts`;
	if (unit === 'days' || unit === 'months') return `${sign}${fmtNum(a)}`;
	return `${sign}${fmtQty(a)} ${unit}`;
}

/** Whether a change is worse for the river or its users, better, or neither (within float noise of the measure). */
export function changeTone(v: number | null, higherIsWorse: boolean, scale = 1): 'worse' | 'better' | 'none' {
	if (v === null || Math.abs(v) <= 1e-9 * Math.max(1, Math.abs(scale))) return 'none';
	return v > 0 === higherIsWorse ? 'worse' : 'better';
}

/** The interaction, in plain words, for the cell's title and the screen reader. */
export function interactionWords(r: CumulativeRow): string {
	const v = r.interaction;
	const tone = changeTone(v, r.higherIsWorse, r.baseline ?? 1);
	if (v === null) return 'Not assessed: a run has no value here.';
	if (tone === 'none') return 'Together they change this by what their separate changes add up to.';
	return tone === 'worse'
		? `Together they make this ${changeText(Math.abs(v), r.unit).slice(1)} worse than their separate changes add up to.`
		: `Together they make this ${changeText(Math.abs(v), r.unit).slice(1)} better than their separate changes add up to.`;
}

/** A CSV cell: quoted when it needs it, and text starting = + - @ guarded with an apostrophe (CSV injection; names are user text). */
function cell(v: string | number | null): string {
	if (v === null) return '';
	if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
	const guarded = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
	return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * The hydrologist's baseline value of a background row's measure at its site
 * (295): the background is shown beside the baseline, so each of its rows
 * says how far full allocation moves it. Null when the baseline's table has
 * no such row or no value.
 */
export function baselineOf(report: Pick<CumulativeReport, 'rows'>, r: Pick<CumulativeRow, 'metric' | 'siteNodeId' | 'isOutlet'>): number | null {
	return report.rows.find((x) => x.metric === r.metric && x.siteNodeId === r.siteNodeId && x.isOutlet === r.isOutlet)?.baseline ?? null;
}

/**
 * The report as CSV: one line per row, the raw numbers (the matrix rounds),
 * each application alone and all together. With a background at full
 * allocation (295), a blank line, its label and run, and its own table, the
 * background in the baseline's column. With questions, a blank line and
 * then the applicants' "Ask the assessors why" questions on these
 * applications, one line each with the answer (issue #523 G7: the
 * applications' record for the authority's s42 written reasons).
 */
export function assessmentCsv(report: CumulativeReport & { background?: AssessmentBackground }, questions: readonly AssessorQuestion[] = []): string {
	const names = report.scenarios.map((s) => s.name);
	const head = [
		'Measure',
		'Site',
		'Unit',
		'Baseline',
		...names.map((n) => `${n} alone`),
		'All together',
		...names.map((n) => `Change: ${n} alone`),
		'Sum of changes alone',
		'Change together',
		'Interaction (together − sum)'
	];
	const lines = report.rows.map((r) => {
		const { measure, site } = rowLabel(r);
		return [measure, site, r.unit, r.baseline, ...r.singles, r.combined, ...r.singleChanges, r.sumOfSingles, r.combinedChange, r.interaction];
	});
	const table: (string | number | null)[][] = [head, ...lines];
	const bg = report.background;
	if (bg) {
		const bgNames = bg.report.scenarios.map((s) => s.name);
		table.push(
			[],
			[`${bg.label}: ${bg.run.label || bg.run.scenarioName || 'background run'}`, 'A separate comparison: the baseline above stays the hydrologist’s run'],
			[
				'Measure',
				'Site',
				'Unit',
				'Baseline',
				'Background (full allocation)',
				...bgNames.map((n) => `${n} alone`),
				'All together',
				...bgNames.map((n) => `Change: ${n} alone`),
				'Sum of changes alone',
				'Change together',
				'Interaction (together − sum)'
			]
		);
		for (const r of bg.report.rows) {
			const { measure, site } = rowLabel(r);
			table.push([measure, site, r.unit, baselineOf(report, r), r.baseline, ...r.singles, r.combined, ...r.singleChanges, r.sumOfSingles, r.combinedChange, r.interaction]);
		}
	}
	if (questions.length) {
		table.push([], ['Application', 'Asked', 'The applicant read', 'In its own words', 'Answer', 'Answered']);
		for (const q of questions) table.push([q.scenarioName, q.askedAt, q.problem, q.assessorText, q.answer, q.answeredAt]);
	}
	return table.map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n';
}

export type AssessmentState = { kind: 'complete' } | { kind: 'pending'; text: string; progress: number | null } | { kind: 'stopped'; text: string; lines: string[] };

/**
 * Where an assessment stands, from its own status, its job's and its dams' firm-yield jobs' (297: its job done,
 * the yields still coming back); a refused or failed one says why, line by line.
 */
export function assessmentState(a: Pick<Assessment, 'status' | 'job' | 'problems' | 'yields'>): AssessmentState {
	if (a.status === 'complete') return { kind: 'complete' };
	if (a.status === 'refused') return { kind: 'stopped', text: 'These applications no longer combine on their baseline:', lines: a.problems };
	if (a.status === 'failed') return { kind: 'stopped', text: 'The model could not run this assessment:', lines: a.problems };
	const y = a.yields;
	if (y && y.total > 0 && a.job?.status === 'done')
		return { kind: 'pending', text: `Working out the firm yield of each dam the applications touch (${y.done} of ${y.total})…`, progress: Math.round((100 * y.done) / y.total) };
	const j = a.job;
	if (!j) return { kind: 'stopped', text: 'This assessment did not finish, and its job has been cleared. Start a new one.', lines: [] };
	if (j.status === 'dead') return { kind: 'stopped', text: `This assessment could not run${j.error ? `: ${j.error}` : '.'}`, lines: [] };
	if (j.status === 'running') return { kind: 'pending', text: 'Running each application alone and all together…', progress: j.progress ?? null };
	if (j.status === 'failed') return { kind: 'pending', text: `The assessment failed and will be tried again${j.error ? ` (${j.error})` : ''}.`, progress: null };
	return { kind: 'pending', text: 'Queued: waiting for the background worker.', progress: null };
}
