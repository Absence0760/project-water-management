import { describe, expect, it } from 'vitest';
import { ruleOf, shardRange, shardTimeoutMs, SHARDS } from './shard';

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

describe('ruleOf', () => {
	it('drops node ids, day numbers and the seed, so a shrunk case keeps the same rule', () => {
		expect(ruleOf('mass balance n3 day 12: off by 4')).toBe('mass balance');
		expect(ruleOf('order invariance (seed 3899): n2 differs')).toBe('order invariance');
		expect(ruleOf('storage day 7: negative')).toBe('storage');
	});

	it('handles a long run of unclosed "(seed 0" inside the test timeout (quadratic before, CodeQL js/polynomial-redos)', () => {
		const msg = '(seed 0'.repeat(100_000);
		expect(ruleOf(msg)).toBe(msg);
		// ~20 s before; the timeout is a hang guard, not a budget (linear time takes a millisecond).
	}, 5_000);
});

describe('shardTimeoutMs', () => {
	it('gives each case its share, never under 2 minutes', () => {
		expect(shardTimeoutMs(400, 600)).toBe(240_000);
		expect(shardTimeoutMs(100, 600)).toBe(120_000);
		expect(shardTimeoutMs(400, 2_000)).toBe(800_000);
	});

	it('falls back to 600 ms a case on a malformed FUZZ_MS_PER_CASE, never a zero or NaN timeout', () => {
		for (const bad of [NaN, 0, -5, Infinity]) expect(shardTimeoutMs(400, bad)).toBe(240_000);
	});
});
