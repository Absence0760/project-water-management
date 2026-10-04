import { describe, expect, it } from 'vitest';
import { sizingText } from './demandObjects';

describe('§ 6 a demand object’s sizing in words (evidence-9)', () => {
	const monthly = (monthlyM3Day: number[] | null) => ({ sizing: 'monthly' as const, monthlyM3Day, count: null, litresPerUnitDay: null, lossPct: 0 });

	it('a flat monthly demand once, a varying one as its range and mean', () => {
		expect(sizingText(monthly(new Array(12).fill(20)))).toBe('20 m³/day every month');
		expect(sizingText(monthly([10, 10, 10, 10, 10, 10, 50, 50, 50, 50, 50, 50]))).toBe('10–50 m³/day by month (mean 30)');
		expect(sizingText(monthly(null))).toBe('no monthly demand entered');
		// In the unit it was entered in (engine 1.72.0): 86.4 m³/day is 1 l/s, 864 m³/day 0.01 m³/s.
		expect(sizingText({ ...monthly(new Array(12).fill(86.4)), monthlyUnit: 'ls' })).toBe('1 l/s every month');
		expect(sizingText({ ...monthly([864, 864, 864, 864, 864, 864, 1728, 1728, 1728, 1728, 1728, 1728]), monthlyUnit: 'm3s' })).toBe('0.01–0.02 m³/s by month (mean 0.015)');
	});

	it('per unit: the count, the litres and the losses when there are any', () => {
		expect(sizingText({ sizing: 'perUnit', monthlyM3Day: null, count: 400, litresPerUnitDay: 230, lossPct: 0 })).toBe('400 × 230 l a day');
		expect(sizingText({ sizing: 'perUnit', monthlyM3Day: null, count: 400, litresPerUnitDay: 230, lossPct: 0.1 })).toBe('400 × 230 l a day, 10 % losses');
	});
});
