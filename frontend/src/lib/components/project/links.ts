// Links into the Project page (issue #17, option A), kept apart from the page
// so the Summary can link and redirect here without pulling the page's panels
// into its chunk. The same shape as river/links.ts and supply/links.ts.

/** The page's `?tab=` id. */
export const PROJECT_TAB = 'project';

/**
 * Every panel's heading id, in page order (the left column, then the right).
 * Most were on the Summary, below its first screen, until 2026-09-27, so a
 * bookmarked `/projects/:id#members-h` is sent here (OverviewTab) and lands on
 * the same panel; the licence record's email links `#licence-record` (issue
 * #586). project.test.ts checks the list against the headings the page draws.
 */
export const PROJECT_ANCHORS = [
	'details-h',
	'import-record-h',
	'recent-notes-h',
	'model-h',
	'team-h',
	'members-h',
	'regcheck-h',
	'authority-h',
	'delegates-h',
	'farmers-h',
	'share-h',
	'project-two-step-h',
	'licence-record'
] as const;

/** True for a fragment (without the `#`) that names one of the Project page's panels. */
export function projectAnchor(hash: string): boolean {
	return (PROJECT_ANCHORS as readonly string[]).includes(hash);
}

/** `?tab=project`, with a panel's anchor when given. */
export function projectHref(anchor?: string | null): string {
	return `?tab=${PROJECT_TAB}${anchor ? `#${anchor}` : ''}`;
}
