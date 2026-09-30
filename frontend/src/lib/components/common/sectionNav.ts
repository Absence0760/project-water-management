// The "On this page" menu shared by the long workspace pages (SectionNav.svelte):
// Settings & calibration, Runs & results, River & reserve, Units & supply and Data.

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
 * since a short final panel may never reach the line, unless the section a
 * followed link named (`target`, the URL's fragment) still starts on the
 * screen (its top between 0 and `viewH`): when the panels after it are
 * shorter than the window, the page ends before its top can reach the line,
 * and it is the one being read (River & reserve's `#res-outlook` once the
 * water account got shorter, issue #175). `tops` are viewport offsets in page
 * order; sections not rendered yet are simply absent.
 */
export function activeSectionId(
	tops: { id: string; top: number }[],
	line: number,
	atBottom = false,
	target: string | null = null,
	viewH = Infinity
): string | null {
	if (!tops.length) return null;
	if (atBottom) {
		const t = target ? tops.find((x) => x.id === target) : undefined;
		return t && t.top >= 0 && t.top < viewH ? t.id : tops[tops.length - 1]!.id;
	}
	let current = tops[0]!.id;
	for (const t of tops) {
		if (t.top <= line) current = t.id;
		else break;
	}
	return current;
}

/** One link's box on the menu's bar (SectionNav measures them). */
export interface NavBox {
	/** The link's own width. */
	width: number;
	/** It starts a group (after the first), so a wider gap sits before it. */
	groupStart: boolean;
}

export interface NavFit {
	/** The width the links flow across. */
	avail: number;
	/** Taken on the first row before the links: the "On this page" label and its gap. */
	lead: number;
	/** The space after every link. */
	gap: number;
	/** The space before a group's first link, in place of the previous link's `gap`. */
	groupGap: number;
	/** The More button's width, for when some links go into it. */
	more: number;
	/** The most rows the bar may take. */
	rows: number;
}

/** How many rows the boxes take flowing like words across `avail`, the first row starting at `lead`. */
function rowCount(boxes: number[], avail: number, lead: number): number {
	let rows = 1;
	let x = lead;
	let lineStart = true;
	for (const w of boxes) {
		// Half a pixel of slack: the widths are fractional (getBoundingClientRect).
		if (!lineStart && x + w > avail + 0.5) {
			rows++;
			x = 0;
		}
		x += w;
		lineStart = false;
	}
	return rows;
}

/**
 * How many of the menu's links stay on its bar, in page order, so the bar
 * takes at most `rows` rows; the rest go into a More menu at the bar's end.
 * The links flow like words, so a group may break across rows (as whole
 * blocks, a long group pushed the next one onto a row of its own: three rows
 * at 1280 px). Every link has `gap` after it and a group's first link the
 * extra `groupGap - gap` before it, as SectionNav lays them out; the More
 * button is set apart like a group, and has its own `gap` after it like every
 * item (a line's trailing margin counts in inline layout: without it the fit
 * put More 4.9 px past the edge, where it wrapped to a third row).
 * `items.length` when everything fits.
 */
export function navFitCount(items: NavBox[], fit: NavFit): number {
	const extra = Math.max(0, fit.groupGap - fit.gap);
	const boxes = items.map((it, i) => it.width + fit.gap + (it.groupStart && i > 0 ? extra : 0));
	if (rowCount(boxes, fit.avail, fit.lead) <= fit.rows) return items.length;
	const more = fit.more + fit.gap + extra;
	for (let k = items.length - 1; k > 0; k--) {
		if (rowCount([...boxes.slice(0, k), more], fit.avail, fit.lead) <= fit.rows) return k;
	}
	return 0;
}
