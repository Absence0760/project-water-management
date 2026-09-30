// The demand-objects table of a run (HumanImpactTables.svelte), rendered to
// HTML with Svelte's server renderer: the basic-needs floor's columns
// (engine 1.38.0, issue #123) only when an object has a floor, "–" for one
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

describe('the demand-objects table and the basic-needs floor (engine 1.38.0)', () => {
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

	it('has no floor columns when no object has a floor (a run before engine 1.38.0 included)', () => {
		const body = text(render(HumanImpactTables, { props: { summary: summary([object()]) } }).body);
		expect(body).not.toContain('Basic-needs floor');
		expect(body).not.toContain('Per person');
	});
});
