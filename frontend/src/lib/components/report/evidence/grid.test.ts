// The Reserve heat maps' cells (issue #71, design §4.2; persona E: depth of
// failure, the failed month the heavier mark, changes outlined).
import type { EvidenceChange, EvidenceSite, EvidenceSiteMonth } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { depthOf, fdcCaption, fdcChangeRows, fdcMonths, reserveGrid, waterYearLabel } from './grid';

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

describe('the FDC check’s paired change (evidence-7)', () => {
	const band = (p5: number | null, p50: number | null, p95: number | null, n = 40) => ({ n, p5, p50, p95, min: p5, max: p95 });
	const cell = (over: Partial<EvidenceChange>): EvidenceChange => ({ run: -0.012, band: band(-0.02, -0.01, -0.004), bandNote: null, worse: { k: 38, n: 40 }, ...over });
	const bands: EvidenceSite['fdcBands'] = [{ month: 5, a: [], b: [] }];
	const f = { month: 5, why: 'the month met least often.' };

	it('prints one row per table point: the paired median, its range and the run’s own difference, and the sets lower', () => {
		const rows = fdcChangeRows({ fdcChange: [{ month: 5, points: [cell({}), cell({ run: 0, band: band(0, 0, 0), worse: { k: 0, n: 40 } })] }] }, 5, [10, 90]);
		expect(rows).toEqual([
			{ point: 10, main: '−0.0100', sub: '−0.0200 to −0.0040 · run: −0.0120', worse: '38 of 40 sets (95 %)' },
			{ point: 90, main: '0.0000', sub: '0.0000 to 0.0000 · run: 0.0000', worse: '0 of 40 sets (0 %)' }
		]);
		// Digits follow the month's largest change.
		expect(fdcChangeRows({ fdcChange: [{ month: 5, points: [cell({ run: -1.234, band: band(-2.5, -1.2, -0.3) })] }] }, 5, [50])[0]!.main).toBe('−1.20');
	});

	it('says "no band" with the reason and prints only the run’s own difference; nothing for a month without cells', () => {
		const [row] = fdcChangeRows({ fdcChange: [{ month: 5, points: [cell({ band: band(null, null, null, 12), bandNote: 'no band: not enough accepted parameter sets (12 of 41)', worse: null })] }] }, 5, [10]);
		expect(row).toEqual({ point: 10, main: 'run: −0.0120', sub: 'no band: not enough accepted parameter sets (12 of 41)', worse: '—' });
		expect(fdcChangeRows({ fdcChange: [{ month: 5, points: [cell({})] }] }, 6, [10])).toEqual([]);
		expect(fdcChangeRows({ fdcChange: null }, 5, [10])).toEqual([]);
		expect(fdcChangeRows({}, 5, [10])).toEqual([]);
	});

	it('captions the chart: the table carries the change, and only a pack before evidence-7 keeps the overlap warning', () => {
		const tabled = fdcCaption({ fdcBands: bands, fdcBandNote: null, fdcChange: [{ month: 5, points: [cell({})] }] }, f, true);
		expect(tabled).toMatch(/^May: the month met least often\. The simulated curve should lie on or above the EWR curve\. Shaded: how far the kept parameter sets spread each run’s own curve/);
		expect(tabled).toContain('The table below pairs them');
		expect(tabled).not.toMatch(/overlap/i);
		// No table (the paired band is gated): the note says why, still no overlap apology.
		const gated = fdcCaption({ fdcBands: bands, fdcBandNote: 'The application’s curve: no band: not enough accepted parameter sets (12 of 41).', fdcChange: null }, f, true);
		expect(gated).not.toContain('The table below');
		expect(gated).toMatch(/12 of 41\)\.$/);
		expect(gated).not.toMatch(/overlap/i);
		// A pack issued before evidence-7: its frozen document has no change, so the warning stays.
		expect(fdcCaption({ fdcBands: bands, fdcBandNote: null }, f, true)).toContain('Overlapping ranges don’t mean no change');
		expect(fdcCaption({ fdcBands: bands, fdcBandNote: null, fdcChange: null }, f, false)).toMatch(/Shaded: the range of the kept parameter sets \(R1\)\.$/);
		expect(fdcCaption({ fdcBands: null, fdcBandNote: 'no band: no ensemble on the declared rule', fdcChange: null }, f, true)).toMatch(/Curve band: no band: no ensemble on the declared rule\.$/);
	});
});
