// Transfers → Takes → "Percentage of available flow" (percentOfFlow.ts): a curve by month with b = 0.
import { diversionCurvesOf, diversionMonthsProblem, diversionWant, type Transfer } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { isPercentOfFlow, percentsOf, setPercent, toPercentOfFlow, withPercents } from './percentOfFlow';

const RATE = 0.3; // m³/s, the canal
const rule = (over: Partial<Transfer> = {}): Transfer =>
	({
		id: 't',
		fromNodeId: 'a',
		toNodeId: 'b',
		months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
		maxRateM3s: RATE,
		dailyCapM3: null,
		minStoragePct: 0,
		enabled: true,
		priority: 1,
		source: 'river',
		sizing: 'capacity',
		...over
	}) as Transfer;

describe('toPercentOfFlow', () => {
	it('starts a rule up to a maximum at 100 % every month, with a unit the model accepts, and runs as a valid curve', () => {
		const t = rule();
		Object.assign(t, toPercentOfFlow(t));
		expect(percentsOf(t)).toEqual(new Array(12).fill(100));
		expect(t.diversionFlowUnit).toBe('m3/s');
		expect(diversionMonthsProblem(t)).toBeNull();
		expect(isPercentOfFlow(t)).toBe(true);
	});
	it('keeps the percentages and the unit a rule already has', () => {
		const t = rule({ ...withPercents([49, ...new Array(11).fill(30)]), diversionFlowUnit: 'L/s' });
		expect(toPercentOfFlow(t)).toMatchObject({ diversionFlowUnit: 'L/s' });
		expect(percentsOf({ ...t, ...toPercentOfFlow(t) })).toEqual([49, ...new Array(11).fill(30)]);
	});
});

describe('isPercentOfFlow', () => {
	it('is a curve rule whose every running month is a · x⁰ with no largest share below 100 %', () => {
		expect(isPercentOfFlow(rule())).toBe(false);
		expect(isPercentOfFlow(rule(withPercents(new Array(12).fill(49))))).toBe(true);
		const curve = rule({ sizing: 'diversionCurve', monthlyDiversion: new Array(12).fill({ coefficient: 2000, exponent: -0.9, maxPct: 0.95 }) });
		expect(isPercentOfFlow(curve)).toBe(false);
		const capped = rule({ sizing: 'diversionCurve', monthlyDiversion: new Array(12).fill({ coefficient: 49, exponent: 0, maxPct: 0.4 }) });
		expect(isPercentOfFlow(capped)).toBe(false);
	});
	it('a month at a maximum makes it a formula by month, unless that month is off', () => {
		const list = withPercents(new Array(12).fill(49)).monthlyDiversion!.map((m, k) => (k === 3 ? null : m));
		expect(isPercentOfFlow(rule({ sizing: 'diversionCurve', monthlyDiversion: list }))).toBe(false);
		const rates = new Array(12).fill(RATE);
		rates[3] = 0;
		expect(isPercentOfFlow(rule({ sizing: 'diversionCurve', monthlyDiversion: list, monthlyRateM3s: rates, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].filter((m) => m !== 1), maxRateM3s: RATE }))).toBe(true);
	});
});

describe('setPercent', () => {
	it('sets one month, capped at 100 %', () => {
		const t = rule(withPercents(new Array(12).fill(100)));
		Object.assign(t, setPercent(t, 0, 49));
		Object.assign(t, setPercent(t, 1, 140));
		expect(percentsOf(t).slice(0, 3)).toEqual([49, 100, 100]);
	});
	it('0 or blank turns the month off rather than storing a 0 % curve the model refuses', () => {
		const t = rule({ ...withPercents(new Array(12).fill(49)), diversionFlowUnit: 'm3/s' });
		Object.assign(t, setPercent(t, 2, 0));
		expect(t.monthlyRateM3s![2]).toBe(0);
		expect(t.months).not.toContain(12);
		expect(diversionMonthsProblem(t)).toBeNull();
		expect(isPercentOfFlow(t)).toBe(true);
	});
});

describe('what it takes', () => {
	it('is the percentage of the flow leaving the source at any flow, in the curve the run reads', () => {
		for (const unit of ['L/s', 'm3/s', 'm3/day', 'Ml/day'] as const) {
			const t = rule({ ...withPercents(new Array(12).fill(49)), diversionFlowUnit: unit });
			const october = diversionCurvesOf(t)[10]!;
			for (const u0 of [3, 1_000, 20_000, 6_000_000]) expect(diversionWant(october, u0, u0)).toBeCloseTo(0.49 * u0, 6);
			expect(diversionWant(october, 0, 0)).toBe(0);
		}
	});
});
