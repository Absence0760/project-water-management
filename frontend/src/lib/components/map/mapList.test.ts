import { describe, expect, it } from 'vitest';
import type { MapFeature, MapFeatureKind, MapNodeArea } from '$lib/api/types';
import { areaSourceOf, areaSourceText, boundaryNextStep, delineationLines, featureForNode, groupFeatures, headerLine, inListOrder, keyGroups, pickedFeature, presentKey, shortHash } from './mapList';
import { channelColour, overlayColours, riverNetworkColour } from './mapStyle';

const ring = [
	[0, 0],
	[1, 0],
	[1, 1],
	[0, 0]
] as [number, number][];
function f(id: string, kind: MapFeatureKind, areaM2: number | null, extra: Partial<MapFeature> = {}): MapFeature {
	const geometry = areaM2 === null ? (kind === 'river' ? { type: 'LineString' as const, coordinates: ring } : { type: 'Point' as const, coordinates: [0, 0] as [number, number] }) : { type: 'Polygon' as const, coordinates: [ring] };
	return { id, kind, name: id, nodeId: null, nodeName: null, geometry, properties: {}, areaM2, center: [0, 0], sourceId: null, nonContributingM2: null, createdBy: null, createdAt: '2024-01-01', ...extra } as MapFeature;
}
const farm = (id: string, extra: Partial<MapNodeArea> = {}): MapNodeArea => ({ id, name: id, kind: 'farm', areaKm2: 10, areaSource: 'typed', areaBasis: null, areaFeatureId: null, ...extra });

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

describe('presentKey', () => {
	const c = overlayColours(false);
	const labels = (groups: ReturnType<typeof presentKey>) => groups.map((g) => `${g.label}: ${g.items.map((i) => i.label).join(', ')}`);
	it('lists only the entries a feature on the map stands for, and drops an empty group', () => {
		expect(labels(presentKey(keyGroups(c), [f('B', 'catchment_boundary', 9e8), f('P', 'farm_parcel', 1e6), f('G', 'gauge', null)]))).toEqual(['Areas: catchment boundary, parcel', 'Points: gauge']);
		expect(presentKey(keyGroups(c), [])).toEqual([]);
	});
	it('tells a dam drawn as an area from one placed as a point, and keys a river only as a line', () => {
		expect(labels(presentKey(keyGroups(c), [f('D', 'dam', null), f('R', 'river', null)]))).toEqual(['Lines: river', 'Points: dam']);
		expect(labels(presentKey(keyGroups(c), [f('D', 'dam', 5e4), f('O', 'other', null)]))).toEqual(['Areas: dam', 'Points: other']);
	});
	it('keeps the River network layer’s line while the layer is on, with nothing of the project’s drawn', () => {
		expect(labels(presentKey(keyGroups(c, { riverNetwork: riverNetworkColour(false) }), []))).toEqual(['Lines: river network']);
	});
	it('keeps the terrain channels while they are drawn, first among the lines, with nothing of the project’s drawn', () => {
		expect(labels(presentKey(keyGroups(c, { channels: channelColour(false), riverNetwork: riverNetworkColour(false) }), [f('R', 'river', null)]))).toEqual([
			'Lines: terrain channels, river network, river'
		]);
		expect(labels(presentKey(keyGroups(c, { channels: channelColour(false) }), []))).toEqual(['Lines: terrain channels']);
	});
});

describe('the two lines a delineation shows (the operator asked: orange or blue?)', () => {
	it('names the terrain channels as what the click and the outline follow, and the mapped rivers as reference only', () => {
		for (const dark of [false, true]) {
			const lines = delineationLines({ channels: channelColour(dark), riverNetwork: riverNetworkColour(dark) });
			expect(lines).toEqual([
				{ label: 'terrain channels', swatch: 'line', colour: channelColour(dark), note: 'where your click goes; the outline follows these' },
				{ label: 'river network', swatch: 'dashed', colour: riverNetworkColour(dark), note: 'mapped rivers, for reference only; they can sit off the terrain channels' }
			]);
			// Without the River network layer, only the channels.
			expect(delineationLines({ channels: channelColour(dark) }).map((i) => i.label)).toEqual(['terrain channels']);
			// The key says the same words while the channels are drawn, and nothing about them otherwise.
			const keyed = keyGroups(overlayColours(dark), { channels: channelColour(dark), riverNetwork: riverNetworkColour(dark) }).find((g) => g.label === 'Lines')!.items;
			expect(keyed.slice(0, 2)).toEqual(lines);
			expect(keyGroups(overlayColours(dark), { riverNetwork: riverNetworkColour(dark) }).flatMap((g) => g.items).some((i) => i.note)).toBe(false);
		}
	});
});

describe('boundaryNextStep: what turns the boundary on the map into the model', () => {
	const base = { canStart: false, canDivide: false, pendingStart: false, pendingDivide: false, unitAreasFromMap: 0 };
	it('offers Start from the map while the model is empty', () => {
		const s = boundaryNextStep({ ...base, canStart: true })!;
		expect(s).toMatchObject({ sheet: 'start', label: 'Start from the map' });
		expect(s.text).toMatch(/^This boundary is on the map, not in the model yet\. Start from the map proposes/);
		expect(boundaryNextStep({ ...base, canStart: true, pendingStart: true })!.label).toBe('Review the proposed model');
	});
	it('offers Divide the model once it has nodes, saying what it does', () => {
		const s = boundaryNextStep({ ...base, canDivide: true })!;
		expect(s).toEqual({
			sheet: 'divide',
			label: 'Divide the model',
			text: 'This boundary is on the map, not in the model yet. Divide the model splits it into each unit’s area at your dams, abstraction points and gauges, for you to tick.'
		});
		expect(boundaryNextStep({ ...base, canDivide: true, pendingDivide: true })!.label).toBe('Review the proposed division');
	});
	it('offers nothing once a unit took its area from the map, or when neither flow is open (a viewer, no elevation model)', () => {
		expect(boundaryNextStep({ ...base, canDivide: true, unitAreasFromMap: 2 })).toBeNull();
		expect(boundaryNextStep(base)).toBeNull();
	});
});
