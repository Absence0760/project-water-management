// The "On this page" menu shared by the long workspace tabs (SectionNav.svelte):
// Settings & calibration and Runs & results.

export interface NavSection {
	id: string;
	label: string;
	/** Marks the link with a dot and "(has a problem)" for screen readers. */
	problem?: boolean;
}

export interface NavGroup {
	/** The group's name before its links; null for a group that needs none. */
	label: string | null;
	sections: NavSection[];
}

/**
 * The section being read, for the menu's scroll spy: the last one whose top
 * has scrolled up to `line` (px from the viewport top, just under the sticky
 * menu), else the first. At the bottom of the page it is the last section,
 * since a short final panel may never reach the line. `tops` are viewport
 * offsets in page order; sections not rendered yet are simply absent.
 */
export function activeSectionId(tops: { id: string; top: number }[], line: number, atBottom = false): string | null {
	if (!tops.length) return null;
	if (atBottom) return tops[tops.length - 1]!.id;
	let current = tops[0]!.id;
	for (const t of tops) {
		if (t.top <= line) current = t.id;
		else break;
	}
	return current;
}
