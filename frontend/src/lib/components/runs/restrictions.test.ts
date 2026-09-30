import type { RunSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { restrictionView } from './restrictions';

const summary: NonNullable<RunSummary['droughtRestriction']> = {
	rule: { reviewDates: ['01-01'], liftDates: ['05-01'], levels: [{ label: 'Level 1', belowPct: 0.6, cuts: { crops: 0.3 } }, { belowPct: 0.3, cuts: { crops: 0.6 } }], source: ' WUA decision ' },
	years: [
		{ waterYear: 2003, days: 365, daysByLevel: [300, 65, 0] },
		{ waterYear: 2004, days: 100, daysByLevel: [60, 20, 20] }
	],
	daysByLevel: [360, 85, 20],
	reviews: 2,
	units: [
		{ nodeId: 'b', name: 'Farm B', avgDemandM3Day: 0, avgRestrictedDemandM3Day: 0, avgSuppliedM3Day: 0, avgCutOnRestrictedDaysM3Day: null },
		{ nodeId: 'a', name: 'Farm A', avgDemandM3Day: 100, avgRestrictedDemandM3Day: 80, avgSuppliedM3Day: 75, avgCutOnRestrictedDaysM3Day: 88.6 }
	]
};

describe('restrictionView (engine 1.52.0, WP-3.8)', () => {
	it('is null for a run without the rule', () => {
		expect(restrictionView(undefined)).toBeNull();
	});
	it('names the levels, counts the restricted days per water year and over the run, and each unit’s cut', () => {
		const v = restrictionView(summary)!;
		expect(v.rule).toBe('reviewed 1 Jan, lifted 1 May; Level 1 (below 60 %): crops 30 %; Level 2 (below 30 %): crops 60 %');
		expect(v.source).toBe('WUA decision');
		expect(v.levels).toEqual(['No restriction', 'Level 1 (below 60 %)', 'Level 2 (below 30 %)']);
		expect(v.years).toEqual([
			{ label: '2003/04', days: 365, byLevel: [300, 65, 0], restricted: 65 },
			{ label: '2004/05', days: 100, byLevel: [60, 20, 20], restricted: 40 }
		]);
		expect(v.total).toEqual({ days: 465, byLevel: [360, 85, 20], restricted: 105 });
		// The most cut first; the cut on restricted days beside the run means.
		expect(v.units[0]).toEqual({ nodeId: 'a', name: 'Farm A', demand: 100, restricted: 80, cut: 20, cutShare: 0.2, supplied: 75, cutOnRestrictedDays: 88.6 });
		// No demand: no share of it cut.
		expect(v.units[1]!.cutShare).toBeNull();
	});
});
