import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import { classOf, DRY_PERCENTILE, FEW_CALIBRATION_YEARS, LONG_TERM_MIN_YEARS, midRankPercentile, recordRepresentativeness, WET_PERCENTILE, waterYearRainTotals } from './representativeness';

// Rule 7: date-sensitive, so under a skewed TZ (UTC+14 would move 1 October into September on a local-time slip).
let tz: string | undefined;
beforeAll(() => {
	tz = process.env.TZ;
	process.env.TZ = 'Pacific/Kiritimati';
});
afterAll(() => {
	process.env.TZ = tz;
});

const START = '1990-10-01';
const d0 = toEpochDay(START);
/** Daily rain for `years` water years from 1990/91, each year's daily value from `perYear` (mm/day). */
function rainOf(years: number, perYear: (i: number) => number): (number | null)[] {
	const out: (number | null)[] = [];
	for (let i = 0; i < years; i++) {
		const n = toEpochDay(`${1991 + i}-10-01`) - toEpochDay(`${1990 + i}-10-01`);
		for (let t = 0; t < n; t++) out.push(perYear(i));
	}
	return out;
}
/** Every day index of the given water years (by start year). */
function daysOf(years: number[], length: number): number[] {
	const out: number[] = [];
	for (let t = 0; t < length; t++) {
		const date = new Date((d0 + t) * 86_400_000);
		const wy = date.getUTCMonth() >= 9 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
		if (years.includes(wy)) out.push(t);
	}
	return out;
}

describe('midRankPercentile and classOf', () => {
	it('ranks by mid-rank non-exceedance', () => {
		const sorted = [1, 2, 3, 4];
		expect(midRankPercentile(sorted, 1)).toBe(12.5);
		expect(midRankPercentile(sorted, 4)).toBe(87.5);
		expect(midRankPercentile([5, 5], 5)).toBe(50);
		expect(midRankPercentile(sorted, 0)).toBe(0);
	});
	it('calls below the 33rd dry, above the 67th wet, the rest normal', () => {
		expect(DRY_PERCENTILE).toBe(33);
		expect(WET_PERCENTILE).toBe(67);
		expect(classOf(32.9)).toBe('dry');
		expect(classOf(33)).toBe('normal');
		expect(classOf(67)).toBe('normal');
		expect(classOf(67.1)).toBe('wet');
	});
});

describe('waterYearRainTotals', () => {
	it('totals whole water years only, with at least 95 % of days valued', () => {
		const rain = rainOf(3, (i) => i + 1);
		// Year 2 (1992/93): 10 % of days missing → left out; year 1 (1991/92): 3 % → kept, total of the valued days.
		for (let t = 0; t < 10; t++) rain[365 + t] = null; // 1991/92 (366 days, Feb 1992) starts on day 365
		const y3 = 365 + 366;
		for (let t = 0; t < 37; t++) rain[y3 + t] = null;
		const totals = waterYearRainTotals(rain, START);
		expect(totals.get(1990)).toBe(365);
		expect(totals.get(1991)).toBeCloseTo((366 - 10) * 2);
		expect(totals.has(1992)).toBe(false);
		// A record starting mid-year leaves that part year out.
		const late = waterYearRainTotals(rain.slice(100), '1991-01-09');
		expect(late.has(1990)).toBe(false);
		expect(late.get(1991)).toBeCloseTo((366 - 10) * 2);
	});
});

describe('recordRepresentativeness', () => {
	const years = 20;
	// Year i rains i + 1 mm a day: 1990/91 is the driest, 2009/10 the wettest.
	const rain = rainOf(years, (i) => i + 1);

	it('places a three-year dry record in the long-term distribution and says it can’t test wet years', () => {
		const r = recordRepresentativeness(rain, START, daysOf([1990, 1991, 1992], rain.length));
		expect(r.waterYears).toBe(3);
		expect(r.scoredDays).toBe(365 + 366 + 365);
		expect(r.longTerm).toMatchObject({ years: 20, firstYear: 1990, lastYear: 2009 });
		expect(r.years.map((y) => [y.waterYear, y.percentile, y.class])).toEqual([
			[1990, 2.5, 'dry'],
			[1991, 7.5, 'dry'],
			[1992, 12.5, 'dry']
		]);
		expect(r.meanRatio!).toBeLessThan(0.3);
		expect(r.summary).toMatch(/^The calibration record has 1096 scored days over 3 water years \(WY 1990\/91–1992\/93\)\. Their mean rain, \d+ mm a year, is \d+ % of the long-term mean/);
		expect(r.notes.join(' ')).toMatch(/covers 3 water years with complete rain, all dry \(below the 33rd percentile of the 20-year rain record\): it can't show how the model behaves in wet years/);
		expect(r.notes.join(' ')).toMatch(new RegExp(`only 3 water years, fewer than ${FEW_CALIBRATION_YEARS}: too few to pin down`));
	});

	it('says when every year is wet, or none is', () => {
		const wet = recordRepresentativeness(rain, START, daysOf([2008, 2009], rain.length));
		expect(wet.years.every((y) => y.class === 'wet')).toBe(true);
		expect(wet.notes[0]).toMatch(/all wet .*droughts/);
		const noWet = recordRepresentativeness(rain, START, daysOf([1990, 1995, 1998, 1999, 2001, 2002], rain.length));
		expect(noWet.years.some((y) => y.class === 'wet')).toBe(false);
		expect(noWet.notes[0]).toMatch(/None of the calibration record's 6 water years with complete rain is wet/);
		expect(noWet.notes).toHaveLength(1); // six years: no "too few" note
		const noDry = recordRepresentativeness(rain, START, daysOf([2000, 2003, 2005, 2007, 2009], rain.length));
		expect(noDry.notes[0]).toMatch(/is dry .*drought behaviour/);
		const normal = recordRepresentativeness(rain, START, daysOf([2000], rain.length));
		expect(normal.notes[0]).toMatch(/a near-normal one .*neither droughts nor wet years/);
	});

	it('has no limit to report for a long record that spans dry and wet years (positive control)', () => {
		const all = Array.from({ length: years }, (_, i) => 1990 + i);
		const r = recordRepresentativeness(rain, START, daysOf(all, rain.length));
		expect(r.notes).toEqual([]);
		expect(r.meanRatio).toBeCloseTo(1);
		expect(new Set(r.years.map((y) => y.class))).toEqual(new Set(['dry', 'normal', 'wet']));
	});

	it('does not rank against a short rain record, and says why', () => {
		const short = rain.slice(0, 365 * 6 + 1);
		const r = recordRepresentativeness(short, START, daysOf([1990, 1991], short.length));
		expect(r.longTerm!.years).toBeLessThan(LONG_TERM_MIN_YEARS);
		expect(r.years.every((y) => y.class === null && y.percentile !== null)).toBe(true);
		expect(r.notes[0]).toMatch(/only \d complete water years, too short a long-term reference \(at least 10\)/);
	});

	it('leaves a scored year without complete rain unranked and out of the mean', () => {
		const gappy = [...rain];
		for (let t = 0; t < 60; t++) gappy[t] = null; // 1990/91 under 95 % valued
		const r = recordRepresentativeness(gappy, START, daysOf([1990, 2009], gappy.length));
		expect(r.years[0]).toMatchObject({ waterYear: 1990, rainMm: null, percentile: null, class: null });
		expect(r.calibrationMeanMm).toBeCloseTo(20 * 365);
		expect(r.longTerm!.years).toBe(19);
	});
});
