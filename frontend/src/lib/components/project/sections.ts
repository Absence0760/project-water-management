// The Project page's "On this page" menu (common/SectionNav, issue #586 R1-E):
// a side index from a 1440 px window, the two-row bar below that, one sideways
// strip on a phone. Its links are read from the page rather than listed here:
// every id in PROJECT_ANCHORS (links.ts) whose panel is drawn, named by its
// heading as drawn, grouped by the column it sits in (`data-nav-group`). So a
// panel that only some readers see (Share links, owners only), one that only
// some projects have (Import record) and a panel added to PROJECT_ANCHORS later
// show up, or don't, with no change here.
import type { NavGroup } from '#lib/components/common/sectionNav.js';
import { PROJECT_ANCHORS } from './links';

/** A panel the page draws: its anchor id, its heading's words and the group (column) it sits in. */
export interface DrawnPanel {
	id: string;
	label: string;
	group: string | null;
}

/**
 * A heading's words for the menu: its text with white space collapsed and a
 * trailing count dropped ("Farmers (3)" is "Farmers"), so the link keeps its
 * name, and the bar its fit, while the count loads and changes.
 */
export function panelLabel(text: string): string {
	return text
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\s*\(\d[\d\s]*\)$/, '');
}

/**
 * The menu's groups: the drawn panels in PROJECT_ANCHORS order, each group
 * named by its column, in the order its first panel comes. `find` says how a
 * panel is drawn, or null when it isn't (the page reads it from the DOM).
 */
export function projectNavGroups(find: (id: string) => Omit<DrawnPanel, 'id'> | null, anchors: readonly string[] = PROJECT_ANCHORS): NavGroup[] {
	const groups: NavGroup[] = [];
	for (const id of anchors) {
		const panel = find(id);
		if (!panel || !panel.label) continue;
		let group = groups.find((g) => g.label === panel.group);
		if (!group) groups.push((group = { label: panel.group, sections: [] }));
		group.sections.push({ id, label: panel.label });
	}
	return groups;
}

/** True when two menus list the same links under the same names (so the page doesn't redraw its menu for nothing). */
export function sameNav(a: NavGroup[], b: NavGroup[]): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
