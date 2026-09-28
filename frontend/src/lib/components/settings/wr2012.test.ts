import { defaultWr2012Settings } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { blankReference, mm3MonthToM3s, monthlySum, waterYearLabel, wr2012Errors } from './wr2012';

// Synthetic reference: an invented quaternary and round numbers.
const monthly = (mar: number) => [31, 30, 31, 31, 28.25, 31, 30, 31, 30, 31, 31, 30].map((d) => (mar * d) / 365.25);
const reference = {
	quaternary: 'Z99A',
	areaKm2: 100,
	marMm3: 10,
	monthlyMm3: monthly(10),
	periodStart: 1990,
	periodEnd: 2009,
	mapMm: 600,
	source: 'Synthetic table'
};
const settings = (r: unknown, over = {}) => ({ ...defaultWr2012Settings(), reference: r, ...over }) as Parameters<typeof wr2012Errors>[0];

describe('wr2012Errors', () => {
	it('has nothing to say without a reference, or with a consistent one', () => {
		expect(wr2012Errors(defaultWr2012Settings())).toEqual({});
		expect(wr2012Errors(settings(reference))).toEqual({});
	});

	it('asks for every blank field of a new reference', () => {
		const e = wr2012Errors(settings(blankReference()));
		expect(Object.keys(e).sort()).toEqual(['areaKm2', 'marMm3', 'monthlyMm3', 'periodEnd', 'quaternary', 'source']);
		expect(e.areaKm2).toBe('Enter the quaternary area.');
	});

	it('applies the same plausibility checks as the backend: MAR within the rain, monthly sum within 5 % of the MAR', () => {
		expect(wr2012Errors(settings({ ...reference, mapMm: 90 })).marMm3).toMatch(/more than the rain on the quaternary \(90 mm × 100 km² = 9 Mm³\/a\)/);
		expect(wr2012Errors(settings({ ...reference, monthlyMm3: new Array(12).fill(0.317) })).monthlyMm3).toMatch(/add up to 3\.8/);
	});

	it('checks the thresholds and the penalty weight', () => {
		const f = defaultWr2012Settings().flags;
		expect(wr2012Errors(settings(null, { flags: { ...f, notePct: 40 } })).queryPct).toMatch(/must rise/);
		expect(wr2012Errors(settings(null, { calibrationPenalty: { enabled: true, weight: 12 } })).weight).toMatch(/0 to 10/);
		expect(wr2012Errors(settings(null, { lowFlowMonths: [] })).lowFlowMonths).toMatch(/at least one/);
		expect(wr2012Errors(settings(null, { lowFlowMonths: [1] }))).toEqual({});
	});
});

describe('units', () => {
	it('monthlySum adds Mm³ and waits for all 12', () => {
		expect(monthlySum(monthly(10))).toBeCloseTo(10, 12);
		expect(monthlySum([1, null])).toBeNull();
	});

	it('mm3MonthToM3s: 2.6784 Mm³ in October (31 days) is 1 m³/s; February uses 28.25 days', () => {
		expect(mm3MonthToM3s(2.6784, 0)).toBeCloseTo(1, 12);
		expect(mm3MonthToM3s(2.4408, 4)).toBeCloseTo(1, 12);
		expect(mm3MonthToM3s(2.592, 1)).toBeCloseTo(1, 12); // November, 30 days
	});

	it('labels water years by the calendar year they start in', () => {
		expect(waterYearLabel(1999)).toBe('1999/00');
		expect(waterYearLabel(2009)).toBe('2009/10');
	});
});
