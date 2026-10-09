// Runoff from each unit's own rain (engine ≥ 1.78.0, docs/model.md §2.4h) on
// random networks (./testing/fuzz.ts withUnitRain): every invariant, order
// invariance, the forecast prefix and resuming from a snapshot hold, and
// every rule of the forcing turns up. Soak: UNIT_RAIN_CASES=2000.
import { describe, expect, it } from 'vitest';
import { runModel } from '../run';
import { randomInput, withUnitRain } from '../testing/fuzz';
import { checkForecastPrefix, withForecastTail } from '../testing/forecastInvariants';
import { checkAll } from '../testing/invariants';
import { checkResume } from '../testing/warmstartInvariants';

const CASES = Number(process.env.UNIT_RAIN_CASES ?? 60);

describe('per-unit rain on random networks', () => {
	it(`every invariant holds on ${CASES} seeds, and every rule turns up`, () => {
		const fails: string[] = [];
		const seen = new Set<string>();
		for (let seed = 1; seed <= CASES; seed++) {
			const input = withUnitRain(randomInput(seed), seed);
			try {
				for (const u of runModel(input).summary.unitRain?.units ?? []) seen.add(u.factorSource);
			} catch {
				// An input the model refuses is checkAll's to judge (it must refuse it the same way every time).
			}
			const r = checkAll(input, seed);
			if (r) fails.push(`${seed}: ${r}`);
		}
		expect(fails.slice(0, 10)).toEqual([]);
		expect([...seen].sort()).toEqual(['catchment', 'chirpsBias', 'chirpsMap', 'chirpsRaw', 'gauge', 'gaugeMap']);
	}, 600_000);

	it('a forecast tail changes no historical day, and a resumed run is the uninterrupted one', () => {
		for (let seed = 1; seed <= 12; seed++) {
			const input = withUnitRain(randomInput(seed, { maxDays: 700 }), seed);
			expect(checkForecastPrefix(withForecastTail(structuredClone(input), seed)), `seed ${seed}`).toBeNull();
			let days: number;
			try {
				days = runModel(input).days;
			} catch {
				continue;
			}
			for (const k of [0, Math.floor(days / 2)]) expect(checkResume(input, k), `seed ${seed} at ${k}`).toBeNull();
		}
	}, 600_000);
});
