import { describe, expect, it } from 'vitest';
import { monthOfEpochDay, toEpochDay } from '../calendar';
import { drySeason, DRY_SEASON_MIN_DAYS_PER_MONTH, seasonMask } from './season';

const start = toEpochDay('2001-10-01');
const days = 730;
/** Two years of daily values set by calendar month. */
const byMonth = (f: (m: number) => number | null) => Array.from({ length: days }, (_, t) => f(monthOfEpochDay(start + t)));

describe('drySeason', () => {
	it('picks the six consecutive months with the lowest mean flow, wrapping past December', () => {
		// Low Nov–Apr (a summer-dry, winter-rainfall river).
		const v = byMonth((m) => (m >= 11 || m <= 4 ? 1 : 5));
		expect(drySeason([{ source: 'flow_observed_m3s', values: v }], start)).toEqual({ months: [11, 12, 1, 2, 3, 4], source: 'flow_observed_m3s' });
	});

	it('finds a summer-rainfall dry season (May–Oct) from the same rule', () => {
		const v = byMonth((m) => (m >= 5 && m <= 10 ? 0.2 : 3));
		expect(drySeason([{ source: 'natural_flow', values: v }], start)!.months).toEqual([5, 6, 7, 8, 9, 10]);
	});

	it('breaks a tie by the window starting earliest in the water year (October)', () => {
		expect(drySeason([{ source: 'natural_flow', values: byMonth(() => 2) }], start)!.months).toEqual([10, 11, 12, 1, 2, 3]);
	});

	it('skips a record with a thin calendar month and uses the next one', () => {
		// The gauge has only 27 valid days of every February: not enough.
		const gauge = byMonth((m) => (m === 2 ? null : 1));
		let feb = 0;
		for (let t = 0; t < days; t++) if (monthOfEpochDay(start + t) === 2 && feb++ < DRY_SEASON_MIN_DAYS_PER_MONTH - 1) gauge[t] = 1;
		const natural = byMonth((m) => (m >= 5 && m <= 10 ? 0 : 1));
		const s = drySeason(
			[
				{ source: 'flow_observed_m3s', values: gauge },
				{ source: 'natural_flow', values: natural }
			],
			start
		);
		expect(s).toEqual({ months: [5, 6, 7, 8, 9, 10], source: 'natural_flow' });
	});

	it('ignores negative and non-finite values, and is null when nothing covers every month', () => {
		const v = byMonth((m) => (m === 7 ? -1 : 1));
		expect(drySeason([{ source: 'flow_logger_m3s', values: v }], start)).toBeNull();
		expect(drySeason([{ source: 'natural_flow', values: [1, 2, 3] }], start)).toBeNull();
		expect(drySeason([], start)).toBeNull();
	});
});

describe('seasonMask', () => {
	it('marks the run days in the season, and none without one', () => {
		const m = seasonMask({ months: [11, 12, 1, 2, 3, 4], source: 'natural_flow' }, start, 70);
		// 2001-10-01 … 2001-10-31 are out, 2001-11-01 on are in.
		expect(m[30]).toBe(0);
		expect(m[31]).toBe(1);
		expect(Array.from(seasonMask(null, start, 5))).toEqual([0, 0, 0, 0, 0]);
	});
});
