import { describe, expect, it } from 'vitest';
import { toEpochDay } from '@water-management/engine';
import { changedDays, feedDays, keepHandDays, mergeDaily, releaseDays, sameDaily, subtractRuns, unionRuns } from './merge.js';

describe('mergeDaily', () => {
	it('appends the next days', () => {
		expect(mergeDaily({ startDate: '2025-03-30', values: [1, 2] }, { startDate: '2025-04-01', values: [3, 4] })).toEqual({
			startDate: '2025-03-30',
			values: [1, 2, 3, 4]
		});
	});
	it('overwrites overlapping days with the new readings', () => {
		expect(mergeDaily({ startDate: '2025-01-01', values: [1, 2, 3] }, { startDate: '2025-01-02', values: [20, 30, 40] })).toEqual({
			startDate: '2025-01-01',
			values: [1, 20, 30, 40]
		});
	});
	it('fills a gap with nulls and can extend backwards', () => {
		expect(mergeDaily({ startDate: '2025-01-05', values: [5] }, { startDate: '2025-01-01', values: [1, 2] })).toEqual({
			startDate: '2025-01-01',
			values: [1, 2, null, null, 5]
		});
	});
	it('starts a new series when there is none', () => {
		expect(mergeDaily(null, { startDate: '2025-01-01', values: [1] })).toEqual({ startDate: '2025-01-01', values: [1] });
	});
	it('keepOnNull: a null leaves the existing day, a value still overwrites, and gaps still fill with null', () => {
		const existing = { startDate: '2025-01-01', values: [1, 2, 3] };
		expect(mergeDaily(existing, { startDate: '2025-01-02', values: [null, 30, null, 50] }, { keepOnNull: true })).toEqual({
			startDate: '2025-01-01',
			values: [1, 2, 30, null, 50]
		});
		// Positive control: without the option the same nulls erase.
		expect(mergeDaily(existing, { startDate: '2025-01-02', values: [null, 30] }).values).toEqual([1, null, 30]);
	});
	it('handles month and leap-year boundaries by calendar day', () => {
		const m = mergeDaily({ startDate: '2024-02-28', values: [1] }, { startDate: '2024-03-01', values: [3] });
		expect(m).toEqual({ startDate: '2024-02-28', values: [1, null, 3] });
	});
});

describe('sameDaily (mergeSeries skips a merge that changes nothing)', () => {
	const e = { startDate: '2025-01-01', values: [1, null, 3] };
	it('is true for a re-sent batch and for gaps that keep what is there', () => {
		expect(sameDaily(e, mergeDaily(e, { startDate: '2025-01-02', values: [null, 3] }))).toBe(true);
		expect(sameDaily(e, mergeDaily(e, { startDate: '2025-01-02', values: [0, 3] }))).toBe(false);
		expect(sameDaily(e, mergeDaily(e, { startDate: '2025-01-01', values: [1, null, null] }, { keepOnNull: true }))).toBe(true);
	});
	it('is false for a changed value, a filled gap, a longer series or another start', () => {
		expect(sameDaily(e, { startDate: '2025-01-01', values: [1, null, 4] })).toBe(false);
		expect(sameDaily(e, { startDate: '2025-01-01', values: [1, 0, 3] })).toBe(false);
		expect(sameDaily(e, { startDate: '2025-01-01', values: [1, null, 3, null] })).toBe(false);
		expect(sameDaily(e, { startDate: '2024-12-31', values: [1, null, 3] })).toBe(false);
	});
});

describe('day runs (time_series.feed_days)', () => {
	it('union joins overlapping and adjacent runs and sorts', () => {
		expect(unionRuns([[10, 12]], [[5, 6], [12, 14], [6, 7]])).toEqual([[5, 7], [10, 14]]);
		expect(unionRuns([], [])).toEqual([]);
	});
	it('subtract cuts holes, trims ends and drops covered runs', () => {
		expect(subtractRuns([[0, 10]], [[3, 5]])).toEqual([[0, 3], [5, 10]]);
		expect(subtractRuns([[0, 10], [20, 30]], [[5, 25]])).toEqual([[0, 5], [25, 30]]);
		expect(subtractRuns([[0, 10]], [[0, 10]])).toEqual([]);
		expect(subtractRuns([[0, 10]], [[10, 12]])).toEqual([[0, 10]]);
	});
});

describe('feedDays: a data feed replaces only its own days (#30)', () => {
	const d = (iso: string) => toEpochDay(iso);
	const user = { startDate: '2026-01-01', values: [10, null, 30] };
	it('keeps a value it did not write, fills an empty day and the days beyond the series', () => {
		const plan = feedDays(user, [], { startDate: '2025-12-31', values: [0, 1, 2, 3, 4] });
		expect(plan.incoming).toEqual({ startDate: '2025-12-31', values: [0, null, 2, null, 4] });
		expect(plan).toMatchObject({ kept: 2, written: 3 });
		expect(plan.owned).toEqual([
			[d('2025-12-31'), d('2026-01-01')],
			[d('2026-01-02'), d('2026-01-03')],
			[d('2026-01-04'), d('2026-01-05')]
		]);
		expect(mergeDaily(user, plan.incoming, { keepOnNull: true })).toEqual({ startDate: '2025-12-31', values: [0, 10, 2, 30, 4] });
	});
	it('replaces a value it wrote (final over preliminary), and a gap keeps its day its own', () => {
		const owned: [number, number][] = [[d('2026-01-01'), d('2026-01-04')]];
		const plan = feedDays(user, owned, { startDate: '2026-01-01', values: [11, null, 33] });
		expect(plan).toMatchObject({ kept: 0, written: 2, owned });
		expect(plan.incoming.values).toEqual([11, null, 33]);
	});
	it('writes a whole new series as its own', () => {
		expect(feedDays(null, [], { startDate: '2026-01-01', values: [1, null, 3] })).toMatchObject({
			kept: 0,
			written: 2,
			owned: [
				[d('2026-01-01'), d('2026-01-02')],
				[d('2026-01-03'), d('2026-01-04')]
			]
		});
	});
	it('a user write releases the days it overwrites; with keepOnNull only the ones it has values for', () => {
		const owned: [number, number][] = [[d('2026-01-01'), d('2026-01-11')]];
		expect(releaseDays(owned, { startDate: '2026-01-03', values: [1, null] })).toEqual([
			[d('2026-01-01'), d('2026-01-03')],
			[d('2026-01-05'), d('2026-01-11')]
		]);
		expect(releaseDays(owned, { startDate: '2026-01-03', values: [1, null] }, { keepOnNull: true })).toEqual([
			[d('2026-01-01'), d('2026-01-03')],
			[d('2026-01-04'), d('2026-01-11')]
		]);
	});
});

// Days edited by hand (212_series_hand_days): an automated writer's days there take the stored value.
describe('keepHandDays', () => {
	const d = (s: string) => toEpochDay(s);
	const existing = { startDate: '2026-01-01', values: [1, null, 3, 4] };
	it('puts the stored value (or blank) back on each hand day, and leaves the others', () => {
		const hand: [number, number][] = [[d('2026-01-02'), d('2026-01-04')]];
		expect(keepHandDays(existing, hand, { startDate: '2026-01-01', values: [9, 9, 9, 9, 9] })).toEqual({ startDate: '2026-01-01', values: [9, null, 3, 9, 9] });
	});
	it('reads only the incoming days a hand run overlaps', () => {
		const hand: [number, number][] = [[d('2025-12-30'), d('2026-01-02')]];
		expect(keepHandDays(existing, hand, { startDate: '2026-01-04', values: [7] })).toEqual({ startDate: '2026-01-04', values: [7] });
		expect(keepHandDays(existing, hand, { startDate: '2025-12-31', values: [7, 7, 7] })).toEqual({ startDate: '2025-12-31', values: [null, 1, 7] });
	});
	it('returns the days as they are when none is a hand day', () => {
		const incoming = { startDate: '2026-01-01', values: [5] };
		expect(keepHandDays(existing, [], incoming)).toBe(incoming);
	});
});

describe('changedDays', () => {
	const d = (s: string) => toEpochDay(s);
	it('the days whose value differs from the stored one, a cleared day included', () => {
		const existing = { startDate: '2026-01-01', values: [1, 2, 3] };
		expect(changedDays(existing, { startDate: '2026-01-02', values: [2, null, 5] })).toEqual([[d('2026-01-03'), d('2026-01-05')]]);
		expect(changedDays(existing, { startDate: '2026-01-01', values: [1] })).toEqual([]);
		expect(changedDays(null, { startDate: '2026-01-01', values: [null, 1] })).toEqual([[d('2026-01-02'), d('2026-01-03')]]);
	});
});
