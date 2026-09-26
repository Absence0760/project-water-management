// runModelWithoutChecks (the uncertainty ensemble's run) is runModel less the
// plausibility checks and the assurance of supply (engine ≥ 0.32.0, WP-3.4:
// no member result reads it, so it's left out along with the checks): every
// series and every other summary figure is the same, so leaving them out
// can't change a member's result.
import { describe, expect, it } from 'vitest';
import { runModel, runModelWithoutChecks } from './run';
import { randomInput } from './testing/fuzz';

describe('runModelWithoutChecks', () => {
	it('matches runModel except for the plausibility checks, the assurance of supply, and their warnings (fuzz seeds 1–30)', () => {
		let withChecks = 0;
		let withCheckWarnings = 0;
		let withAssurance = 0;
		for (let seed = 1; seed <= 30; seed++) {
			const input = randomInput(seed);
			const full = runModel(input);
			const lean = runModelWithoutChecks(input);
			expect(lean.series, `seed ${seed}`).toEqual(full.series);
			const { plausibility, supplyAssurance, warnings, ...rest } = full.summary;
			const { plausibility: none, supplyAssurance: noAssurance, warnings: leanWarnings, ...leanRest } = lean.summary;
			expect(none, `seed ${seed}`).toBeUndefined();
			expect(noAssurance, `seed ${seed}`).toBeUndefined();
			expect(leanRest, `seed ${seed}`).toEqual(rest);
			// The checks' warnings are the last ones a run adds: the rest are the same, in order.
			expect(warnings.slice(0, leanWarnings.length), `seed ${seed}`).toEqual(leanWarnings);
			if (plausibility) withChecks++;
			if (supplyAssurance) withAssurance++;
			if (warnings.length > leanWarnings.length) withCheckWarnings++;
		}
		// Positive controls: the full run did produce checks and assurance of supply, and some checks warned.
		expect(withChecks).toBeGreaterThan(0);
		expect(withAssurance).toBeGreaterThan(0);
		expect(withCheckWarnings).toBeGreaterThan(0);
	});
});
