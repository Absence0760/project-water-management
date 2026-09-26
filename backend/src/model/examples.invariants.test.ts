// The engine's physical invariants (packages/engine/src/testing/invariants.ts)
// on the three invented example catchments that `pnpm seed:examples` loads:
// branching networks, an intermediate gauge, dams that spill and run dry,
// transfers, 15 years of daily data. These are the models people demo with,
// so they must balance as exactly as the random fuzz networks do. Built
// without the stored fit (several seconds; it only changes GR4J's
// parameters): examples.test.ts covers the examples as seeded.
import { defaultProjectSettings, fromEpochDay, runModel, SUPPLY_DEFAULTS, toEpochDay } from '@water-management/engine';
import { checkAll, sameOutput } from '@water-management/engine/testing';
import { describe, expect, it } from 'vitest';
import { buildExamples, inputOf } from '../../scripts/examples/catchments.js';

const examples = buildExamples({ fit: false });

describe('engine invariants on the example catchments', () => {
	it('builds all three', () => {
		expect(examples.map((e) => e.name)).toHaveLength(3);
	});

	for (const ex of examples) {
		it(`${ex.name}, legacy runoff: balance, limits, report totals, order invariance, crop-area property`, () => {
			const input = inputOf(ex);
			input.settings = { ...input.settings, runoffModel: 'legacy' };
			// Guard against a vacuous pass: the example must actually irrigate.
			expect(input.model.cropAreas.length).toBeGreaterThan(0);
			for (const seed of [1, 2, 3]) expect(checkAll(input, seed)).toBeNull();
		}, 60_000);

		it(`${ex.name}, GR4J runoff: every invariant, including the runoff water balance`, () => {
			const input = inputOf(ex);
			input.settings = { ...input.settings, runoffModel: 'gr4j' };
			expect(runModel(input).summary.runoff?.model).toBe('gr4j');
			for (const seed of [1, 2]) expect(checkAll(input, seed)).toBeNull();
		}, 60_000);
	}
	// Supply rules (engine 0.42.0, WP-3.8) are off by default: an example with
	// no supply fields and one with the dam-only defaults written out (and an
	// inert pump capacity on every farm) give the same output to the bit.
	it('the supply fields at their defaults change nothing (WP-3.8)', () => {
		const ex = examples[1]!;
		const bare = inputOf(ex);
		bare.settings = { ...bare.settings, runoffModel: 'legacy' };
		for (const n of bare.model.nodes) {
			delete n.supplyRule;
			delete n.pumpCapacityM3Day;
			delete n.supplyTriggerPct;
			delete n.supplyStopPct;
		}
		const explicit = structuredClone(bare);
		for (const n of explicit.model.nodes) Object.assign(n, SUPPLY_DEFAULTS, n.kind === 'farm' ? { pumpCapacityM3Day: 500 } : {});
		const out = runModel(bare);
		expect(sameOutput(out, runModel(explicit))).toBe(true);
		expect(out.series.some((s) => s.key === 'river_abstraction')).toBe(false);
	}, 60_000);

	// The default run window follows the rain (engine 0.45.0, issue #54): the
	// examples' rain fills their record, so the default window is the one the
	// series span gives, and writing it out changes nothing, bit for bit.
	for (const ex of examples) {
		it(`${ex.name}: the default window is the whole record, the same run as that window written out`, () => {
			const base = inputOf(ex);
			base.settings = { ...base.settings, runoffModel: 'legacy', simulationStart: null, simulationEnd: null };
			const auto = runModel(base);
			// The rule before 0.45.0: the span of every rain series (Sandspruit's forecast runs past the record).
			const spans = (['rain_catchment_mm', 'rain_chirps_mm', 'rain_forecast_mm'] as const).flatMap((k) => {
				const s = base.series[k];
				return s ? [[toEpochDay(s.startDate), toEpochDay(s.startDate) + s.values.length - 1]] : [];
			});
			expect(auto.startDate).toBe(fromEpochDay(Math.min(...spans.map((s) => s[0]!))));
			expect(auto.endDate).toBe(fromEpochDay(Math.max(...spans.map((s) => s[1]!))));
			expect(auto.summary.warnings.filter((w) => w.startsWith('the run covers the rain record'))).toEqual([]);
			const pinned = structuredClone(base);
			pinned.settings = { ...pinned.settings, simulationStart: auto.startDate, simulationEnd: auto.endDate };
			expect(sameOutput(auto, runModel(pinned))).toBe(true);
		}, 60_000);
	}

	// Crop demand options (engine 0.43.0, issue #54): unset, they change nothing,
	// bit for bit; set, every invariant still holds on a real-sized network.
	it(`${examples[0]!.name}: absent crop efficiencies and monthly effective rain give the identical run`, () => {
		const base = inputOf(examples[0]!);
		const before = runModel(base);
		const unset = structuredClone(base);
		unset.model.crops = unset.model.crops.map((c) => ({ ...c, irrigationEfficiency: null }));
		unset.settings = { ...unset.settings, effectiveRainFractionMonthly: null };
		expect(runModel(unset)).toEqual(before);
		// The annual fraction written out for every month is the same run too.
		const repeated = structuredClone(base);
		const annual = repeated.settings.effectiveRainFraction ?? defaultProjectSettings().effectiveRainFraction;
		repeated.settings = { ...repeated.settings, effectiveRainFractionMonthly: new Array(12).fill(annual) as never };
		expect(runModel(repeated).series).toEqual(before.series);
	}, 60_000);

	it(`${examples[0]!.name}: every invariant holds with per-crop efficiencies and a monthly effective-rain fraction`, () => {
		const input = inputOf(examples[0]!);
		input.model.crops = input.model.crops.map((c, i) => ({ ...c, irrigationEfficiency: [0.9, 0.75, 0.85][i % 3] }));
		input.settings = { ...input.settings, effectiveRainFractionMonthly: [0.5, 0.6, 0.7, 0.7, 0.7, 0.6, 0.5, 0.4, 0.3, 0.3, 0.4, 0.45] as never };
		expect(checkAll(input, 1)).toBeNull();
	}, 60_000);

	// The GR4J-run timing budget lives in examples.perf.test.ts, its own vitest
	// project (run serially via `pnpm test:perf`, not part of `pnpm test`) —
	// see docs/followups.md "Wall-clock test flakes under load" (2026-09-24).
});
