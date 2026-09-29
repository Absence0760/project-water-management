import { describe, expect, it } from 'vitest';
import { activeSectionId, navFitCount } from './sectionNav';

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
		// Row 1 holds three links, row 2 four; the More box (60 + 10) needs one link's room on row 2.
		expect(navFitCount(nine, fit)).toBe(6);
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
