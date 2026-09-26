import { describe, expect, it } from 'vitest';
import { cachedValues, cacheValues, forgetValues } from './valuesCache';

const meta = { id: 's1', startDate: '2021-10-01', length: 2, updatedAt: '2026-09-26T10:00:00.000Z' };

describe('valuesCache', () => {
	it('hands back values while the series still holds them', () => {
		cacheValues('p', { ...meta, values: [1, 2] });
		expect(cachedValues('p', meta)).toEqual({ startDate: '2021-10-01', values: [1, 2] });
	});

	it('is stale once the series changed, even at the same start and length', () => {
		cacheValues('p', { ...meta, values: [1, 2] });
		expect(cachedValues('p', { ...meta, updatedAt: '2026-09-26T11:00:00.000Z' })).toBeNull();
		expect(cachedValues('p', { ...meta, length: 3 })).toBeNull();
		expect(cachedValues('p', { ...meta, startDate: '2021-09-30' })).toBeNull();
	});

	it('keeps projects apart and forgets on request', () => {
		cacheValues('p', { ...meta, values: [1, 2] });
		expect(cachedValues('q', meta)).toBeNull();
		forgetValues('p', 's1');
		expect(cachedValues('p', meta)).toBeNull();
	});
});
