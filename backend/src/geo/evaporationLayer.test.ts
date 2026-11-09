// The A-pan grid layer's pure parts (geo/evaporationLayer.ts): a
// calendar month's place in a cell's Oct … Sep values, and a cell's value for a
// month or the year.
import { describe, expect, it } from 'vitest';
import { cellValue, waterYearIndex } from './evaporationLayer.js';

/** Oct … Sep: each value its calendar month × 10, so a read names its month. */
const ROW = [100, 110, 120, 10, 20, 30, 40, 50, 60, 70, 80, 90];

describe('waterYearIndex', () => {
	it('puts October first and September last', () => {
		expect([10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(waterYearIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
	});
});

describe('cellValue', () => {
	it('reads each calendar month from the water-year row', () => {
		for (let m = 1; m <= 12; m++) expect(cellValue(ROW, m)).toBe(m * 10);
	});

	it('sums the 12 months for the year without a month, to whole mm', () => {
		expect(cellValue(ROW, null)).toBe(780);
		expect(cellValue([10.4, 10.4, 10.4, 10.4, 10.4, 10.4, 10.4, 10.4, 10.4, 10.4, 10.4, 10.4], null)).toBe(125);
		expect(cellValue([...ROW.slice(0, 3), 10.6, ...ROW.slice(4)], 1)).toBe(11);
	});
});
