// The engine's physical invariants (packages/engine/src/testing/invariants.ts)
// on the three invented example catchments that `pnpm seed:examples` loads:
// branching networks, an intermediate gauge, dams that spill and run dry,
// transfers, 15 years of daily data. These are the models people demo with,
// so they must balance as exactly as the random fuzz networks do. Built
// without the stored fit (several seconds; it only changes GR4J's
// parameters): examples.test.ts covers the examples as seeded.
import { runModel } from '@water-management/engine';
import { checkAll } from '@water-management/engine/testing';
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
	// The GR4J-run timing budget lives in examples.perf.test.ts, its own vitest
	// project (run serially via `pnpm test:perf`, not part of `pnpm test`) —
	// see docs/followups.md "Wall-clock test flakes under load" (2026-09-24).
});
