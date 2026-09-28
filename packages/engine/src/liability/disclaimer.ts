// The disclaimer printed on the report and its results (roadmap WP-3.13,
// Step 2 decision D10). The wording below was accepted by the operator on
// 2026-09-28, after a pre-counsel review; no external legal adviser has
// reviewed it. docs/legal/disclaimer-review.md is the review pack (its quotes
// are tested against this file).
// A future edit may go back to `status: 'draft'` (with a `draft-` version):
// every surface that shows the disclaimer then shows DISCLAIMER_DRAFT_NOTE as
// a visible "draft, pending legal review" line, so an unreviewed text can't
// pass for the agreed one. Change the words → bump `version` (a sign-off
// records the version it was shown).

export interface Disclaimer {
	/** Bumped whenever a word changes; sign-offs and packs record it. */
	version: string;
	/** 'draft' while the wording is unreviewed; 'agreed' once accepted. */
	status: 'draft' | 'agreed';
	paragraphs: readonly string[];
}

export const DISCLAIMER: Disclaimer = {
	version: '2026-09-28',
	status: 'agreed',
	paragraphs: [
		'These results are estimates from a computer model of the catchment. They are not measurements or predictions of what will happen, and they can be wrong.',
		'This report supports, and does not replace, the specialist hydrology report. It is not an authorisation to use water. Only the responsible authority decides that, under the National Water Act, 1998 (sections 22, 27 and 41).',
		'Modelled shortfalls, curtailment and equitable shares are not official restrictions or allocations. Only a notice from a body with the legal power to make one, such as the responsible authority or the water user association, is.',
		'The person who made this run chose its inputs and settings. Where the run is signed off, the signature is that professional’s own statement.',
		'This software is provided as it is. Its operator did not prepare this report, checks none of its inputs or results, and, as far as the law allows, accepts no responsibility to anyone who relies on it. Have the results checked by a qualified hydrologist before you act on them. Account holders’ use of the service is governed by its Terms of use.'
	]
};

/** The line shown beside a draft disclaimer. */
export const DISCLAIMER_DRAFT_NOTE = 'Draft wording, pending the client’s legal review (decision D10).';

/**
 * The line a report of a forecast run prints (WP-2.12): from `from` (its
 * first forecast day, YYYY-MM-DD as the report prints dates) the run uses
 * CHIRPS-GEFS forecast rain, not recorded rain.
 */
export const FORECAST_RAIN_NOTE = (from: string): string =>
	`From ${from}, this run uses forecast rain (CHIRPS-GEFS, Climate Hazards Center, doi:10.15780/G2PH2M), not recorded rain. Rain forecasts are often wrong, more so further ahead, and each new forecast replaces the last.`;
