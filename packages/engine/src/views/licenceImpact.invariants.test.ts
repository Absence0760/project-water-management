// Invariants of the licence-impact board (model.md §2.14a) on real runs of
// synthetic catchments: the waterfall closes, `other` is exactly the rest of
// the application's water account, and the months below the Reserve are the
// runs' own, counted once.
import { describe, expect, it } from 'vitest';
import { testCatchment } from '../outlook/testCatchment';
import type { ModelInput, ModelOutput } from '../project';
import { runModel } from '../run';
import { randomInput } from '../testing/fuzz';
import { licenceImpactByYearClass, type LicenceImpact } from './licenceImpact';

/** The same catchment with every crop area × `factor`: the "application". */
const moreCrops = (input: ModelInput, factor: number): ModelInput => ({
	...input,
	model: { ...input.model, cropAreas: input.model.cropAreas.map((a) => ({ ...a, areaM2: a.areaM2 * factor })) }
});

/** Mean over the class's years of the application's Σ |account term|, the scale its float noise is judged against. */
function scaleOf(app: ModelOutput, years: number[]): number {
	const rows = app.summary.supplyAssurance!.waterAccount.years.filter((r) => r.waterYear !== null && years.includes(r.waterYear));
	return rows.reduce((s, r) => s + r.scaleM3, 0) / rows.length;
}

function expectCloses(impact: LicenceImpact, app: ModelOutput) {
	for (const c of impact.classes) {
		if (!c.waterfall) continue;
		const w = c.waterfall;
		const tol = 1e-9 * scaleOf(app, c.waterYears) + 1e-6;
		// natural − existing − proposed − other = left
		expect(Math.abs(w.naturalM3 - w.existingUseM3 - w.proposedM3 - w.otherM3 - w.leftM3)).toBeLessThanOrEqual(tol);
		// other is the rest of the water account, part by part
		const parts = Object.values(w.otherParts).reduce((s, v) => s + v, 0);
		expect(Math.abs(parts - w.otherM3)).toBeLessThanOrEqual(tol);
		expect(w.existingUseM3).toBeGreaterThanOrEqual(-tol);
		expect(w.leftM3).toBeGreaterThanOrEqual(-tol);
	}
}

describe('licenceImpactByYearClass on the synthetic test catchment', () => {
	for (const seed of [7, 19]) {
		const input = testCatchment({ recordWide: true, seed });
		const background = runModel(input);
		const application = runModel(moreCrops(input, 1.8));
		const impact = licenceImpactByYearClass({ background, application });

		it(`seed ${seed}: closes the waterfall and reads the Reserve months of both runs`, () => {
			expect(impact.metric).toBe('reserveMonthsMet');
			expect(impact.classes.filter((c) => c.enoughYears).length).toBeGreaterThan(0);
			expectCloses(impact, application);
			const outlet = (r: ModelOutput) => r.summary.ewrAssurance!.find((s) => s.isOutlet)!;
			for (const c of impact.classes) {
				if (!c.below) continue;
				const notMet = (r: ModelOutput) => outlet(r).months.filter((m) => c.waterYears.includes(m.waterYear) && !m.met).length;
				expect(c.below.background).toBe(notMet(background));
				expect(c.below.application).toBe(notMet(application));
				expect(c.below.units).toBe(outlet(background).months.filter((m) => c.waterYears.includes(m.waterYear)).length);
				expect(c.verdict).toBe(c.below.change > 0 ? 'moreBelow' : c.below.change < 0 ? 'fewerBelow' : 'noChange');
			}
			// More crops use more water, and leave less at the outlet, over the record.
			const withYears = impact.classes.filter((c) => c.waterfall);
			expect(withYears.reduce((s, c) => s + c.waterfall!.proposedM3, 0)).toBeGreaterThan(0);
			for (const c of withYears) expect(c.waterfall!.leftM3).toBeLessThanOrEqual(c.waterfall!.backgroundLeftM3 + 1e-6);
		});

		it(`seed ${seed}: a run against itself changes nothing`, () => {
			const same = licenceImpactByYearClass({ background, application: background });
			for (const c of same.classes) {
				if (!c.waterfall) continue;
				expect(c.waterfall.proposedM3).toBe(0);
				expect(c.waterfall.otherParts.naturalDifferenceM3).toBe(0);
				expect(c.waterfall.leftM3).toBe(c.waterfall.backgroundLeftM3);
				expect(c.verdict).toBe('noChange');
			}
		});
	}
});

describe('licenceImpactByYearClass on fuzz runs', () => {
	it('closes the waterfall with every account term in play (groundwater, transfers, land cover, off-takes …)', () => {
		let classesSeen = 0;
		for (const seed of [3, 11, 29, 47, 61, 88, 104, 131]) {
			const input = randomInput(seed, { maxDays: 3600, maxNodes: 6 });
			const background = runModel(input);
			const application = runModel(moreCrops(input, 1.5));
			const impact = licenceImpactByYearClass({ background, application });
			expectCloses(impact, application);
			classesSeen += impact.classes.filter((c) => c.waterfall).length;
		}
		expect(classesSeen).toBeGreaterThan(0);
	});
});
