import { describe, expect, it } from 'vitest';
import { withMonthlyRates } from '@water-management/engine';
import { dailyCeilingM3, monthCapacity } from './capacity';

const rule = (months: number[], maxRateM3s: number, dailyCapM3: number | null = null, enabled = true) => ({ months, maxRateM3s, dailyCapM3, enabled });

describe('dailyCeilingM3', () => {
	it('is the rate over a day, or the daily cap when that is lower', () => {
		expect(dailyCeilingM3(rule([], 0.01))).toBeCloseTo(864);
		expect(dailyCeilingM3(rule([], 0.01, 500))).toBe(500);
		expect(dailyCeilingM3(rule([], 0.01, 2000))).toBeCloseTo(864);
	});
	it('treats a negative or missing rate or cap as nothing', () => {
		expect(dailyCeilingM3(rule([], -1))).toBe(0);
		expect(dailyCeilingM3(rule([], Number.NaN))).toBe(0);
		expect(dailyCeilingM3(rule([], 0.01, -5))).toBe(0);
	});
});

describe('monthCapacity', () => {
	it('lists the water year Oct … Sep with the enabled rules in each month and their summed ceilings', () => {
		const out = monthCapacity([rule([10, 11], 0.01), rule([11, 1], 0.02, 1000), rule([11], 1, null, false)]);
		expect(out.map((m) => m.month)).toEqual(['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']);
		expect(out[0]).toEqual({ month: 'Oct', rules: 1, maxM3Day: expect.closeTo(864) });
		// The disabled rule doesn't count; the capped one adds its cap, not 1,728.
		expect(out[1]).toEqual({ month: 'Nov', rules: 2, maxM3Day: expect.closeTo(1864) });
		expect(out[2]).toEqual({ month: 'Dec', rules: 0, maxM3Day: 0 });
		expect(out[3]).toEqual({ month: 'Jan', rules: 1, maxM3Day: 1000 });
	});
	it('takes each month\'s own rate from a rule with monthly rates (engine 1.14.0)', () => {
		const monthly = { ...rule([], 0), ...withMonthlyRates([0.01, 0, 0, 0.02, 0, 0, 0, 0, 0, 0, 0, 0]) };
		const out = monthCapacity([monthly, rule([10], 0.01, 500)]);
		expect(out[0]).toEqual({ month: 'Oct', rules: 2, maxM3Day: expect.closeTo(1364) });
		expect(out[1]).toEqual({ month: 'Nov', rules: 0, maxM3Day: 0 });
		expect(out[3]).toEqual({ month: 'Jan', rules: 1, maxM3Day: expect.closeTo(1728) });
	});
	it('is twelve empty months with no rules', () => {
		expect(monthCapacity([]).every((m) => m.rules === 0 && m.maxM3Day === 0)).toBe(true);
	});
});
