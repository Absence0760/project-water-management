// Runoff from each unit's own rain (engine ≥ 1.78.0, docs/model.md §2.4h) on
// random networks (./testing/fuzz.ts withUnitRain): every invariant, order
// invariance, the forecast prefix and resuming from a snapshot hold, and
// every rule of the forcing turns up; the same with a reference gauge
// (k_unit, engine ≥ 1.85.0) and a CHIRPS-GEFS forecast levelled per unit.
// Soak: UNIT_RAIN_CASES=2000.
import { describe, expect, it } from 'vitest';
import { monthOfEpochDay, toEpochDay } from '../calendar';
import { referenceCellSeriesKey, type DailySeries, type ModelInput } from '../project';
import { runModel } from '../run';
import { randomInput, withEwrSplit, withUnitRain } from '../testing/fuzz';
import { checkForecastPrefix, withForecastTail } from '../testing/forecastInvariants';
import { checkAll } from '../testing/invariants';
import { checkResume } from '../testing/warmstartInvariants';

const CASES = Number(process.env.UNIT_RAIN_CASES ?? 60);

describe('per-unit rain on random networks', () => {
	it(`every invariant holds on ${CASES} seeds, and every rule turns up`, () => {
		const fails: string[] = [];
		const seen = new Set<string>();
		for (let seed = 1; seed <= CASES; seed++) {
			// The EWR split by natural MAR (engine ≥ 1.94.0) on about half the seeds.
			const input = withEwrSplit(withUnitRain(randomInput(seed), seed), seed);
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
			const input = withEwrSplit(withUnitRain(randomInput(seed, { maxDays: 700 }), seed), seed);
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

/**
 * withUnitRain plus a reference gauge (the catchment gauge) at the first land
 * unit, its cell the gauge × a seeded factor per month (some days blank), so
 * every unit's CHIRPS is levelled by the factors × k_unit. Null when the
 * input has no catchment gauge or no land unit.
 */
function withReference(input: ModelInput, seed: number): ModelInput | null {
	const gauge = input.series.rain_catchment_mm;
	const unit = input.model.nodes.filter((n) => n.kind === 'farm' && n.areaKm2 > 0).sort((a, b) => (a.id < b.id ? -1 : 1))[0];
	if (!gauge || !unit || input.settings.unitRain?.mode !== 'perUnit') return null;
	const k = Array.from({ length: 12 }, (_, m) => 0.2 + ((seed * 7 + m * 5) % 13) / 4); // 0.2–3.2: some months past 0.5–2, some past 0.25–4
	const d0 = toEpochDay(gauge.startDate);
	const values = gauge.values.map((v, i) => (typeof v !== 'number' || (i + seed) % 17 === 0 ? null : v / k[monthOfEpochDay(d0 + i) - 1]!));
	(input.series as Record<string, DailySeries>)[referenceCellSeriesKey(unit.id)] = { startDate: gauge.startDate, values };
	input.settings.unitRain = { ...input.settings.unitRain, reference: { gauge: 'rain_catchment_mm', unitId: unit.id } };
	return input;
}

describe('per-unit rain on the reference factors, on random networks', () => {
	it('every invariant holds, k_unit turns up, and a CHIRPS-GEFS forecast tail changes no historical day', () => {
		const fails: string[] = [];
		let kUnits = 0;
		for (let seed = 1; seed <= Math.ceil(CASES / 2); seed++) {
			const input = withReference(withUnitRain(randomInput(seed), seed), seed);
			if (!input) continue;
			try {
				for (const u of runModel(input).summary.unitRain?.units ?? []) if (u.chirps?.source === 'reference' && u.chirps.kUnit) kUnits++;
			} catch {
				// checkAll judges a refused input.
			}
			const r = checkAll(input, seed);
			if (r) fails.push(`${seed}: ${r}`);
			const p = checkForecastPrefix({ ...withForecastTail(structuredClone(input), seed), forecastRainSource: 'chirps_gefs' });
			if (p) fails.push(`${seed} (forecast): ${p}`);
		}
		expect(fails.slice(0, 10)).toEqual([]);
		expect(kUnits).toBeGreaterThan(0);
	}, 600_000);
});
