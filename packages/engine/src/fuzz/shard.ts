// The engine's random-network soak (checkAll on FUZZ_CASES seeds from
// FUZZ_SEED, GR4J runoff), split across shard files
// so vitest runs them on separate cores. One file runs in one worker, so the
// soak as two 400-case tests in one file set the whole engine suite's wall
// time (~130 s); four shards bring it under the next-slowest file.
//
// Each shard file is one call, fuzzShard(i, SHARDS): it takes every
// seed in its contiguous slice of the range, so the shards together cover
// exactly the seeds the single test did. FUZZ_CASES / FUZZ_SEED /
// FUZZ_MAX_FAILURES work as before (a soak: FUZZ_CASES=20000 pnpm test).
import { describe, expect, it } from 'vitest';
import { randomInput, shrink } from '../testing/fuzz';
import { checkAll } from '../testing/invariants';

export const SHARDS = 4;

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const CASES = Number(env.FUZZ_CASES ?? 400);
const SEED0 = Number(env.FUZZ_SEED ?? 1);
const MAX_FAILURES = Number(env.FUZZ_MAX_FAILURES ?? 3);

/**
 * The rule a failure message names, without node ids and day numbers, so shrinking keeps the same failure.
 * The seed is matched as exactly "(seed <digits>)", what checkOrderInvariance writes: an open-ended
 * "(seed …[^)]*)" rescanned to the end of the message from every "(seed" when no ")" followed
 * (CodeQL js/polynomial-redos).
 */
export const ruleOf = (msg: string) => msg.split(':')[0]!.replace(/n\d+ day \d+|day \d+|\(seed \d+\)/g, '').trim();

/** Seeds [from, to) of shard `i` (1-based) of `n`. */
export function shardRange(i: number, n: number, cases = CASES, seed0 = SEED0): [number, number] {
	const per = Math.ceil(cases / n);
	return [seed0 + (i - 1) * per, Math.min(seed0 + cases, seed0 + i * per)];
}

export function fuzzShard(i: number, n = SHARDS): void {
	const [from, to] = shardRange(i, n);
	describe('engine invariants on random networks', () => {
		it(`seeds ${from}–${to - 1} of ${CASES} from ${SEED0}, GR4J runoff (shard ${i} of ${n})`, () => {
			const failures: string[] = [];
			for (let seed = from; seed < to && failures.length < MAX_FAILURES; seed++) {
				const input = randomInput(seed);
				const bad = checkAll(input, seed);
				if (!bad) continue;
				const rule = ruleOf(bad);
				const small = shrink(input, (x) => {
					const b = checkAll(x, seed);
					return b !== null && ruleOf(b) === rule;
				});
				failures.push(`seed ${seed}: ${bad}\n  shrunk: ${checkAll(small, seed)}\n  repro: ${JSON.stringify(small)}`);
			}
			expect(failures.join('\n\n')).toBe('');
		}, Math.max(120_000, (to - from) * 600)); // ~0.2 s a case alone, 3x for a loaded machine (a release soak runs 500 a shard)
	});
}
