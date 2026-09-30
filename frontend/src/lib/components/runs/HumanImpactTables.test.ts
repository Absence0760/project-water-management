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
/** The rendered HTML as text: comments dropped, each tag a space, whitespace collapsed. A scan, not chained regex replaces (CodeQL js/incomplete-multi-character-sanitization). */
const text = (html: string) => {
	let out = '';
	for (let i = 0; i < html.length; ) {
		if (html.startsWith('<!--', i)) {
			const end = html.indexOf('-->', i + 4);
			i = end < 0 ? html.length : end + 3;
		} else if (html[i] === '<') {
			const end = html.indexOf('>', i);
			out += ' ';
			i = end < 0 ? html.length : end + 1;
		} else out += html[i++];
	}
	return out.replace(/\s+/g, ' ');
};

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

describe('the other water users’ pumps table (engine 1.58.0)', () => {
	const user = (over: object = {}) => ({ nodeId: 'u', name: 'Town', priority: 'senior', avgDemandM3Day: 800, avgSuppliedM3Day: 225, avgDeficitM3Day: 575, fractionSupplied: 0.28, avgReturnedM3Day: 0, avgEwrChargeM3Day: 0, daysEwrNotMet: 0, ...over });
	const withUsers = (users: object[]) => ({ farms: [], users, catchment: {}, warnings: [] }) as unknown as RunSummary;

	it('lists each user with a pump capacity, even when the users table itself is left out', () => {
		const s = withUsers([user({ avgRiverAbstractionM3Day: 225, avgPumpLimitedM3Day: 250, daysPumpLimited: 2 }), user({ nodeId: 'm', name: 'Mill' })]);
		const body = text(render(HumanImpactTables, { props: { summary: s, users: false } }).body);
		expect(body).toContain('Other water users’ pumps');
		expect(body).toContain('Town 800 225 250 2');
		// A user without a pump isn't in it.
		expect(body).not.toContain('Mill');
	});

	it('has no pumps table when no user has a pump capacity', () => {
		const body = text(render(HumanImpactTables, { props: { summary: withUsers([user()]) } }).body);
		expect(body).not.toContain('pumps');
	});
});
