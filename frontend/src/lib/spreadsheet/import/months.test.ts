import { describe, expect, it } from 'vitest';
import { monthList, substringExtraMonths, summerExtraMonths, summerMonths } from './months';

// Ported from scripts/wbt-import/test_months.py (docs/engine-audit.md M1).
describe('month lists', () => {
	it('keeps the listed months only', () => {
		// The workbook's FIND("1,", "11,12,") also matches January and February.
		expect(monthList('11,12')).toEqual([11, 12]);
		expect(summerMonths('11,12')).toEqual([11, 12]);
		expect(substringExtraMonths('11,12')).toEqual([1, 2]);
		expect(summerExtraMonths('11,12')).toEqual([1, 2]);
	});

	it('leaves lists that already name January and February unchanged', () => {
		for (const text of ['1,2,3,4,5,11,12', '10,11,12,1,2,3', '5,6,7,8,9,10']) {
			expect(substringExtraMonths(text), text).toEqual([]);
			expect(summerExtraMonths(text), text).toEqual([]);
		}
	});

	it('reads cells holding a number or spaces', () => {
		expect(monthList(7)).toEqual([7]);
		expect(summerMonths(12)).toEqual([12]);
		expect(monthList(' 1, 2 , 12')).toEqual([1, 2, 12]);
		expect(monthList(null)).toEqual([]);
		expect(monthList('0,13,6')).toEqual([6]);
	});

	// Beyond the Python tests: the edges where the two Python copies differ, and a trailing comma.
	it('removes spaces before reading summer months, but not transfer months', () => {
		expect(monthList('1 2')).toEqual([1, 2]);
		expect(summerMonths('1 2')).toEqual([12]);
		expect(substringExtraMonths(' 1 1,')).toEqual([11]);
	});

	it('handles a trailing comma and blanks', () => {
		expect(summerMonths('10,11,12,3,')).toEqual([3, 10, 11, 12]);
		expect(summerExtraMonths('10,11,12,3,')).toEqual([1, 2]);
		expect(summerMonths(null)).toEqual([]);
		expect(summerExtraMonths(null)).toEqual([]);
		expect(substringExtraMonths(null)).toEqual([]);
	});

	it('reads a fractional number as its digits, as Python str() writes them', () => {
		expect(monthList(7.5)).toEqual([5, 7]);
		expect(monthList(1112)).toEqual([]);
	});
});
