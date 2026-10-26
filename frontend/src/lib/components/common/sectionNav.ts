// The "On this page" menu shared by the long workspace pages (SectionNav.svelte):
// Model settings, Runs & results, EWR, Hydrological units, Data
// and Compare runs, and the Network node sheet's form (in a box of its own, `onjump`).

export interface NavSection {
	id: string;
	/**
	 * Its name: the panel's heading word for word, as the page shows it (issue #462), on the bar, in the rail, the
	 * More menu and the find box alike (issue #586 D4). There is no shorter bar name: a bar that can't fit two rows
	 * has too many panels for one menu.
	 */
	label: string;
	/** Marks the link with a dot and "(has a problem)" for screen readers. */
	problem?: boolean;
	/**
	 * A link to another page instead of a panel on this one (`?tab=series`): it is
	 * listed like the rest but never marked as the section being read.
	 */
	href?: string;
	/**
	 * The page an `href` link goes to ("EWR"): screen readers hear
	 * ", on EWR" after its name (`pageLinkName`), as its group's heading says it to the eye.
	 */
	page?: string;
	/**
	 * The ids of the panels after it that this one link stands for (Runs &
	 * results' "Notes & evidence"): the link is marked while any of them is
	 * read, and the find box searches them as part of it.
	 */
	covers?: string[];
	/**
	 * A sub-heading of the section before it (the Calibration page's lines under Calibration against observed flow,
	 * issue #586 D4): the rail indents it under its panel, so it doesn't read as a panel of its own.
	 */
	sub?: boolean;
}

export interface NavGroup {
	/** The group's name before its links; null for a group that needs none. */
	label: string | null;
	sections: NavSection[];
}

/**
 * A link to another page's name for screen readers, "<what it says>, on <page>" (issue #462), carried as its
 * aria-label; null for a link on this page, which its text names. Not a hidden span after the text: the
 * hidden class positions it, and Chromium then spaces it off ("by month , on EWR").
 */
export function pageLinkName(sec: Pick<NavSection, 'label' | 'page' | 'problem'>): string | null {
	if (!sec.page) return null;
	return `${sec.label}, on ${sec.page}${sec.problem ? ' (has a problem)' : ''}`;
}

/** True when the groups list no section at all: the menu then draws nothing, only the page's content. */
export function navEmpty(groups: NavGroup[]): boolean {
	return !groups.some((g) => g.sections.length > 0);
}

/**
 * The section being read, for the menu's scroll spy: the last one whose top
 * has scrolled up to `line` (px from the viewport top, just under the sticky
 * menu), else the first. At the bottom of the page it is the last section,
 * since a short final panel may never reach the line, unless the section a
 * followed link named (`target`, the URL's fragment) still starts on the
 * screen (its top between 0 and `viewH`): when the panels after it are
 * shorter than the window, the page ends before its top can reach the line,
 * and it is the one being read (the EWR page's `#res-outlook` once the
 * water account got shorter, issue #175). And a page short enough that its first
 * section still starts on the screen at the bottom shows every section at once:
 * nothing has been scrolled past, so it is the first (the Calibration page's two
 * parts, issue #586). `tops` are viewport offsets in page order; sections not
 * rendered yet are simply absent.
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
		if (t && t.top >= 0 && t.top < viewH) return t.id;
		return tops[0]!.top >= 0 ? tops[0]!.id : tops[tops.length - 1]!.id;
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

/** A setting's name for the menu's find box: its words, lower case, without accents. */
export function foldText(text: string): string {
	return text
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();
}

/** Whether every word of `query` starts a word of (or is inside) `text`: "pan coef" finds "Pan coefficient". */
export function matchesQuery(text: string, query: string): boolean {
	const words = foldText(query).split(' ').filter(Boolean);
	if (!words.length) return false;
	const hay = foldText(text);
	return words.every((w) => hay.includes(w));
}

/**
 * A setting that moved to another page (issue #521: Settings' registered-volumes comparison band went
 * to Allocations): the find box still lists it, as a link to where it is now. `words` are other names
 * a reader may search it by, matched with its name but never shown.
 */
export interface FindElsewhere {
	text: string;
	words?: string;
	href: string;
	/** The page it is on now ("Allocations"), shown after its name. */
	page: string;
}

/** The moved settings whose name or other names match `query`, in their given order. */
export function findElsewhere(list: readonly FindElsewhere[], query: string): FindElsewhere[] {
	if (!foldText(query)) return [];
	return list.filter((e) => matchesQuery(`${e.text} ${e.words ?? ''}`, query));
}

/** One thing the find box can list: a section, or a setting inside one. */
export interface FindEntry {
	/** The section it is in. */
	sectionId: string;
	/** What it is called on the page. */
	text: string;
	/** Its index in the page's list of settings, or -1 for the section itself. */
	index: number;
}

/**
 * What the find box lists for `query`, in page order: each section whose name
 * matches, and each setting whose name does (once per section and name), at
 * most `limit` in all.
 */
export function findEntries(
	sections: { id: string; label: string }[],
	settings: { sectionId: string; text: string }[],
	query: string,
	limit = 40
): FindEntry[] {
	if (!foldText(query)) return [];
	const out: FindEntry[] = [];
	for (const sec of sections) {
		if (matchesQuery(sec.label, query)) out.push({ sectionId: sec.id, text: sec.label, index: -1 });
		const seen = new Set<string>();
		settings.forEach((st, i) => {
			if (st.sectionId !== sec.id) return;
			const key = foldText(st.text);
			if (seen.has(key) || key === foldText(sec.label) || !matchesQuery(st.text, query)) return;
			seen.add(key);
			out.push({ sectionId: sec.id, text: st.text, index: i });
		});
	}
	return out.slice(0, limit);
}

/**
 * On a phone the bar is one strip that scrolls sideways: where to scroll it so
 * the link at `left` (from the strip's start) and `width` wide shows whole,
 * with `margin` px beside it, or null when it already does. A link Tab reaches
 * half off the strip's edge stays there otherwise: the browser scrolls a
 * focused element only when none of it shows (issue #586, at 320 px).
 */
export function stripScrollTo(left: number, width: number, scrollLeft: number, clientWidth: number, margin = 16): number | null {
	if (left < scrollLeft) return Math.max(0, left - margin);
	if (left + width > scrollLeft + clientWidth) return left + width - clientWidth + margin;
	return null;
}
