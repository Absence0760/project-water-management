// Appendix C's fixed prompts (evidence-8, issue #71 follow-up; docs/design/evidence-report.md
// § 4.3): the three questions every application's statement answers, the same
// wording where the scenario is edited and in the report. Each answer is the
// applicant's (or modeller's) own words, printed verbatim, or "Not given" when
// blank: a fixed list, so a reader sees what was not answered rather than a
// narrative that leaves it out (G13).

/** The answers, as the scenario stores them (129_scenario_statement); '' = not given. */
export interface ApplicantPrompts {
	purposeAndNeed: string;
	mitigation: string;
	monitoring: string;
}

export type ApplicantPromptId = keyof ApplicantPrompts;

/** Longest answer, in characters (the columns' CHECK, as the scenario description's). */
export const APPLICANT_PROMPT_MAX = 4000;

/** The prompts in the order they print: a heading and the question it asks. */
export const APPLICANT_PROMPTS: readonly { id: ApplicantPromptId; heading: string; question: string }[] = [
	{
		id: 'purposeAndNeed',
		heading: 'Purpose and need',
		question: 'What is the change for, and why is this water needed: what do the works serve, and why would less water or another source not do?'
	},
	{
		id: 'mitigation',
		heading: 'Mitigation',
		question:
			'What will be done to avoid, reduce or offset the effect on the river and on other users: releases, a lower take in dry months, a smaller dam, a condition you accept?'
	},
	{
		id: 'monitoring',
		heading: 'Monitoring',
		question: 'How will the effect be measured once the works are built: what is measured, where, how often, by whom, and who sees the records?'
	}
];

/** No answers yet. */
export const NO_PROMPTS: ApplicantPrompts = { purposeAndNeed: '', mitigation: '', monitoring: '' };
