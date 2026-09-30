// The Reserve heat maps' cells (issue #71, design §4.2; persona E: depth of
// failure, the failed month the heavier mark, changes outlined).
import type { EvidenceSiteMonth } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { depthOf, fdcMonths, reserveGrid, waterYearLabel } from './grid';

const m = (year: number, month: number, over: Partial<EvidenceSiteMonth> = {}): EvidenceSiteMonth => ({
	year,
	month,
	waterYear: month >= 10 ? year : year - 1,
	deliveredA: 1.2,
	deliveredB: 1.1,
	metA: true,
	metB: true,
	...over
});

describe('reserveGrid', () => {
	const site = {
		months: [
			m(2000, 10),
			m(2000, 11, { metB: false, deliveredB: 0.4 }),
			m(2001, 5, { metA: false, deliveredA: 0.1, metB: true, deliveredB: 1 }),
			m(2001, 10, { metA: false, deliveredA: 0.8, metB: false, deliveredB: 0.6 })
		]
	};

	it('lays months out by water year, October first', () => {
		const g = reserveGrid(site, 'a');
		expect(g.waterYears).toEqual([2000, 2001]);
		expect(g.cells[0]![0]!.met).toBe(true); // Oct 2000
		expect(g.cells[0]![7]!.met).toBe(false); // May 2001, water year 2000
		expect(g.cells[1]![0]!.depth).toBe(1); // Oct 2001: 80 % delivered
		expect(g.cells[0]![2]).toBeNull(); // no complete December
	});

	it('marks the months the application loses or gains, on both grids', () => {
		const a = reserveGrid(site, 'a');
		const b = reserveGrid(site, 'b');
		expect(a.cells[0]![1]!.change).toBe('lost');
		expect(b.cells[0]![1]!.change).toBe('lost');
		expect(b.cells[0]![1]!.depth).toBe(3);
		expect(b.cells[0]![7]!.change).toBe('gained');
		expect(b.cells[1]![0]!.change).toBeNull();
		expect(b.cells[0]![1]!.text).toBe('Nov 2000: not met, 40 % of the requirement delivered; lost by the application');
	});

	it('has no application grid cells for baseline evidence', () => {
		const baseOnly = { months: site.months.map((x) => ({ ...x, metB: null, deliveredB: null })) };
		expect(reserveGrid(baseOnly, 'b').cells.flat().every((c) => c === null)).toBe(true);
		expect(reserveGrid(baseOnly, 'a').cells[0]![1]!.change).toBeNull();
	});

	it('shades by depth, the met month lightest', () => {
		expect([depthOf(true, 0.1), depthOf(false, 0.9), depthOf(false, 0.6), depthOf(false, 0.3), depthOf(false, 0.1), depthOf(false, null)]).toEqual([0, 1, 2, 3, 4, 4]);
		expect(waterYearLabel(1999)).toBe('1999/00');
	});
});

describe('fdcMonths: the FDC checks § 1 plots', () => {
	it('plots the driest month beside the largest-change month when they differ, the ranked one first', () => {
		const got = fdcMonths({ fdcMonth: 5, fdcDriestMonth: 8 }, true);
		expect(got.map((f) => [f.month, f.kind])).toEqual([
			[5, 'change'],
			[8, 'driest']
		]);
		expect(got[0]!.why).toMatch(/^the month the application loses most months met in/);
		expect(got[1]!.why).toMatch(/lowest mean natural flow/);
	});

	it('plots one month once when they are the same, saying it is both', () => {
		const got = fdcMonths({ fdcMonth: 8, fdcDriestMonth: 8 }, false);
		expect(got).toHaveLength(1);
		expect(got[0]).toMatchObject({ month: 8, kind: 'both' });
		expect(got[0]!.why).toMatch(/^the month met least often, and the river’s driest month/);
	});

	it('plots whichever it has, and nothing without either', () => {
		expect(fdcMonths({ fdcMonth: null, fdcDriestMonth: 7 }, true).map((f) => f.kind)).toEqual(['driest']);
		expect(fdcMonths({ fdcMonth: null, fdcDriestMonth: null }, true)).toEqual([]);
	});
});
