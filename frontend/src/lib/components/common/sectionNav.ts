// The "On this page" menu shared by the long workspace pages (SectionNav.svelte):
// Settings & calibration, Runs & results, River & reserve, Hydrological units, Data
// and Compare runs, and the Network node sheet's form (in a box of its own, `onjump`).

export interface NavSection {
	id: string;
	/** Its name: the panel's heading, as the page shows it (issue #462), in the rail, the More menu and the find box. */
	label: string;
	/**
	 * A shorter name for the bar, where every link has to fit two rows (issue
	 * #462): the heading's first words ("Calibration" for "Calibration against
	 * observed flow"). The rail, with a line of its own for each link, shows `label`.
	 */
	bar?: string;
	/** Marks the link with a dot and "(has a problem)" for screen readers. */
	problem?: boolean;
	/**
	 * A link to another page instead of a panel on this one (`?tab=series`): it is
	 * listed like the rest but never marked as the section being read.
	 */
	href?: string;
	/**
	 * The page an `href` link goes to ("River & reserve"): screen readers hear
	 * ", on River & reserve" after its name (`pageLinkName`), as its group's heading says it to the eye.
	 */
	page?: string;
	/**
	 * The ids of the panels after it that this one link stands for (Settings'
	 * "Automation & access" on the bar): the link is marked while any of them is
	 * read, and the find box searches them as part of it.
	 */
	covers?: string[];
}

export interface NavGroup {
	/** The group's name before its links; null for a group that needs none. */
	label: string | null;
	sections: NavSection[];
}

/**
 * A link to another page's name for screen readers, "<what it says>, on <page>" (issue #462), carried as its
 * aria-label; null for a link on this page, which its text names. Not a hidden span after the text: the
 * hidden class positions it, and Chromium then spaces it off ("by month , on River & reserve").
 */
export function pageLinkName(sec: Pick<NavSection, 'label' | 'bar' | 'page' | 'problem'>, where: 'bar' | 'rail'): string | null {
	if (!sec.page) return null;
	return `${navText(sec, where)}, on ${sec.page}${sec.problem ? ' (has a problem)' : ''}`;
}

/** What a link says: its short name on the bar, its whole name in the rail and the More menu (issue #462). */
export function navText(sec: Pick<NavSection, 'label' | 'bar'>, where: 'bar' | 'rail'): string {
	return where === 'bar' ? (sec.bar ?? sec.label) : sec.label;
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
