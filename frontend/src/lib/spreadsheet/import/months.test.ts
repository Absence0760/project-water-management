import { describe, expect, it } from 'vitest';
import { monthList, substringExtraMonths } from './months';

// Ported from scripts/wbt-import/test_months.py (docs/engine-audit.md M1).
describe('month lists', () => {
	it('keeps the listed months only', () => {
		// The workbook's FIND("1,", "11,12,") also matches January and February.
		expect(monthList('11,12')).toEqual([11, 12]);
		expect(substringExtraMonths('11,12')).toEqual([1, 2]);
	});

	it('leaves lists that already name January and February unchanged', () => {
		for (const text of ['1,2,3,4,10,11,12', '10,11,12,1,2,3', '4,5,6,7,8,9']) {
			expect(substringExtraMonths(text), text).toEqual([]);
		}
	});

	it('reads cells holding a number or spaces', () => {
		expect(monthList(7)).toEqual([7]);
		expect(monthList(' 1, 2 , 12')).toEqual([1, 2, 12]);
		expect(monthList(null)).toEqual([]);
		expect(monthList('0,13,6')).toEqual([6]);
	});

	// Beyond the Python tests: spaces inside a list, and a trailing comma.
	it('reads transfer months with the spaces as written', () => {
		expect(monthList('1 2')).toEqual([1, 2]);
		expect(substringExtraMonths(' 1 1,')).toEqual([11]);
	});

	it('handles a trailing comma and blanks', () => {
		expect(monthList('10,11,12,3,')).toEqual([3, 10, 11, 12]);
		expect(substringExtraMonths('10,11,12,3,')).toEqual([1, 2]);
		expect(substringExtraMonths(null)).toEqual([]);
	});

	it('reads a fractional number as its digits, as Python str() writes them', () => {
		expect(monthList(7.5)).toEqual([5, 7]);
		expect(monthList(1112)).toEqual([]);
	});
});
