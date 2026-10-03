import { describe, expect, it } from 'vitest';
import { fillFromFirst, fillMessage, monthsOf, withMonth } from './monthFields';

describe('monthsOf', () => {
	it('is twelve copies of the value', () => {
		expect(monthsOf(7)).toEqual(new Array(12).fill(7));
	});
});

describe('withMonth', () => {
	const row = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

	it('sets one month and leaves the others and the original row alone', () => {
		const next = withMonth(row, 3, 40);
		expect(next).toEqual([1, 2, 3, 40, 5, 6, 7, 8, 9, 10, 11, 12]);
		expect(row[3]).toBe(4);
	});

	it('writes the blank value for a cleared field: 0, or 1 for a profile', () => {
		expect(withMonth(row, 0, null)[0]).toBe(0);
		expect(withMonth(row, 0, null, 1)[0]).toBe(1);
	});

	it('starts a missing or short row as the blank value in every month, always 12 long', () => {
		expect(withMonth(null, 11, 5)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5]);
		expect(withMonth(undefined, 0, 2, 1)).toEqual([2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
		expect(withMonth([9, 9], 5, 3)).toEqual([9, 9, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0]);
	});
});

describe('fillFromFirst', () => {
	it('copies October’s value into every month', () => {
		expect(fillFromFirst([12_345.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toEqual(new Array(12).fill(12_345.5));
	});

	it('uses the blank value when there is no row', () => {
		expect(fillFromFirst(null)).toEqual(new Array(12).fill(0));
		expect(fillFromFirst(undefined, 1)).toEqual(new Array(12).fill(1));
	});
});

describe('fillMessage', () => {
	it("says which value went into every month, as the fields show it", () => {
		expect(fillMessage([150, 0], 0, 1, 'Demand, m³/day, per month')).toBe('Copied October’s 150 to every month of Demand, m³/day, per month.');
		expect(fillMessage(null, 1, 1, 'Monthly profile')).toBe('Copied October’s 1 to every month of Monthly profile.');
		expect(fillMessage([17_280], 0, 1 / 86_400, 'River to dam, m³/s')).toBe('Copied October’s 0.2 to every month of River to dam, m³/s.');
	});
});
