import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from '../calendar';
import type { DemandScheduleWindow } from '../project';
import { DEMAND_SCHEDULE_MAX_FACTOR, easterSunday, isoWeekday, scheduleFactors, scheduleWindowProblem } from './demandSchedule';

const win = (over: Partial<DemandScheduleWindow> = {}): DemandScheduleWindow => ({
	label: '',
	span: 'always',
	from: null,
	to: null,
	easterFrom: null,
	easterTo: null,
	weekdays: null,
	factor: 0,
	...over
});
/** The factor on each day from `from` for `days` days. */
const factors = (w: DemandScheduleWindow[], from: string, days: number, warnings: string[] = []) => {
	const f = scheduleFactors(w, toEpochDay(from), days, warnings, 'demand object "T"');
	return f ? Array.from(f) : null;
};

describe('easterSunday', () => {
	it('matches published Easter dates, early and late', () => {
		for (const [y, d] of [
			[1981, '1981-04-19'],
			[2000, '2000-04-23'],
			[2008, '2008-03-23'],
			[2011, '2011-04-24'],
			[2019, '2019-04-21'],
			[2024, '2024-03-31'],
			[2025, '2025-04-20'],
			[2038, '2038-04-25']
		] as const)
			expect(fromEpochDay(easterSunday(y)), String(y)).toBe(d);
	});
	it('is always a Sunday between 22 March and 25 April', () => {
		for (let y = 1900; y <= 2100; y++) {
			const e = easterSunday(y);
			expect(isoWeekday(e)).toBe(7);
			const md = fromEpochDay(e).slice(5);
			expect(md >= '03-22' && md <= '04-25', `${y}: ${md}`).toBe(true);
		}
	});
});

describe('isoWeekday', () => {
	it('numbers Monday 1 to Sunday 7, before 1970 too', () => {
		expect(isoWeekday(toEpochDay('1970-01-01'))).toBe(4);
		expect(isoWeekday(toEpochDay('2026-09-28'))).toBe(1);
		expect(isoWeekday(toEpochDay('2026-09-27'))).toBe(7);
		expect(isoWeekday(toEpochDay('1969-12-28'))).toBe(7);
	});
});

describe('scheduleFactors', () => {
	it('is null without a schedule, so an object without one costs nothing', () => {
		expect(factors([], '2020-01-01', 5)).toBeNull();
		expect(scheduleFactors(null, 0, 5, [], '')).toBeNull();
		expect(scheduleFactors(undefined, 0, 5, [], '')).toBeNull();
	});

	it('switches a weekly pattern off at weekends', () => {
		// 2026-09-24 is a Thursday: Thu Fri Sat Sun Mon.
		expect(factors([win({ weekdays: [6, 7] })], '2026-09-24', 5)).toEqual([1, 1, 0, 0, 1]);
	});

	it('covers a yearly span, bounds included, and wraps the year end', () => {
		expect(factors([win({ span: 'yearly', from: '12-30', to: '01-02', factor: 0.5 })], '2020-12-29', 6)).toEqual([1, 0.5, 0.5, 0.5, 0.5, 1]);
		expect(factors([win({ span: 'yearly', from: '06-01', to: '06-02', factor: 2 })], '2021-05-31', 4)).toEqual([1, 2, 2, 1]);
	});

	it('takes 29 February as a day of the span in a leap year only', () => {
		expect(factors([win({ span: 'yearly', from: '02-29', to: '02-29' })], '2020-02-28', 3)).toEqual([1, 0, 1]);
		expect(factors([win({ span: 'yearly', from: '02-29', to: '02-29' })], '2021-02-28', 2)).toEqual([1, 1]);
	});

	it('covers a one-off date range once', () => {
		expect(factors([win({ span: 'range', from: '2021-01-02', to: '2021-01-03' })], '2021-01-01', 4)).toEqual([1, 0, 0, 1]);
		// The same dates a year later are untouched.
		expect(factors([win({ span: 'range', from: '2021-01-02', to: '2021-01-03' })], '2022-01-01', 4)).toEqual([1, 1, 1, 1]);
	});

	it('follows Easter from year to year: Good Friday to Family Day', () => {
		const w = [win({ span: 'easter', easterFrom: -2, easterTo: 1, factor: 3 })];
		// Easter 2024 was 31 March, 2025 20 April.
		expect(factors(w, '2024-03-28', 6)).toEqual([1, 3, 3, 3, 3, 1]);
		expect(factors(w, '2025-04-17', 6)).toEqual([1, 3, 3, 3, 3, 1]);
		expect(factors(w, '2024-01-01', 366)!.filter((v) => v === 3)).toHaveLength(4);
	});

	it('lets the later of two overlapping windows set the day, and combines a span with weekdays', () => {
		// December off, but weekdays in December at 0.3 (a skeleton works).
		const w = [win({ span: 'yearly', from: '12-01', to: '12-31' }), win({ span: 'yearly', from: '12-01', to: '12-31', weekdays: [1, 2, 3, 4, 5], factor: 0.3 })];
		// 2025-12-05 is a Friday: Fri Sat Sun Mon.
		expect(factors(w, '2025-12-05', 4)).toEqual([0.3, 0, 0, 0.3]);
		// Reversed, the whole-month window wins every December day.
		expect(factors([...w].reverse(), '2025-12-05', 4)).toEqual([0, 0, 0, 0]);
	});

	it('skips a window with a problem and says so; runs the rest', () => {
		const w: string[] = [];
		expect(factors([win({ label: 'Bad', span: 'yearly', from: '13-01', to: '01-01' }), win({ weekdays: [7] })], '2026-09-26', 2, w)).toEqual([1, 0]);
		expect(w.join()).toMatch(/schedule window 1 \("Bad"\) is skipped/);
		const w2: string[] = [];
		expect(factors([win({ factor: -1 })], '2026-09-26', 2, w2)).toBeNull();
		expect(w2).toHaveLength(1);
	});
});

describe('scheduleWindowProblem', () => {
	it('accepts every well-formed span', () => {
		for (const w of [
			win(),
			win({ weekdays: [1] }),
			win({ span: 'yearly', from: '02-29', to: '03-01' }),
			win({ span: 'range', from: '2020-01-01', to: '2020-01-01' }),
			win({ span: 'easter', easterFrom: -46, easterTo: 49 }),
			win({ factor: DEMAND_SCHEDULE_MAX_FACTOR })
		])
			expect(scheduleWindowProblem(w), JSON.stringify(w)).toBeNull();
	});
	it('refuses a bad factor, weekday, date or order', () => {
		for (const w of [
			win({ factor: -0.1 }),
			win({ factor: DEMAND_SCHEDULE_MAX_FACTOR + 1 }),
			win({ factor: Number.NaN }),
			win({ weekdays: [] }),
			win({ weekdays: [0] }),
			win({ weekdays: [8] }),
			win({ weekdays: [1.5] }),
			win({ span: 'yearly', from: '02-30', to: '03-01' }),
			win({ span: 'yearly', from: '2020-01-01', to: '03-01' }),
			win({ span: 'yearly', from: null, to: '03-01' }),
			win({ span: 'range', from: '2021-02-29', to: '2021-03-01' }),
			win({ span: 'range', from: '2021-03-02', to: '2021-03-01' }),
			win({ span: 'easter', easterFrom: 2, easterTo: 1 }),
			win({ span: 'easter', easterFrom: -61, easterTo: 1 }),
			win({ span: 'easter', easterFrom: 0.5, easterTo: 1 }),
			win({ span: 'monthly' as never })
		])
			expect(scheduleWindowProblem(w), JSON.stringify(w)).not.toBeNull();
	});
});
