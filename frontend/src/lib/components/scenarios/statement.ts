// The applicant's statement on a scenario (ScenarioStatement.svelte): the
// answers to the evidence report's Appendix C prompts (engine
// APPLICANT_PROMPTS, 129_scenario_statement). Pure helpers, so the draft's
// dirtiness and the PATCH it sends are tested without the component.
import { APPLICANT_PROMPTS, type ApplicantPrompts } from '@water-management/engine';

/** A scenario's stored answers, keyed as the prompts are. */
export const storedAnswers = (s: ApplicantPrompts): ApplicantPrompts => ({
	purposeAndNeed: s.purposeAndNeed,
	mitigation: s.mitigation,
	monitoring: s.monitoring
});

/**
 * What a Save sends: each answer whose trimmed text differs from the stored
 * one, trimmed (the server trims too, so whitespace alone is "Not given").
 * Empty when nothing changed.
 */
export function statementPatch(draft: ApplicantPrompts, stored: ApplicantPrompts): Partial<ApplicantPrompts> {
	const out: Partial<ApplicantPrompts> = {};
	for (const { id } of APPLICANT_PROMPTS) {
		const next = draft[id].trim();
		if (next !== stored[id].trim()) out[id] = next;
	}
	return out;
}

/** How many prompts have an answer (non-blank). */
export const answeredCount = (a: ApplicantPrompts): number => APPLICANT_PROMPTS.filter(({ id }) => a[id].trim() !== '').length;
