// The demand-objects table of a run (HumanImpactTables.svelte), rendered to
// HTML with Svelte's server renderer: the basic-needs floor's columns
// (engine 1.44.0, issue #123) only when an object has a floor, "–" for one
// without. The browser flow is pinned by e2e/tests/demand-objects.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { DemandObjectSummary, RunSummary } from '@water-management/engine';
import HumanImpactTables from './HumanImpactTables.svelte';

const object = (over: Partial<DemandObjectSummary> = {}): DemandObjectSummary => ({
	id: 'v',
	name: 'Village',
	category: 'domestic',
	priority: 'first',
	destination: 'internal',
	avgDemandM3Day: 25,
	avgSuppliedM3Day: 20,
	avgDeficitM3Day: 5,
	fractionSupplied: 0.8,
	avgReturnedM3Day: 0,
	daysShort: 3,
	...over
});
const summary = (objects: DemandObjectSummary[]) =>
	({
		farms: [{ nodeId: 'a', name: 'Upper farm', avgCropRequirementM3Day: 0, avgDemandM3Day: 25, avgSuppliedM3Day: 20, avgDeficitM3Day: 5, fractionSupplied: 0.8, avgEwrShortfallM3Day: 0, daysEwrNotMet: 0, demandObjects: objects }],
		catchment: {},
		warnings: []
	}) as unknown as RunSummary;
const text = (html: string) => html.replace(/<!--[^>]*-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('the demand-objects table and the basic-needs floor (engine 1.44.0)', () => {
	it('shows the floor, the days and volume below it and the litres per person, apart from the days short', () => {
		const floored = object({ basicNeedsPopulation: 1000, basicNeedsM3Day: 25, daysBelowBasicNeeds: 2, avgBelowBasicNeedsM3Day: 4.5, avgSuppliedLitresPerPersonDay: 20 });
		const body = text(render(HumanImpactTables, { props: { summary: summary([floored, object({ id: 'm', name: 'Mill', category: 'industrial' })]) } }).body);
		expect(body).toContain('Basic-needs floor m³/day');
		expect(body).toContain('Below the floor days · m³/day');
		expect(body).toContain('Per person l/day');
		expect(body).toContain('Village Domestic first 25 20 80.0% 20 3 25 2 days 4.5 m³/day 0');
		expect(body).toContain('Mill Industrial first 25 20 80.0% – 3 – – 0');
		expect(body).toContain('– = no floor');
	});

	it('has no floor columns when no object has a floor (a run before engine 1.44.0 included)', () => {
		const body = text(render(HumanImpactTables, { props: { summary: summary([object()]) } }).body);
		expect(body).not.toContain('Basic-needs floor');
		expect(body).not.toContain('Per person');
	});
});

describe('the drought restriction tables (engine 1.46.0, WP-3.8)', () => {
	const restricted = {
		...summary([]),
		farms: [],
		droughtRestriction: {
			rule: { reviewDates: ['01-01'], levels: [{ label: 'Level 1', belowPct: 0.6, cuts: { crops: 0.3 } }] },
			years: [{ waterYear: 2003, days: 365, daysByLevel: [300, 65] }],
			daysByLevel: [300, 65],
			reviews: 1,
			units: [{ nodeId: 'a', name: 'Upper farm', avgDemandM3Day: 100, avgRestrictedDemandM3Day: 80, avgSuppliedM3Day: 75 }]
		}
	} as unknown as RunSummary;

	it('shows the rule in words, the days at each level per water year and over the run, and each unit’s cut', () => {
		const body = text(render(HumanImpactTables, { props: { summary: restricted } }).body);
		expect(body).toContain('Drought restrictions');
		expect(body).toContain('reviewed 1 Jan; Level 1 (below 60 %): crops 30 %');
		expect(body).toContain('decided 1 time in the run');
		expect(body).toContain('Water year Days No restriction Level 1 (below 60 %) Days restricted');
		expect(body).toContain('2003/04 365 300 65 65');
		expect(body).toContain('Whole run 365 300 65 65');
		expect(body).toContain('Upper farm 100 80 20 20.0% 75');
		expect(body).toContain('not the restriction notice farmers see');
	});

	it('has no drought restriction tables without the rule', () => {
		expect(text(render(HumanImpactTables, { props: { summary: summary([object()]) } }).body)).not.toContain('Drought restrictions');
	});
});
