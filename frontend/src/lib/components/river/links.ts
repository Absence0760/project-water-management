// Links into River & reserve (issue #17), kept apart from river.ts so the
// Summary and Runs & results can link here without pulling the page's
// helpers into their chunks.

/** The panels' ids, in page order (findings, then the tools, issue #465): they were Runs & results' River & Reserve group (runs/sections.ts). */
export const RIVER_ANCHORS = [
	'res-ewr',
	'res-reserve-years',
	'res-reserve',
	'res-ewr-grid',
	'res-water-account',
	'res-uncertainty',
	'res-outcomes',
	'res-outlook'
] as const;

/**
 * The two monthly panels' headings on River & reserve, which tell them apart
 * (issue #465): Reserve compliance (`#res-reserve`) counts the months a
 * Reserve rule table's requirement was met; the EWR grid (`#res-ewr-grid`)
 * counts the days below the daily EWR. Both were "… compliance by month".
 * The printable report and Compare runs keep the panels' own names. Here
 * rather than in river.ts so Runs & results' side index can name them too
 * (issue #462).
 */
export const RESERVE_MONTHS_HEADING = 'Reserve rules met, by month';
export const EWR_MONTHS_HEADING = 'Days below the EWR, by month';

/** True for a `#res-…` fragment that now lives on River & reserve (without the `#`). */
export function riverAnchor(hash: string): boolean {
	return (RIVER_ANCHORS as readonly string[]).includes(hash);
}

/** `?tab=river`, with the run (`&run=`) and a panel (`#res-…`) when given. */
export function riverHref(runId?: string | null, anchor?: string | null): string {
	return `?tab=river${runId ? `&run=${encodeURIComponent(runId)}` : ''}${anchor ? `#${anchor}` : ''}`;
}
