import { describe, expect, it } from 'vitest';
import { shardRange, SHARDS } from './shard';

describe('shardRange', () => {
	it('splits the seeds into contiguous slices that cover the range exactly once', () => {
		for (const [cases, seed0] of [[400, 1], [401, 7], [3, 1], [20000, 100]] as const) {
			const seeds: number[] = [];
			for (let i = 1; i <= SHARDS; i++) {
				const [from, to] = shardRange(i, SHARDS, cases, seed0);
				for (let s = from; s < to; s++) seeds.push(s);
			}
			expect(seeds).toEqual(Array.from({ length: cases }, (_, k) => seed0 + k));
		}
	});
});
