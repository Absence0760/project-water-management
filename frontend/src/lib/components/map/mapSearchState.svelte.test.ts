// The Map's search box's flow (MapSearchState, mapSearchState.svelte.ts): one match
// moves the view at once and lists nothing, several open the list, a pick or
// Escape closes it; the places' credit (CC BY 4.0) holds for as long as the
// answer has places, list open or not. The browser flow is
// e2e/tests/map-search.spec.ts.
import { describe, expect, it, vi } from 'vitest';
import type { MapSearchAnswer, MapSearchHit } from '#lib/api/types.js';
import { MapSearchState } from './mapSearchState.svelte';

const GEONAMES = 'GeoNames (geonames.org), CC BY 4.0';
const place = (name: string, source = GEONAMES, synthetic = false): MapSearchHit => ({
	kind: 'place',
	code: null,
	name,
	river: '',
	feature: 'P.PPL',
	admin1: '11',
	country: 'ZA',
	alias: null,
	lon: 20.7,
	lat: -33.5,
	bbox: null,
	dataset: 'GeoNames-ZA-2026-10',
	synthetic,
	source
});
const gauge: MapSearchHit = { kind: 'gauge', code: 'Z1H003', name: 'Sandspruit @ Brandvlei', river: 'Sandspruit', feature: null, admin1: null, country: null, alias: null, lon: 21.41, lat: -33.865, bbox: null, dataset: 'synthetic', synthetic: true, source: null };
const answering = (hits: MapSearchHit[]) => vi.fn(async (q: string): Promise<MapSearchAnswer> => ({ q, hits, truncated: false, placesLoaded: true }));

describe('MapSearchState', () => {
	it('one place: the view moves at once, no list, and its credit still shows', async () => {
		const onpick = vi.fn();
		const s = new MapSearchState(answering([place('Môrester')]), onpick);
		await s.find('morester');
		expect(onpick).toHaveBeenCalledWith(expect.objectContaining({ name: 'Môrester' }));
		expect(s.open).toBe(false);
		expect(s.said).toBe('Showing Môrester on the map.');
		expect(s.credits).toEqual([{ source: GEONAMES, synthetic: false }]);
	});

	it('several places: the list opens with their credit, which stays once one is picked', async () => {
		const onpick = vi.fn();
		const s = new MapSearchState(answering([place('Kwartsvallei'), place('Kwartsvallei 12')]), onpick);
		await s.find('kwartsvallei');
		expect(s.open).toBe(true);
		expect(onpick).not.toHaveBeenCalled();
		expect(s.credits).toHaveLength(1);
		s.pick(s.answer!.hits[1]!);
		expect(s.open).toBe(false);
		expect(onpick).toHaveBeenCalledOnce();
		expect(s.credits).toHaveLength(1);
		// Escape with the list already closed does nothing; the credit stays.
		expect(s.close()).toBe(false);
		expect(s.credits).toHaveLength(1);
	});

	it('no place in the answer, no credit; a failed search clears it', async () => {
		const s = new MapSearchState(answering([gauge]), vi.fn());
		await s.find('z1h 003');
		expect(s.credits).toEqual([]);
		const search = answering([place('Sandlaagte')]);
		const failing = new MapSearchState(search, vi.fn());
		await failing.find('sandlaagte');
		expect(failing.credits).toHaveLength(1);
		search.mockRejectedValueOnce(new Error('offline'));
		await failing.find('sandlaagte');
		expect(failing.error).toBe('The search failed: offline');
		expect(failing.credits).toEqual([]);
	});

	it('refuses a query under 2 characters without asking the backend', async () => {
		const search = answering([]);
		const s = new MapSearchState(search, vi.fn());
		await s.find(' k ');
		expect(s.error).toBe('Type at least 2 letters or digits.');
		expect(search).not.toHaveBeenCalled();
	});
});
