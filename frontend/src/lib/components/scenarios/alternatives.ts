// The mitigation alternatives a scenario cites (MitigationAlternatives.svelte;
// 298_scenario_alternatives, docs/scenarios.md § Mitigation alternatives):
// up to ALTERNATIVES_MAX labelled runs of the caller's own other scenarios on
// the same base run, which the evidence report sets beside the scenario on
// page 1. Pure helpers, so the draft's problems, what a Save sends and the
// lines the fold shows are tested without the component.
import { ALTERNATIVES_MAX } from '@water-management/engine';
import type { AlternativeCandidate, ScenarioAlternative } from '#lib/api/index.js';
import { fmtStamp } from '#lib/format/number.js';

/** Most characters in a label (the backend's ALTERNATIVE_LABEL_MAX, 298's CHECK). */
export const ALTERNATIVE_LABEL_MAX = 80;

/** One row as the form edits it: the run picked ('' = none yet) and its label. */
export interface AlternativeDraft {
	runId: string;
	label: string;
}

export const draftOf = (list: readonly ScenarioAlternative[]): AlternativeDraft[] => list.map((a) => ({ runId: a.runId, label: a.label }));

/** The draft as a Save sends it: labels trimmed. */
export const cleaned = (d: readonly AlternativeDraft[]): AlternativeDraft[] => d.map((x) => ({ runId: x.runId, label: x.label.trim() }));

/** What's wrong with a draft before it is sent, one line each; empty when it may be saved. */
export function draftProblems(d: readonly AlternativeDraft[]): string[] {
	const out: string[] = [];
	if (d.length > ALTERNATIVES_MAX) out.push(`Cite at most ${ALTERNATIVES_MAX} alternatives, so page 1 stays readable.`);
	cleaned(d).forEach((x, i) => {
		if (!x.runId) out.push(`Alternative ${i + 1} needs a run picked.`);
		if (!x.label) out.push(`Alternative ${i + 1} needs a label (“smaller dam”, “winter abstraction only”).`);
		else if (x.label.length > ALTERNATIVE_LABEL_MAX) out.push(`Alternative ${i + 1}’s label is longer than ${ALTERNATIVE_LABEL_MAX} characters.`);
	});
	const runs = d.map((x) => x.runId).filter(Boolean);
	if (runs.some((r, i) => runs.indexOf(r) !== i)) out.push('Each alternative is another run: one is picked twice.');
	return out;
}

/** Whether a Save would change anything. */
export const draftChanged = (d: readonly AlternativeDraft[], stored: readonly ScenarioAlternative[]): boolean =>
	JSON.stringify(cleaned(d)) !== JSON.stringify(draftOf(stored));

/** A run as a pick list names it: its scenario, then its label or when it ran. */
export const runName = (r: Pick<AlternativeCandidate, 'scenarioName' | 'runLabel' | 'runCreatedAt'>): string =>
	`${r.scenarioName} — ${r.runLabel || `run of ${fmtStamp(r.runCreatedAt)}`}`;

/** The one-line summary the fold shows closed. */
export function alternativesSummary(list: readonly ScenarioAlternative[]): string {
	if (!list.length) return 'None cited';
	return list.map((a) => a.label).join(' · ');
}
