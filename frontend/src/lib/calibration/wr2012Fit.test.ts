import { WR2012_GOOD_FIT_BANDS, wr2012FitStatsFromMonthly, type Wr2012FitStats } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { waterYearSpan, wr2012BandsNote, wr2012FitPeriods, wr2012FitRows, wr2012FitSummary } from './wr2012Fit';

const months = (first6: number, last6: number) => [...Array(6).fill(first6), ...Array(6).fill(last6)] as number[];
/** Two years, 12 and 24 Mm³, simulated × `f`. */
const table = (f: number, years = [2001, 2002]): Wr2012FitStats =>
	wr2012FitStatsFromMonthly(years.map((waterYear, i) => ({ waterYear, observed: months(2 * (i + 1), 0), simulated: months(2 * (i + 1) * f, 0) })))!;

describe('wr2012FitRows', () => {
	it('words each statistic with its unit, signed difference, band and verdict', () => {
		const rows = wr2012FitRows(table(1.1));
		expect(rows.map((r) => r.key)).toEqual(['mar', 'meanLog', 'sd', 'logSd', 'seasonalIndex']);
		const mar = rows[0]!;
		expect(mar).toMatchObject({ label: 'MAR', unit: 'Mm³/a', observed: '18.000', simulated: '19.800', diff: '+10.0 %', band: `< ${WR2012_GOOD_FIT_BANDS.pct.mar} %`, verdict: 'outside', verdictText: 'Outside' });
		expect(rows[1]).toMatchObject({ diff: '+3.4 %', verdict: 'within', verdictText: 'Within' });
		expect(rows[3]).toMatchObject({ diff: '0.0 %', verdict: 'within' });
		expect(rows[4]).toMatchObject({ observed: '100.0', band: '< 8 %' });
		expect(wr2012FitRows(table(0.9))[0]!.diff).toBe('−10.0 %');
	});

	it('says "Not computed" in words where a statistic has no value', () => {
		const one = wr2012FitStatsFromMonthly([{ waterYear: 2001, observed: months(1, 0), simulated: months(1, 0) }])!;
		const sd = wr2012FitRows(one).find((r) => r.key === 'sd')!;
		expect(sd).toMatchObject({ observed: '–', diff: '–', verdict: 'none', verdictText: 'Not computed' });
	});

	it('keeps small volumes readable', () => {
		const tiny = wr2012FitStatsFromMonthly([{ waterYear: 2001, observed: Array(12).fill(0.00002), simulated: Array(12).fill(0.00002) }])!;
		expect(wr2012FitRows(tiny)[0]!.observed).toBe('0.00024');
	});
});

describe('wr2012FitSummary and the bands note', () => {
	it('counts the statistics within the bands and names the years', () => {
		expect(wr2012FitSummary(table(1.1))).toBe('3 of 5 within the indicative bands, over 2 complete water years (2001/02 – 2002/03).');
		expect(wr2012FitSummary(table(1, [2001, 2004]))).toContain('(2001/02, 2004/05)');
		const one = wr2012FitStatsFromMonthly([{ waterYear: 2001, observed: months(1, 0), simulated: months(1, 0) }])!;
		expect(wr2012FitSummary(one)).toBe('3 of 3 within the indicative bands, over 1 complete water year (2001/02). The two SDs need at least two complete years.');
		expect(wr2012FitSummary({ ...table(1), bandsConfirmed: true })).toContain('within the good-fit bands');
	});

	it('explains that the bands are unconfirmed, and names the manuals', () => {
		expect(wr2012BandsNote(false)).toMatch(/^Indicative bands \(to be confirmed\)/);
		expect(wr2012BandsNote(false)).toContain('TT 689/16');
		expect(wr2012BandsNote(true)).toMatch(/^Good-fit bands/);
	});

	it('spans consecutive years, lists the rest', () => {
		expect(waterYearSpan([])).toBe('–');
		expect(waterYearSpan([2001])).toBe('2001/02');
		expect(waterYearSpan([1999, 2000, 2001])).toBe('1999/00 – 2001/02');
	});
});

describe('wr2012FitPeriods', () => {
	const period = (stats: Wr2012FitStats | null | undefined) => ({ start: '2001-10-01', end: '2003-09-30', waterYears: [2001, 2002], scores: {} as never, wr2012Fit: stats });

	it('lists the fit, the current parameters and each validation that has the table', () => {
		const t = table(1);
		const periods = wr2012FitPeriods({
			fit: period(t),
			before: period(t),
			splitSample: { params: {}, calibration: period(null), validation: period(t) },
			differential: null,
			independentRecord: null
		});
		expect(periods.map((p) => p.id)).toEqual(['fit', 'before', 'split-val']);
		expect(periods[2]!.label).toBe('Split: other half (validation)');
	});

	it('is empty for a report from before the table existed', () => {
		const old = { start: '2001-10-01', end: '2003-09-30', waterYears: [], scores: {} as never };
		expect(wr2012FitPeriods({ fit: old, before: old, splitSample: null, differential: null, independentRecord: null })).toEqual([]);
	});
});
