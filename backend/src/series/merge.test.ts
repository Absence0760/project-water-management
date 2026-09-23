import { describe, expect, it } from 'vitest';
import { mergeDaily } from './merge.js';

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
	it('handles month and leap-year boundaries by calendar day', () => {
		const m = mergeDaily({ startDate: '2024-02-28', values: [1] }, { startDate: '2024-03-01', values: [3] });
		expect(m).toEqual({ startDate: '2024-02-28', values: [1, null, 3] });
	});
});
