// The disclaimer printed on the report and its results (roadmap WP-3.13,
// Step 2 decision D10). DRAFT: the wording has not been through the client's
// legal adviser; docs/followups.md § Blocking releases (operator) tracks that,
// and docs/legal/disclaimer-review.md is the pack sent for the review (its
// quotes are tested against this file).
// Every surface that shows it also shows `DISCLAIMER.status === 'draft'` as a
// visible "draft, pending legal review" line, so an unreviewed text can't
// pass for the agreed one. Change the words → bump `version` (a sign-off
// records the version it was shown).

export interface Disclaimer {
	/** Bumped whenever a word changes; sign-offs and packs record it. */
	version: string;
	/** 'draft' until the client's legal adviser has agreed the wording. */
	status: 'draft' | 'agreed';
	paragraphs: readonly string[];
}

export const DISCLAIMER: Disclaimer = {
	version: 'draft-2026-09-26',
	status: 'draft',
	paragraphs: [
		'These results come from a computer model of the catchment. They are estimates made from the historical record of rainfall and flow, not measurements or forecasts, and they can be wrong.',
		'This report supports, and does not replace, the specialist hydrology report. Any decision on a water-use licence belongs to the responsible authority (National Water Act, sections 27 and 41).',
		'Modelled shortfalls, curtailment and equitable shares are not official restrictions or allocations. Only a notice from the Water User Association or the responsible authority is.',
		'The platform operator gives no hydrological opinion. The model, its inputs and its results are the responsibility of the person who made the run and, where the run is signed off, of the professional who signed it.'
	]
};

/** The line shown beside a draft disclaimer. */
export const DISCLAIMER_DRAFT_NOTE = 'Draft wording, pending the client’s legal review (decision D10).';
