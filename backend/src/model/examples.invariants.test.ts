// The engine's physical invariants (packages/engine/src/testing/invariants.ts)
// on the three invented example catchments that `pnpm seed:examples` loads:
// branching networks, an intermediate gauge, dams that spill and run dry,
// transfers, 15 years of daily data. These are the models people demo with,
// so they must balance as exactly as the random fuzz networks do.
import type { DailySeries, ModelInput, SeriesKind } from '@water-management/engine';
import { checkAll } from '@water-management/engine/testing';
import { describe, expect, it } from 'vitest';
import { buildExamples } from '../../scripts/examples/catchments.js';

const examples = buildExamples();

describe('engine invariants on the example catchments', () => {
	it('builds all three', () => {
		expect(examples.map((e) => e.name)).toHaveLength(3);
	});

	for (const ex of examples) {
		it(`${ex.name}: balance, limits, report totals, order invariance, crop-area property`, () => {
			const input: ModelInput = {
				settings: ex.settings as ModelInput['settings'],
				model: ex.model,
				series: Object.fromEntries(ex.series.map((s) => [s.kind, { startDate: s.startDate, values: s.values }])) as Partial<
					Record<SeriesKind, DailySeries>
				>
			};
			// Guard against a vacuous pass: the example must actually irrigate.
			expect(input.model.cropAreas.length).toBeGreaterThan(0);
			for (const seed of [1, 2, 3]) expect(checkAll(input, seed)).toBeNull();
		}, 60_000);
	}
});
