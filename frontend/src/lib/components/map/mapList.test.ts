import { describe, expect, it } from 'vitest';
import type { MapFeature, MapFeatureKind, MapNodeArea } from '$lib/api/types';
import { areaSourceOf, areaSourceText, featureForNode, groupFeatures, headerLine, inListOrder, keyGroups, pickedFeature, shortHash } from './mapList';
import { overlayColours, riverNetworkColour } from './mapStyle';

const ring = [
	[0, 0],
	[1, 0],
	[1, 1],
	[0, 0]
] as [number, number][];
function f(id: string, kind: MapFeatureKind, areaM2: number | null, extra: Partial<MapFeature> = {}): MapFeature {
	const geometry = areaM2 === null ? (kind === 'river' ? { type: 'LineString' as const, coordinates: ring } : { type: 'Point' as const, coordinates: [0, 0] as [number, number] }) : { type: 'Polygon' as const, coordinates: [ring] };
	return { id, kind, name: id, nodeId: null, nodeName: null, geometry, properties: {}, areaM2, center: [0, 0], sourceId: null, createdBy: null, createdAt: '2024-01-01', ...extra } as MapFeature;
}
const farm = (id: string, extra: Partial<MapNodeArea> = {}): MapNodeArea => ({ id, name: id, kind: 'farm', areaKm2: 10, areaSource: 'typed', areaFeatureId: null, ...extra });

describe('groupFeatures', () => {
	it('puts parcels first and the boundary last, each group largest first then by name', () => {
		const groups = groupFeatures([f('Boundary', 'catchment_boundary', 9e8), f('Dam b', 'dam', 5e4), f('P small', 'farm_parcel', 1e6), f('Gauge', 'gauge', null), f('P big', 'farm_parcel', 3e7), f('P 10', 'farm_parcel', 1e6), f('P 2', 'farm_parcel', 1e6)]);
		expect(groups.map((g) => g.kind)).toEqual(['farm_parcel', 'dam', 'gauge', 'catchment_boundary']);
		expect(groups[0]!.features.map((x) => x.id)).toEqual(['P big', 'P 2', 'P 10', 'P small']);
		expect(groups[0]!.label).toBe('Farm parcels');
	});
	it('is the grid modal order too, and leaves out empty groups', () => {
		expect(inListOrder([f('R', 'river', null), f('P', 'farm_parcel', 1)]).map((x) => x.id)).toEqual(['P', 'R']);
		expect(groupFeatures([])).toEqual([]);
	});
});

describe('areaSourceOf', () => {
	const parcel = f('Parcel', 'farm_parcel', 1e7, { nodeId: 'A' });
	it('says typed for a linked unit with a typed area', () => {
		const s = areaSourceOf(parcel, [farm('A')]);
		expect(s?.source).toBe('typed');
		expect(areaSourceText(s)).toBe('area typed');
	});
	it('says this when a unit took its area from this feature, linked or not', () => {
		expect(areaSourceOf(parcel, [farm('A'), farm('B', { areaSource: 'map', areaFeatureId: 'Parcel' })])?.node.id).toBe('B');
		expect(areaSourceText(areaSourceOf(parcel, [farm('A', { areaSource: 'map', areaFeatureId: 'Parcel' })]))).toBe('area from the map');
	});
	it('says the area is from an earlier outline once the feature was reshaped or split after its area was taken', () => {
		const s = areaSourceOf(parcel, [farm('A', { areaKm2: 12, areaSource: 'map', areaFeatureId: 'Parcel' })]);
		expect(s).toMatchObject({ source: 'this', earlier: true });
		expect(areaSourceText(s)).toBe('area from an earlier outline');
		expect(areaSourceOf(parcel, [farm('A', { areaSource: 'map', areaFeatureId: 'Parcel' })])).not.toHaveProperty('earlier');
	});
	it('says other when the linked unit took its area from another feature', () => {
		expect(areaSourceOf(parcel, [farm('A', { areaSource: 'map', areaFeatureId: 'X' })])?.source).toBe('other');
	});
	it('is null for a dam, the boundary, or a parcel standing for nothing', () => {
		expect(areaSourceOf(f('D', 'dam', 1e5, { nodeId: 'A' }), [farm('A')])).toBeNull();
		expect(areaSourceOf(f('B', 'catchment_boundary', 1e9), [farm('A')])).toBeNull();
		expect(areaSourceOf(f('P', 'farm_parcel', 1e7), [farm('A')])).toBeNull();
		expect(areaSourceText(null)).toBeNull();
	});
});

describe('the pick from the URL', () => {
	const features = [f('Dam', 'dam', 1e5, { nodeId: 'A' }), f('Small', 'farm_parcel', 1e6, { nodeId: 'A' }), f('Big', 'farm_parcel', 1e7, { nodeId: 'A' }), f('G', 'gauge', null, { nodeId: 'G1' })];
	it('node= picks the node’s largest parcel, else its first linked feature', () => {
		expect(featureForNode(features, 'A')?.id).toBe('Big');
		expect(featureForNode(features, 'G1')?.id).toBe('G');
		expect(featureForNode(features, 'nope')).toBeNull();
		expect(featureForNode(features, null)).toBeNull();
	});
	it('feature= wins over node=; an unknown feature falls back to node=', () => {
		expect(pickedFeature(features, 'Dam', 'G1')?.id).toBe('Dam');
		expect(pickedFeature(features, 'gone', 'G1')?.id).toBe('G');
		expect(pickedFeature(features, null, null)).toBeNull();
	});
});

describe('headerLine', () => {
	it('counts the features, the boundary’s area and the unit areas from the map', () => {
		const line = headerLine([f('B', 'catchment_boundary', 210.22e6), f('P', 'farm_parcel', 1e7)], [farm('A'), farm('B', { areaSource: 'map' }), { ...farm('G'), kind: 'gauge' }]);
		expect(line).toBe('2 features · boundary 210.22 km² · 1 of 2 unit areas from the map');
	});
	it('says when there is nothing, and when there is no boundary', () => {
		expect(headerLine([], [])).toBe('Nothing on the map yet');
		expect(headerLine([f('G', 'gauge', null)], [])).toBe('1 feature · no boundary');
	});
});

it('shortens a SHA-256 to 12 characters', () => {
	expect(shortHash('44ad62f185801629bf8e5d06fa53d5b70cac6bba6c7f64d918902306d1cf8019')).toBe('44ad62f18580');
});

it('keys every overlay colour from mapStyle, in Areas, Lines and Points', () => {
	for (const dark of [false, true]) {
		const c = overlayColours(dark);
		const groups = keyGroups(c);
		expect(groups.map((g) => g.label)).toEqual(['Areas', 'Lines', 'Points']);
		const colours = new Set(groups.flatMap((g) => g.items.map((i) => i.colour)));
		for (const k of ['boundary', 'parcel', 'water', 'other'] as const) expect(colours).toContain(c[k]);
		// Points match CatchmentMap's markers: gauges and dams are water, told apart by shape.
		const points = groups.find((g) => g.label === 'Points')!.items;
		expect(points.find((i) => i.label === 'dam')!.colour).toBe(c.water);
		expect(points.find((i) => i.label === 'gauge')!.colour).toBe(c.water);
		// The River network layer's line joins the Lines only while the layer is on (#345).
		expect(groups.find((g) => g.label === 'Lines')!.items.map((i) => i.label)).toEqual(['river']);
		const on = keyGroups(c, { riverNetwork: riverNetworkColour(dark) }).find((g) => g.label === 'Lines')!.items;
		expect(on).toEqual([expect.objectContaining({ label: 'river' }), { label: 'river network', swatch: 'dashed', colour: riverNetworkColour(dark) }]);
	}
});
