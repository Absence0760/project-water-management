import { describe, expect, it } from 'vitest';
import { belowReserve } from './summaryChart';

describe('belowReserve', () => {
	it('turns each run of short days into one inclusive range', () => {
		expect(belowReserve({ startDate: '2021-10-01', values: [0, -5, -1, 0, 0, -2, 0, -3, -3] })).toEqual([
			{ start: '2021-10-02', end: '2021-10-03' },
			{ start: '2021-10-06', end: '2021-10-06' },
			{ start: '2021-10-08', end: '2021-10-09' }
		]);
	});

	it('ends a run at a gap, and is empty when the reserve was always met', () => {
		expect(belowReserve({ startDate: '2021-12-31', values: [-1, null, -1, Number.NaN] })).toEqual([
			{ start: '2021-12-31', end: '2021-12-31' },
			{ start: '2022-01-02', end: '2022-01-02' }
		]);
		expect(belowReserve({ startDate: '2021-10-01', values: [0, 0, 1] })).toEqual([]);
		expect(belowReserve({ startDate: '2021-10-01', values: [] })).toEqual([]);
	});
});
