import { describe, expect, it } from 'vitest';
import { activeSectionId, findElsewhere, findEntries, foldText, matchesQuery, navEmpty, navFitCount, navText, pageLinkName, stripScrollTo } from './sectionNav';

describe('navFitCount', () => {
	const fit = { avail: 400, lead: 100, gap: 5, groupGap: 15, more: 60, rows: 2 };
	const links = (...w: number[]) => w.map((width) => ({ width, groupStart: false }));
	const nine = links(90, 90, 90, 90, 90, 90, 90, 90, 90);

	it('keeps every link when they fit in two rows', () => {
		// Row 1: 100 + 3 × 95 = 385; row 2: 3 × 95.
		expect(navFitCount(links(90, 90, 90, 90, 90, 90), fit)).toBe(6);
	});

	it('packs a group across rows rather than moving it whole onto a row of its own', () => {
		// A one-link group, then a long one (Runs & results' Summary, then Model quality).
		const items = [{ width: 60, groupStart: false }, ...links(90, 90, 90, 90, 90).map((l, i) => ({ ...l, groupStart: i === 0 }))];
		expect(navFitCount(items, fit)).toBe(6);
	});

	it('moves the last links into More, keeping the More button on the second row', () => {
		// Row 1 holds three links, row 2 four; the More box (60 + 5 + 10) needs one link's room on row 2.
		expect(navFitCount(nine, fit)).toBe(6);
	});

	it('counts the gap after the More button, as after every link', () => {
		// Row 2: 95 + 95 + 138 = 328, then More: 60 + 10 (its group gap) = 398 fits the 400,
		// but More has its own 5 px margin after it too, which the line holds: 403 doesn't.
		expect(navFitCount(links(90, 90, 90, 90, 90, 133, 90), fit)).toBe(5);
	});

	it('counts the wider gap before a group', () => {
		const tight = { ...fit, avail: 385 };
		expect(navFitCount(links(90, 90, 90, 90, 90, 90, 90), tight)).toBe(7);
		// The group's extra 10 px pushes row 2 to 390: the last link and More swap places.
		const grouped = links(90, 90, 90, 90, 90, 90, 90).map((l, i) => ({ ...l, groupStart: i === 4 }));
		expect(navFitCount(grouped, tight)).toBe(6);
	});

	it('allows more rows when asked, and gives up to an empty bar when nothing fits', () => {
		expect(navFitCount(nine, { ...fit, rows: 3 })).toBe(9);
		expect(navFitCount(links(500, 500, 500), { ...fit, avail: 50, rows: 1 })).toBe(0);
	});
});

describe('activeSectionId', () => {
	const tops = (...t: number[]) => t.map((top, i) => ({ id: `s${i}`, top }));

	it('marks the last section whose top has reached the line under the header', () => {
		expect(activeSectionId(tops(-900, -200, 60, 700), 68)).toBe('s2');
		expect(activeSectionId(tops(-900, -200, 69, 700), 68)).toBe('s1');
	});

	it('marks the first section before any has reached the line', () => {
		expect(activeSectionId(tops(300, 900), 68)).toBe('s0');
	});

	it('marks the last section at the bottom of the page, even if it never reached the line', () => {
		expect(activeSectionId(tops(-900, -200, 400), 68, true)).toBe('s2');
	});

	it('marks the first section on a page so short that, at the bottom, the first still starts on the screen', () => {
		expect(activeSectionId(tops(140, 420), 68, true)).toBe('s0');
		expect(activeSectionId(tops(0, 420), 68, true)).toBe('s0');
		// A followed link still wins.
		expect(activeSectionId(tops(140, 420), 68, true, 's1', 960)).toBe('s1');
	});

	it('at the bottom, keeps the section a followed link named while it still starts on the screen', () => {
		// #s1 was followed; the page ended before its top reached the line (s2 below it is short).
		expect(activeSectionId(tops(-900, 108, 400), 68, true, 's1', 960)).toBe('s1');
		// Scrolled past it (its top above the window), below the window, or a fragment that isn't a section: the last, as before.
		expect(activeSectionId(tops(-900, -40, 400), 68, true, 's1', 960)).toBe('s2');
		expect(activeSectionId(tops(-900, 980, 1400), 68, true, 's1', 960)).toBe('s2');
		expect(activeSectionId(tops(-900, 108, 400), 68, true, 'elsewhere', 960)).toBe('s2');
		// Not at the bottom, the fragment changes nothing.
		expect(activeSectionId(tops(-900, 60, 400), 68, false, 's2', 960)).toBe('s1');
	});

	it('has nothing to mark before any section is on the page', () => {
		expect(activeSectionId([], 68)).toBeNull();
	});
});

describe('the find box', () => {
	it('matches every word of the query anywhere in the name, ignoring case and accents', () => {
		expect(matchesQuery('Pan coefficient', 'pan coef')).toBe(true);
		expect(matchesQuery('Pan coefficient', 'COEF pan')).toBe(true);
		expect(matchesQuery('Droëvlei dam', 'droevlei')).toBe(true);
		expect(matchesQuery('Pan coefficient', 'pan rain')).toBe(false);
		expect(matchesQuery('Pan coefficient', '   ')).toBe(false);
		expect(foldText('  Days in\n  February ')).toBe('days in february');
	});

	it('lists matching sections and the settings in them, in page order, once per name, up to the limit', () => {
		const sections = [
			{ id: 'a', label: 'Demand' },
			{ id: 'b', label: 'Flow calibration' }
		];
		const settings = [
			{ sectionId: 'b', text: 'Warm-up (days)' },
			{ sectionId: 'a', text: 'A-pan evaporation mm' },
			{ sectionId: 'a', text: 'Dam evaporation factor (× A-pan)' },
			{ sectionId: 'a', text: 'Dam evaporation factor (× A-pan)' },
			{ sectionId: 'b', text: 'GR4J potential evaporation' },
			{ sectionId: 'b', text: 'Flow calibration' }
		];
		expect(findEntries(sections, settings, 'evaporation')).toEqual([
			{ sectionId: 'a', text: 'A-pan evaporation mm', index: 1 },
			{ sectionId: 'a', text: 'Dam evaporation factor (× A-pan)', index: 2 },
			{ sectionId: 'b', text: 'GR4J potential evaporation', index: 4 }
		]);
		// A section's own name, not again as a setting (its heading is in the scan too).
		expect(findEntries(sections, settings, 'flow')).toEqual([{ sectionId: 'b', text: 'Flow calibration', index: -1 }]);
		expect(findEntries(sections, settings, 'evaporation', 2)).toHaveLength(2);
		expect(findEntries(sections, settings, ' ')).toEqual([]);
	});
});

describe('findElsewhere (issue #521)', () => {
	const moved = [
		{ text: 'Comparison band', words: 'registered volumes tolerance', href: '?tab=allocations#alloc-band', page: 'Allocations' },
		{ text: 'Other thing', href: '?tab=x', page: 'X' }
	];
	it('matches a moved setting by its name or its other names, every word', () => {
		expect(findElsewhere(moved, 'comparison band').map((e) => e.page)).toEqual(['Allocations']);
		expect(findElsewhere(moved, 'Registered volumes').map((e) => e.page)).toEqual(['Allocations']);
		expect(findElsewhere(moved, 'toler')).toHaveLength(1);
		expect(findElsewhere(moved, 'band other')).toEqual([]);
		expect(findElsewhere(moved, 'thing').map((e) => e.page)).toEqual(['X']);
	});
	it('lists nothing for an empty query', () => {
		expect(findElsewhere(moved, '   ')).toEqual([]);
	});
});

describe('navText and navEmpty (issue #462)', () => {
	it('says the panel’s heading in the rail, and the shorter bar name on the bar when there is one', () => {
		const sec = { label: 'Calibration against observed flow', bar: 'Calibration' };
		expect(navText(sec, 'rail')).toBe('Calibration against observed flow');
		expect(navText(sec, 'bar')).toBe('Calibration');
		expect(navText({ label: 'Publication' }, 'bar')).toBe('Publication');
	});

	it('names a link to another page with that page, the problem after it; a link on this page has no name of its own', () => {
		const sec = { label: 'Reserve rules met, by month', bar: 'Reserve rules', page: 'EWR' };
		expect(pageLinkName(sec, 'rail')).toBe('Reserve rules met, by month, on EWR');
		expect(pageLinkName(sec, 'bar')).toBe('Reserve rules, on EWR');
		expect(pageLinkName({ ...sec, problem: true }, 'rail')).toBe('Reserve rules met, by month, on EWR (has a problem)');
		expect(pageLinkName({ label: 'Summary' }, 'rail')).toBeNull();
	});

	it('is empty only when no group lists a section', () => {
		expect(navEmpty([])).toBe(true);
		expect(navEmpty([{ label: 'A', sections: [] }])).toBe(true);
		expect(navEmpty([{ label: 'A', sections: [] }, { label: null, sections: [{ id: 'x', label: 'X' }] }])).toBe(false);
	});
});

describe('stripScrollTo (the phone strip shows a focused link whole, issue #586)', () => {
	// A 273 px strip scrolled to 0, as the Data page's at 320 px.
	it('leaves a link that shows whole where it is', () => {
		expect(stripScrollTo(100, 80, 0, 273)).toBeNull();
		expect(stripScrollTo(0, 273, 0, 273)).toBeNull();
	});

	it('scrolls a link cut at the right edge in whole, with a margin beyond it', () => {
		// "What the model uses": 144 px wide, starting 265 px in, 8 px of it showing.
		expect(stripScrollTo(265, 144, 0, 273)).toBe(265 + 144 - 273 + 16);
	});

	it('scrolls back to a link cut at the left edge (Shift+Tab), never before the start', () => {
		expect(stripScrollTo(200, 80, 240, 273)).toBe(184);
		expect(stripScrollTo(4, 80, 30, 273)).toBe(0);
	});
});
