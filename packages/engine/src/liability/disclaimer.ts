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

import { registrationBody } from './registration';

export interface Disclaimer {
	/** Bumped whenever a word changes; sign-offs and packs record it. */
	version: string;
	/** 'draft' while the wording is unreviewed; 'agreed' once accepted. */
	status: 'draft' | 'agreed';
	paragraphs: readonly string[];
}

export const DISCLAIMER: Disclaimer = {
	version: '2026-09-28.2',
	status: 'agreed',
	paragraphs: [
		'These results are estimates from a computer model of the catchment. They are not measurements or predictions of what will happen, and they can be wrong.',
		'This report supports, and does not replace, the specialist hydrology report. It is not an authorisation to use water. Only the responsible authority decides that, under the National Water Act, 1998 (sections 22, 27 and 41).',
		'Modelled shortfalls, curtailment and equitable shares are not official restrictions or allocations. Only a notice from a body with the legal power to make one, such as the responsible authority or the water user association, is.',
		'The person who made this run chose its inputs and settings. Where the run is signed off, the signature is that professional’s own statement.',
		'This software is provided as it is. Its operator did not prepare this report and checks none of its inputs or results. As far as the law allows, the operator accepts no responsibility to anyone who relies on this report for any error in it, whether the error comes from the inputs, the settings or the software, and including an error caused by negligence. Have the results checked by a qualified hydrologist before you act on them. Nothing in this report covers the safety of a dam. Account holders’ use of the service is governed by its Terms of use: {site}/terms.'
	]
};

/**
 * `{site}` in a disclaimer text is the site's own address (e.g.
 * https://water.example.com), filled in where the text is shown: the
 * frontend knows it as its own origin (the server PDF prints the public site,
 * RENDER_SITE_URL), so a printed report carries the Terms URL in full.
 */
export const withSite = (text: string, site: string): string => text.replaceAll('{site}', site.replace(/\/+$/, ''));

/**
 * The report cover's "Read this first" box (delict review §5.2): the
 * disclaimer's key points in normal type, above the contents. `section` is
 * the Disclaimer's section number in that report.
 */
export const REPORT_READ_FIRST = (section: number | string): string =>
	`Model estimates, not measurements or predictions: they can be wrong. Not an authorisation to use water. As far as the law allows, the operator of this software accepts no responsibility to anyone who relies on this report (see the Disclaimer, section ${section}).`;

/**
 * The cover's sign-off status: each signer as the report's sign-off section
 * lists them. The body is a code since signoff-3 (`sacnasp`, printed
 * SACNASP); an older sign-off's free-text body prints as it was typed.
 */
export const REPORT_SIGNED_BY = (signers: readonly { fullName: string; registrationBody: string; registrationNo: string }[]): string =>
	`Signed off by ${signers.map((s) => `${s.fullName} (${registrationBody(s.registrationBody)?.short ?? s.registrationBody} ${s.registrationNo})`).join('; ')}.`;
/** The cover's sign-off status when no one has signed the run. */
export const REPORT_NOT_SIGNED = 'Not signed off by a registered professional.';
/** Also on an unsigned run's cover when it is nominated as evidence or is an impact report (delict review §5.4). */
export const REPORT_NOT_EVIDENCE = 'Not signed off: not for use as evidence in a licence application.';

/** The server PDF's running footer on every page, before its page numbers (backend reports/render.ts). */
export const REPORT_FOOTER = (project: string, run: string, section: number | string): string =>
	`${project} · ${run} · Model estimates; see the Disclaimer (section ${section}, version ${DISCLAIMER.version}). The operator of this software accepts no responsibility to anyone who relies on this report.`;

/**
 * The leading `#` line of every CSV of a run's results (backend
 * export/csv.ts). No comma, quote or `=` so a reader that doesn't skip
 * comments sees one harmless text cell.
 */
export const CSV_DISCLAIMER_COMMENT = `# model estimates that can be wrong; not an authorisation to use water; as far as the law allows the operator of this software accepts no responsibility to anyone who relies on this file; see the report disclaimer (version ${DISCLAIMER.version})`;

/** The line shown beside a draft disclaimer. */
export const DISCLAIMER_DRAFT_NOTE = 'Draft wording, pending the client’s legal review (decision D10).';

/**
 * Where a forecast run's forecast rain came from (stored with the run,
 * backend runs/execute.ts): 'chirps_gefs' when every forecast day was written
 * by a CHIRPS-GEFS data feed, 'other' otherwise (an uploaded forecast, or
 * days a person wrote over).
 */
export type ForecastRainSource = 'chirps_gefs' | 'other';

/**
 * The line a report of a forecast run prints (WP-2.12): from `from` (its
 * first forecast day, YYYY-MM-DD as the report prints dates) the run uses
 * forecast rain, not recorded rain. It credits CHIRPS-GEFS only when the
 * run recorded that source; any other or unknown source gets the plain line,
 * so an uploaded forecast is never attributed to it.
 */
export function FORECAST_RAIN_NOTE(from: string, source?: ForecastRainSource | null): string {
	const what = source === 'chirps_gefs' ? 'forecast rain (CHIRPS-GEFS, Climate Hazards Center, doi:10.15780/G2PH2M)' : 'forecast rain';
	return `From ${from}, this run uses ${what}, not recorded rain. Rain forecasts are often wrong, more so further ahead, and each new forecast replaces the last.`;
}
