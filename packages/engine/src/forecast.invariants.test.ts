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

describe('forecast mode on random networks', () => {
	it(`prefix stability on ${CASES} random networks with a forecast tail`, () => {
		const failures: string[] = [];
		for (let seed = FIRST; seed < FIRST + CASES && failures.length < MAX_FAILURES; seed++) {
			const bad = checkForecastPrefix(withForecastTail(randomInput(seed), seed));
			if (bad) failures.push(`seed ${seed}: ${bad}`);
		}
		expect(failures).toEqual([]);
	}, Math.max(120_000, CASES * 300));

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
