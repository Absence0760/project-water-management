// The engine's physical invariants (packages/engine/src/testing/invariants.ts)
// on the three invented example catchments that `pnpm seed:examples` loads:
// branching networks, an intermediate gauge, dams that spill and run dry,
// transfers, 15 years of daily data. These are the models people demo with,
// so they must balance as exactly as the random fuzz networks do.
import { runModel, type DailySeries, type ModelInput, type SeriesKind } from '@water-management/engine';
import { checkAll } from '@water-management/engine/testing';
import { describe, expect, it } from 'vitest';
import { buildExamples } from '../../scripts/examples/catchments.js';

const examples = buildExamples();

describe('engine invariants on the example catchments', () => {
	it('builds all three', () => {
		expect(examples.map((e) => e.name)).toHaveLength(3);
	});

	const inputOf = (ex: (typeof examples)[number]): ModelInput => ({
		settings: ex.settings as ModelInput['settings'],
		model: ex.model,
		series: Object.fromEntries(ex.series.map((s) => [s.kind, { startDate: s.startDate, values: s.values }])) as Partial<
			Record<SeriesKind, DailySeries>
		>
	});

	for (const ex of examples) {
		it(`${ex.name}: balance, limits, report totals, order invariance, crop-area property`, () => {
			const input = inputOf(ex);
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

	it('a GR4J run of an example catchment takes under 50 ms (issue #4 phase 2)', () => {
		const input = inputOf(examples[0]!);
		input.settings = { ...input.settings, runoffModel: 'gr4j' };
		// Median of 7 after a warm-up run, so one slow run on a busy machine doesn't decide it.
		runModel(input);
		const ms = Array.from({ length: 7 }, () => {
			const t = performance.now();
			runModel(input);
			return performance.now() - t;
		}).sort((a, b) => a - b);
		expect(ms[3]).toBeLessThan(50);
	});
});
