// Links into the EWR page (River & reserve until issue #558; issue #17),
// kept apart from river.ts so the Summary and Runs & results can link here
// without pulling the page's helpers into their chunks.

/** The panels' ids, in page order (findings, then the tools, issue #465): they were Runs & results' River & Reserve group (runs/sections.ts). */
export const RIVER_ANCHORS = [
	'res-ewr',
	'res-reserve-years',
	'res-reserve',
	'res-ewr-grid',
	'res-water-account',
	'res-uncertainty',
	'res-sensitivity',
	'res-outcomes',
	'res-outlook'
] as const;

/**
 * The two monthly panels' headings on the EWR page, which tell them apart
 * (issue #465): Reserve compliance (`#res-reserve`) counts the months a
 * Reserve rule table's requirement was met; the EWR grid (`#res-ewr-grid`)
 * counts the days below the daily EWR. Both were "… compliance by month".
 * The printable report and Compare runs keep the panels' own names. Here
 * rather than in river.ts so Runs & results' side index can name them too
 * (issue #462).
 */
export const RESERVE_MONTHS_HEADING = 'Reserve rules met, by month';
export const EWR_MONTHS_HEADING = 'Days below the EWR, by month';

/**
 * The reserve strip beside the tiles (the Summary's until issue #558): linkable, but on the first screen, so
 * not in the page's menu, which lists the panels below it.
 */
export const RIVER_STRIP_ANCHOR = 'res-reserve-strip';

/** True for a `#res-…` fragment that now lives on the EWR page (without the `#`). */
export function riverAnchor(hash: string): boolean {
	return hash === RIVER_STRIP_ANCHOR || (RIVER_ANCHORS as readonly string[]).includes(hash);
}

/**
 * The Summary's old ids for the reserve strip (issue #558 moved it to the EWR page): an old
 * `?tab=overview#strip-h` link opens it there.
 */
export const SUMMARY_STRIP_ANCHORS: readonly string[] = ['strip-h', 'reserve-strip'];

/** Where an old Summary fragment now lives on the EWR page (without the `#`), or null when it is still the Summary's. */
export function summaryToRiverAnchor(hash: string): string | null {
	if (SUMMARY_STRIP_ANCHORS.includes(hash)) return RIVER_STRIP_ANCHOR;
	return riverAnchor(hash) ? hash : null;
}

/** `?tab=river` (the EWR page), with the run (`&run=`) and a panel (`#res-…`) when given. */
export function riverHref(runId?: string | null, anchor?: string | null): string {
	return `?tab=river${runId ? `&run=${encodeURIComponent(runId)}` : ''}${anchor ? `#${anchor}` : ''}`;
}
