// Links into the Project page (issue #17, option A), kept apart from the page
// so the Summary can link and redirect here without pulling the page's panels
// into its chunk. The same shape as river/links.ts and supply/links.ts.

/** The page's `?tab=` id. */
export const PROJECT_TAB = 'project';

/**
 * The panels' heading ids, in page order. They were on the Summary, below its
 * first screen, until 2026-09-27, so a bookmarked `/projects/:id#members-h`
 * is sent here (OverviewTab) and lands on the same panel.
 */
export const PROJECT_ANCHORS = [
	'model-h',
	'details-h',
	'import-record-h',
	'recent-notes-h',
	'team-h',
	'members-h',
	'farmers-h',
	'share-h'
] as const;

/** True for a fragment (without the `#`) that names one of the Project page's panels. */
export function projectAnchor(hash: string): boolean {
	return (PROJECT_ANCHORS as readonly string[]).includes(hash);
}

/** `?tab=project`, with a panel's anchor when given. */
export function projectHref(anchor?: string | null): string {
	return `?tab=${PROJECT_TAB}${anchor ? `#${anchor}` : ''}`;
}
