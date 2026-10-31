// Forecast mode's prefix stability on random networks (WP-2.12,
// testing/forecastInvariants.ts): a run with a forecast tail keeps the
// historical series and summaries of the run without it, to the bit.
// Soak: FORECAST_FUZZ_CASES=20000 pnpm -C packages/engine exec vitest run src/forecast.invariants.test.ts
import { describe, expect, it } from 'vitest';
import { runForecastChecked } from './forecast';
import { randomInput } from './testing/fuzz';
import { checkForecastPrefix, withForecastTail } from './testing/forecastInvariants';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const CASES = Number(env.FORECAST_FUZZ_CASES ?? 40);
const FIRST = Number(env.FUZZ_SEED ?? 1);
const MAX_FAILURES = Number(env.FUZZ_MAX_FAILURES ?? 5);

// Seeds per test: one 40-seed test took ~10 s alone and passed vitest's 120 s
// hang guard on a slow CI runner (run 41083075763); tests of 10 keep the same
// seeds, each well inside it.
const CHUNK = 10;

describe('forecast mode on random networks', () => {
	for (let a = FIRST; a < FIRST + CASES; a += CHUNK) {
		const b = Math.min(FIRST + CASES, a + CHUNK);
		it(`prefix stability on random networks with a forecast tail: seeds ${a}–${b - 1} of ${CASES} from ${FIRST}`, () => {
			const failures: string[] = [];
			for (let seed = a; seed < b && failures.length < MAX_FAILURES; seed++) {
				const bad = checkForecastPrefix(withForecastTail(randomInput(seed), seed));
				if (bad) failures.push(`seed ${seed}: ${bad}`);
			}
			expect(failures).toEqual([]);
		}, Math.max(120_000, (b - a) * 300));
	}

	it('an input the model refuses is refused the same way (soak seeds 3887, 15857: a simulation start after the data)', () => {
		for (const seed of [3887, 15857]) {
			const x = withForecastTail(randomInput(seed), seed);
			expect(() => runForecastChecked(x), `seed ${seed}`).toThrow(/simulation end .* is before start/);
			expect(checkForecastPrefix(x), `seed ${seed}`).toBeNull();
		}
	});

	it('the random inputs without a tail are unchanged by forecast mode', () => {
		for (let seed = 1; seed <= 20; seed++) expect(checkForecastPrefix(randomInput(seed)), `seed ${seed}`).toBeNull();
	}, 60_000);
});
