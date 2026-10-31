// The engine's random-network soak (checkAll on FUZZ_CASES seeds from
// FUZZ_SEED, GR4J runoff), split across shard files
// so vitest runs them on separate cores. One file runs in one worker, so the
// soak as two 400-case tests in one file set the whole engine suite's wall
// time (~130 s); four shards bring it under the next-slowest file.
//
// Each shard file is one call, fuzzShard(i, SHARDS): it takes every
// seed in its contiguous slice of the range, so the shards together cover
// exactly the seeds the single test did. Inside a shard the slice is cut
// into tests of CHUNK seeds (chunkRanges), run one after another in the
// shard's worker: one 100-seed test took ~15 s alone but 120 s+ on a slow CI
// runner (run 41083075763), so each test now holds a quarter of the work
// and stays well inside its hang guard, the seeds unchanged. FUZZ_CASES /
// FUZZ_SEED work as before (a soak: FUZZ_CASES=20000 pnpm test);
// FUZZ_MAX_FAILURES caps the failures reported by each test.
//
// Each test's timeout is a hang guard, not a budget: FUZZ_MS_PER_CASE per
// case (default 600, ~3x a case alone), at least 2 minutes. A release soak
// (scripts/release/engine-build.mjs) raises it to RELEASE_MS_PER_CASE: a slow
// CI runner once took ~0.4 s a case, timing out three 400-case shards with
// every invariant holding and stopping web@0.1.6.
import { describe, expect, it } from 'vitest';
import { randomInput, shrink } from '../testing/fuzz';
import { checkAll } from '../testing/invariants';

export const SHARDS = 4;
/** Seeds per vitest test inside a shard (a quarter of a default 100-seed shard). */
export const CHUNK = 25;

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const CASES = Number(env.FUZZ_CASES ?? 400);
const SEED0 = Number(env.FUZZ_SEED ?? 1);
const MAX_FAILURES = Number(env.FUZZ_MAX_FAILURES ?? 3);
const MS_PER_CASE = Number(env.FUZZ_MS_PER_CASE ?? 600);

/** A shard's timeout: `msPerCase` a case, never under 2 minutes; a malformed value takes the default. */
export function shardTimeoutMs(cases: number, msPerCase = MS_PER_CASE): number {
	const per = Number.isFinite(msPerCase) && msPerCase > 0 ? msPerCase : 600;
	return Math.max(120_000, cases * per);
}

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

/** Seeds [from, to) cut into consecutive [a, b) pieces of at most `size`, covering it exactly once. */
export function chunkRanges(from: number, to: number, size = CHUNK): Array<[number, number]> {
	const step = Math.max(1, Math.floor(size));
	const out: Array<[number, number]> = [];
	for (let a = from; a < to; a += step) out.push([a, Math.min(to, a + step)]);
	return out;
}

export function fuzzShard(i: number, n = SHARDS): void {
	const [first, last] = shardRange(i, n);
	const parts = chunkRanges(first, last);
	describe('engine invariants on random networks', () => {
		parts.forEach(([from, to], k) => fuzzChunk(from, to, `shard ${i} of ${n}, part ${k + 1} of ${parts.length}`));
	});
}

function fuzzChunk(from: number, to: number, label: string): void {
	it(`seeds ${from}–${to - 1} of ${CASES} from ${SEED0}, GR4J runoff (${label})`, () => {
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
	}, shardTimeoutMs(to - from)); // a fraction of a second a case alone; a hang guard (see the top), the release's far looser
}
