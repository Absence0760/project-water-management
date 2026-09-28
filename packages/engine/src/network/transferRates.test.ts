// A transfer rule's maximum rate month by month (engine 1.14.0, docs/model.md §2.6).
import { describe, expect, it } from 'vitest';
import type { Transfer } from '../project';
import { canMove } from './transferSeries';
import { hasMonthlyRates, monthlyRatesMismatch, transferActiveMonths, transferDailyLimit, transferRatesM3s, withMonthlyRates, WATER_YEAR_MONTHS } from './transferRates';

const rule = (over: Partial<Transfer> = {}): Transfer => ({
	id: 't',
	fromNodeId: 'a',
	toNodeId: 'b',
	months: [1, 2],
	maxRateM3s: 0.5,
	dailyCapM3: null,
	minStoragePct: 0,
	enabled: true,
	priority: 0,
	...over
});

describe('transfer rates by month', () => {
	it('reads one max rate in the listed months as a rate per water-year month', () => {
		// Oct … Sep: January is index 3, February 4.
		expect(transferRatesM3s(rule())).toEqual([0, 0, 0, 0.5, 0.5, 0, 0, 0, 0, 0, 0, 0]);
		expect(hasMonthlyRates(rule())).toBe(false);
	});

	it('uses the monthly list when it has one: its own rate each month, off where 0', () => {
		const r = rule({ ...withMonthlyRates([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]) });
		expect(r.months).toEqual([9, 10]);
		expect(r.maxRateM3s).toBe(2);
		const on = transferActiveMonths(r);
		expect([...on.keys()].filter((m) => on[m])).toEqual([9, 10]);
		const lim = transferDailyLimit(r);
		expect(lim[10]).toBe(86_400);
		expect(lim[9]).toBe(172_800);
		expect(lim[1]).toBe(0);
	});

	it('caps every month at the daily cap', () => {
		const lim = transferDailyLimit(rule({ ...withMonthlyRates([1, 0.001, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), dailyCapM3: 1000 }));
		expect(lim[10]).toBe(1000);
		expect(lim[11]).toBeCloseTo(86.4, 12);
	});

	it('keeps a listed month with max rate 0 running (moving nothing), as before', () => {
		const r = rule({ maxRateM3s: 0 });
		expect(transferActiveMonths(r)[1]).toBe(1);
		expect(transferDailyLimit(r)[1]).toBe(0);
		expect(canMove(r)).toBe(false);
	});

	it('falls back to the months and max rate when the monthly list is not twelve numbers ≥ 0', () => {
		const r = rule({ monthlyRateM3s: [1, 2] });
		expect(hasMonthlyRates(r)).toBe(false);
		expect(transferRatesM3s(r)).toEqual(transferRatesM3s(rule()));
		expect(monthlyRatesMismatch(r)).toMatch(/twelve numbers/);
	});

	it('says when the months or max rate kept beside the list disagree with it', () => {
		const ok = rule({ ...withMonthlyRates([0, 0, 0, 0.5, 0.25, 0, 0, 0, 0, 0, 0, 0]) });
		expect(monthlyRatesMismatch(ok)).toBeNull();
		expect(monthlyRatesMismatch({ ...ok, months: [1] })).toMatch(/months/);
		expect(monthlyRatesMismatch({ ...ok, maxRateM3s: 1 })).toMatch(/max rate/);
		expect(monthlyRatesMismatch(rule())).toBeNull();
	});

	it('can move only when some month it runs in has a limit above 0', () => {
		expect(canMove(rule({ ...withMonthlyRates(new Array(12).fill(0)) }))).toBe(false);
		expect(canMove(rule({ ...withMonthlyRates([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.1]) }))).toBe(true);
	});

	it('lists the water-year months October first', () => {
		expect(WATER_YEAR_MONTHS[0]).toBe(10);
		expect(WATER_YEAR_MONTHS[11]).toBe(9);
	});
});
