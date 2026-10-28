import { describe, expect, it } from 'vitest';
import { afterResponse, settleAfterResponse } from './afterResponse.js';

describe('afterResponse', () => {
	it('waits for every registered work, a rejected one and one registered while waiting included', async () => {
		const done: string[] = [];
		afterResponse(new Promise<void>((r) => setTimeout(() => (done.push('a'), r()), 20)));
		afterResponse(
			new Promise<void>((_, reject) =>
				setTimeout(() => {
					done.push('b');
					afterResponse(new Promise<void>((r) => setTimeout(() => (done.push('c'), r()), 20)));
					reject(new Error('charge failed'));
				}, 10)
			)
		);
		await settleAfterResponse();
		expect(done.sort()).toEqual(['a', 'b', 'c']);
	});

	it('returns at once with nothing pending', async () => {
		await expect(settleAfterResponse()).resolves.toBeUndefined();
	});
});
