// The Map tab's Checks panel (MapChecks.svelte, issue #326 A4): heading,
// count, one item per warning with its features to pick, and "No problems
// found" when there are none. Server-rendered; clicks are e2e's. (Not
// MapChecks.test.ts: mapChecks.test.ts differs from it only in case.)
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { MapFeature, MapNodeArea } from '$lib/api/types';
import MapChecks from './MapChecks.svelte';

// Comments stripped until none are left, so one split by another can't survive
// as a fresh '<!--' (CodeQL js/incomplete-multi-character-sanitization).
const text = (html: string) => {
	let s = html;
	for (let prev = ''; prev !== s; ) {
		prev = s;
		s = s.replace(/<!--[\s\S]*?-->/g, '');
	}
	return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
};

const parcel = (id: string, name: string, nodeId: string | null, x: number): MapFeature => ({
	id,
	kind: 'farm_parcel',
	name,
	nodeId,
	nodeName: null,
	damPosition: null,
	geometry: { type: 'Polygon', coordinates: [[[x, -34], [x + 0.02, -34], [x + 0.02, -33.98], [x, -33.98], [x, -34]]] },
	properties: {},
	areaM2: 4e6,
	center: [x + 0.01, -33.99],
	sourceId: null,
	createdBy: null,
	createdAt: '2026-10-01T00:00:00Z',
	updatedAt: '2026-10-01T00:00:00Z'
});
const unit = (id: string, name: string): MapNodeArea => ({ id, name, kind: 'farm', areaKm2: 4, areaSource: 'map', areaFeatureId: null });

describe('the Checks panel', () => {
	it('says "No problems found" with nothing to flag', () => {
		const { body } = render(MapChecks, { props: { features: [parcel('p1', 'Alpha', 'a', 21)], nodes: [unit('a', 'Alpha')] } });
		expect(text(body)).toContain('Checks No problems found.');
		expect(body).not.toContain('data-testid="map-checks-count"');
	});

	it('counts the warnings and lists each, with a button per feature when it can pick', () => {
		// Two parcels on top of each other, and a unit with none.
		const features = [parcel('p1', 'Alpha', 'a', 21), parcel('p2', 'Bravo', null, 21.01)];
		const nodes = [unit('a', 'Alpha'), unit('c', 'Charlie')];
		const { body } = render(MapChecks, { props: { features, nodes, onpick: () => {} } });
		const t = text(body);
		expect(t).toContain('Checks 2 warnings');
		expect(t).toContain('Charlie has no farm parcel linked.');
		expect(t).toContain('Farm parcels Alpha and Bravo overlap.');
		expect(body.match(/<li /g)).toHaveLength(2);
		expect(body).toContain('data-check="overlap:p1:p2"');
		expect(body.match(/<button[^>]*aria-label="Show (Alpha|Bravo) on the map"/g)).toHaveLength(2);
		expect(body).not.toContain('No problems found');
	});

	it('shows the first three warnings and folds the rest behind "Show all"', () => {
		// One parcel (linked to Alpha) and four units without one: four warnings.
		const nodes = [unit('a', 'Alpha'), ...['Bravo', 'Charlie', 'Delta', 'Echo'].map((n) => unit(n.toLowerCase(), n))];
		const { body } = render(MapChecks, { props: { features: [parcel('p1', 'Alpha', 'a', 21)], nodes, cap: 3 } });
		const t = text(body);
		expect(t).toContain('Checks 4 warnings');
		expect(body.match(/<li /g)).toHaveLength(3);
		expect(t).toContain('Show all 4 warnings');
		expect(body).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-controls="[^"]+-list"/);
	});

	it('draws no "Show all" within the cap, nor without one (every warning, the default)', () => {
		const nodes = [unit('a', 'Alpha'), unit('b', 'Bravo')];
		const { body } = render(MapChecks, { props: { features: [parcel('p1', 'Alpha', 'a', 21)], nodes, cap: 3 } });
		expect(body).not.toContain('map-checks-more');
		const many = [unit('a', 'Alpha'), ...['Bravo', 'Charlie', 'Delta', 'Echo'].map((n) => unit(n.toLowerCase(), n))];
		const all = render(MapChecks, { props: { features: [parcel('p1', 'Alpha', 'a', 21)], nodes: many } }).body;
		expect(all.match(/<li /g)).toHaveLength(4);
		expect(all).not.toContain('map-checks-more');
	});

	it('leaves out its own heading inside a sheet', () => {
		const { body } = render(MapChecks, { props: { features: [parcel('p1', 'Alpha', 'a', 21)], nodes: [unit('a', 'Alpha')], heading: false } });
		expect(body).not.toContain('<h2');
		expect(text(body)).toContain('No problems found.');
	});

	it('names the features as text without onpick', () => {
		const features = [parcel('p1', 'Alpha', null, 21), parcel('p2', 'Bravo', null, 21.01)];
		const { body } = render(MapChecks, { props: { features, nodes: [] } });
		expect(text(body)).toContain('1 warning Warnings only');
		expect(text(body)).toContain('Alpha, Bravo');
		expect(body).not.toContain('<button');
	});
});
