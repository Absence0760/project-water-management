import { describe, expect, it } from 'vitest';
import { agreementFold } from './agreementFold';

const years = (n: number, flagged: number[] = []) => Array.from({ length: n }, (_, i) => ({ y: 2000 + i, flagged: flagged.includes(i) }));

describe('agreementFold', () => {
	it('shows the flagged years and the latest five, in order, the rest folded', () => {
		const f = agreementFold(years(30, [2, 10]), false);
		expect(f.shown.map((x) => x.y)).toEqual([2002, 2010, 2025, 2026, 2027, 2028, 2029]);
		expect(f.hidden).toBe(23);
	});

	it('shows everything when open', () => {
		expect(agreementFold(years(30, [2]), true)).toEqual({ shown: years(30, [2]), hidden: 0 });
	});

	it('shows a short record whole, and one that would hide a single year', () => {
		expect(agreementFold(years(5), false).hidden).toBe(0);
		expect(agreementFold(years(6), false)).toEqual({ shown: years(6), hidden: 0 });
		expect(agreementFold(years(7), false).hidden).toBe(2);
	});

	it('a flagged latest year is counted once', () => {
		const f = agreementFold(years(12, [11]), false);
		expect(f.shown.map((x) => x.y)).toEqual([2007, 2008, 2009, 2010, 2011]);
		expect(f.hidden).toBe(7);
	});
});
