// The farm view's map words and colours (issue #326 A3; farmMap.ts).
import { describe, expect, it } from 'vitest';
import type { FarmMapFeature } from '$lib/api/types';
import { BAND_TOKEN } from '$lib/components/map/mapStatus';
import { vaalbankFixture } from './fixture';
import { asMapFeatures, FARM_BAND_TOKEN, farmFills, farmMapCard, kindWord, mapWords, placeText, showsMap } from './farmMap';

const sp = (s: string) => s.replace(/[  ]/g, ' ');
const box = (x: number, y: number, d: number) => ({
	type: 'Polygon' as const,
	coordinates: [
		[
			[x, y],
			[x + d, y],
			[x + d, y + d],
			[x, y + d],
			[x, y]
		] as [number, number][]
	]
});
const FEATURES: FarmMapFeature[] = [
	{ id: 'p1', kind: 'farm_parcel', name: 'Vaalbank north', geometry: box(28.4, -26.1, 0.02), areaM2: 41_000, center: [28.41, -26.09] },
	{ id: 'd1', kind: 'dam', name: 'Vaalbank dam', geometry: { type: 'Point', coordinates: [28.42, -26.08] }, areaM2: null, center: [28.42, -26.08] },
	{ id: 'g1', kind: 'gauge', name: 'C8H001', geometry: { type: 'Point', coordinates: [28.5, -26.0] }, areaM2: null, center: [28.5, -26.0] },
	{ id: 'r1', kind: 'river', name: 'Sandspruit', geometry: { type: 'LineString', coordinates: [[28.3, -26.2], [28.6, -25.9]] }, areaM2: null, center: [28.45, -26.05] },
	{ id: 'b1', kind: 'catchment_boundary', name: 'Catchment', geometry: box(28.2, -26.3, 0.5), areaM2: 2.5e9, center: [28.45, -26.05] }
];

describe('farmMapCard', () => {
	it('says in words everything the map shows: the land with its area, the dam, the river, the gauge, the boundary and where', () => {
		const vm = farmMapCard(FEATURES, vaalbankFixture().farm);
		expect(vm.heading).toBe('Your hydrological unit on the map');
		expect(vm.about).toMatch(/It shows no other hydrological unit\.$/);
		expect(vm.lines.map(sp)).toEqual(['Your land: Vaalbank north (4.1 ha)', 'Your dam: Vaalbank dam', 'Rivers: Sandspruit', 'Gauges: C8H001', 'The catchment boundary']);
		expect(sp(vm.place)).toBe('Where: about 26.090° S, 28.410° E.');
		expect(vm.label).toBe('Map of your hydrological unit');
	});

	it('colours the land by the farm view’s own band and says the band in words, in the text and the key', () => {
		const vm = farmMapCard(FEATURES, vaalbankFixture().farm);
		expect(vm.status).toEqual(['Your land is coloured by the model’s look back: ', { b: 'Model: watch' }, '.']);
		expect(vm.legend).toEqual([
			{ kind: 'farm_parcel', label: 'Your land · Model: watch' },
			{ kind: 'dam', label: 'Your dam' },
			{ kind: 'river', label: 'River' },
			{ kind: 'gauge', label: 'Gauge' },
			{ kind: 'catchment_boundary', label: 'Catchment boundary' }
		]);
	});

	it('says no band and colours nothing without a headline', () => {
		const farm = vaalbankFixture().farm;
		farm.river.band = null;
		const vm = farmMapCard(FEATURES, farm);
		expect(vm.status).toBeNull();
		expect(vm.legend[0]).toEqual({ kind: 'farm_parcel', label: 'Your land' });
		expect(farmFills(FEATURES, null, () => '#123456')).toEqual({});
	});

	it('lists only what is there, and words a nameless feature by its kind', () => {
		const vm = farmMapCard([{ ...FEATURES[1]!, name: '' }], vaalbankFixture().farm);
		expect(vm.lines).toEqual(['Your dam']);
		expect(vm.legend.map((l) => l.kind)).toEqual(['dam']);
		expect(sp(vm.place)).toBe('Where: about 26.080° S, 28.420° E.');
	});
});

describe('showsMap', () => {
	it('shows a map only when the farm has land or a dam of its own on it', () => {
		expect(showsMap(FEATURES)).toBe(true);
		expect(showsMap(FEATURES.slice(2))).toBe(false);
		expect(showsMap([])).toBe(false);
	});
});

describe('farmFills', () => {
	it('fills the farm’s own polygons in the band’s colour, never a point, the river or the boundary', () => {
		const seen: string[] = [];
		const fills = farmFills(FEATURES, 'short', (t) => (seen.push(t), 'rgb(1, 2, 3)'));
		expect(fills).toEqual({ p1: 'rgb(1, 2, 3)' });
		expect(seen).toEqual(['--danger']);
	});

	it('uses the workspace map’s band colours, so a farmer sees their land in the colour the WUA does', () => {
		for (const band of ['ok', 'watch', 'short'] as const) expect(FARM_BAND_TOKEN[band]).toBe(BAND_TOKEN[band]);
	});
});

describe('the map’s words', () => {
	it('words every kind on a farm’s map for the reader, and the map component’s own lines', () => {
		expect(['farm_parcel', 'dam', 'gauge', 'river', 'catchment_boundary'].map((k) => kindWord(k as FarmMapFeature['kind']))).toEqual([
			'Your land',
			'Your dam',
			'Gauge',
			'River',
			'Catchment boundary'
		]);
		const w = mapWords();
		expect(w.loading).toBe('Drawing the map…');
		expect(w.zoomIn).toBe('Zoom in');
		expect(w.kind('dam')).toBe('Your dam');
	});

	it('writes a place in degrees with its hemisphere', () => {
		expect(sp(placeText([28.41, -26.09]))).toBe('26.090° S, 28.410° E');
		expect(sp(placeText([-0.5, 51.5]))).toBe('51.500° N, 0.500° W');
	});

	it('gives the shared map component features with no node or properties', () => {
		const [f] = asMapFeatures(FEATURES.slice(0, 1));
		expect(f).toMatchObject({ id: 'p1', kind: 'farm_parcel', nodeId: null, nodeName: null, properties: {} });
	});
});
