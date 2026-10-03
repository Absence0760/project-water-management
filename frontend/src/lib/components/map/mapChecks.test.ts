// The Map tab's consistency checks (mapChecks.ts, issue #326 A4): each check
// fires on a layout that has the problem and stays quiet on one that doesn't.
// Shapes are drawn in kilometres east and north of a made-up origin and
// placed as lon/lat, rounded to 6 decimals like the seeded example
// (backend/scripts/examples/map.ts), so shared edges carry real rounding.
import { describe, expect, it } from 'vitest';
import type { MapFeature, MapFeatureKind, MapGeometry, MapNodeArea, MapPosition } from '$lib/api/types';
import { GAUGE_RIVER_DISTANCE_M, haversineM, mapChecks, OVERLAP_TOLERANCE_M } from './mapChecks';

const ORIGIN: MapPosition = [21.2, -33.64];
const KM_PER_DEG_LAT = 110.95;
const KM_PER_DEG_LON = 111.32 * Math.cos((ORIGIN[1] * Math.PI) / 180);
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const place = ([x, y]: [number, number]): MapPosition => [round6(ORIGIN[0] + x / KM_PER_DEG_LON), round6(ORIGIN[1] + y / KM_PER_DEG_LAT)];
/** A closed ring around the km rectangle with north-west corner (x, y). */
const rect = (x: number, y: number, w: number, h: number): MapGeometry => ({
	type: 'Polygon',
	coordinates: [[place([x, y - h]), place([x + w, y - h]), place([x + w, y]), place([x, y]), place([x, y - h])]]
});

let seq = 0;
const feature = (kind: MapFeatureKind, name: string, geometry: MapGeometry, over: Partial<MapFeature> = {}): MapFeature => ({
	id: `f${++seq}`,
	kind,
	name,
	nodeId: null,
	nodeName: null,
	damPosition: null,
	geometry,
	properties: {},
	areaM2: null,
	center: [0, 0],
	sourceId: null,
	createdBy: null,
	createdAt: '2026-10-01T00:00:00Z',
	updatedAt: '2026-10-01T00:00:00Z',
	...over
});
const unit = (id: string, name: string, areaKm2: number, over: Partial<MapNodeArea> = {}): MapNodeArea => ({
	id,
	name,
	kind: 'farm',
	areaKm2,
	areaSource: 'typed',
	areaFeatureId: null,
	...over
});
/** A parcel for a unit, its area the rectangle's (km²). */
const parcel = (n: MapNodeArea | null, name: string, x: number, y: number, w: number, h: number, over: Partial<MapFeature> = {}) =>
	feature('farm_parcel', name, rect(x, y, w, h), { nodeId: n?.id ?? null, nodeName: n?.name ?? null, areaM2: w * h * 1e6, ...over });
const point = (kind: MapFeatureKind, name: string, km: [number, number], over: Partial<MapFeature> = {}) =>
	feature(kind, name, { type: 'Point', coordinates: place(km) }, over);
const line = (name: string, km: [number, number][]) => feature('river', name, { type: 'LineString', coordinates: km.map(place) });
const boundary = (x: number, y: number, w: number, h: number) => feature('catchment_boundary', 'Catchment', rect(x, y, w, h), { areaM2: w * h * 1e6 });

const kinds = (checks: { id: string }[]) => checks.map((c) => c.id.split(':')[0]);

describe('the Sandspruit-like layout', () => {
	// An equivalent of the seeded "Example · Sandspruit" map: farms stacked in
	// three abutting columns, each parcel drawn to its unit's area (184 km² in
	// all), inside a 210.24 km² boundary; gauges where the streams meet.
	const AREAS: Record<string, number> = { Klipdrift: 26, Vaalbank: 30, Lemoenkraal: 24, Bosrand: 18, Grootdraai: 28, Wilgerivier: 22, Uitkyk: 20, Rietspruit: 16 };
	const COLUMNS = [
		{ x: 0, w: 6, top: 0, farms: ['Klipdrift', 'Vaalbank', 'Lemoenkraal'] },
		{ x: 6, w: 5.5, top: 0, farms: ['Bosrand', 'Grootdraai', 'Wilgerivier', 'Uitkyk'] },
		{ x: 11.5, w: 4, top: -10, farms: ['Rietspruit'] }
	];
	const BOUNDARY_KM: [number, number][] = [
		[-0.4, 0.4],
		[11.9, 0.4],
		[11.9, -9.6],
		[15.9, -9.6],
		[15.9, -14.4],
		[11.9, -14.4],
		[11.9, -16.4],
		[5.6, -16.4],
		[5.6, -13.8],
		[-0.4, -13.8],
		[-0.4, 0.4]
	];
	const nodes: MapNodeArea[] = Object.entries(AREAS).map(([name, a]) => unit(`n-${name}`, name, a));
	const features: MapFeature[] = [feature('catchment_boundary', 'Sandspruit catchment', { type: 'Polygon', coordinates: [BOUNDARY_KM.map(place)] }, { areaM2: 210.24e6 })];
	const centre = new Map<string, [number, number]>([
		['Melkhout Gauge', [6, -68 / 5.5]],
		['Sandspruit Outlet', [10.5, -16.2]]
	]);
	for (const c of COLUMNS) {
		let y = c.top;
		for (const name of c.farms) {
			const h = AREAS[name] / c.w;
			features.push(parcel(nodes.find((n) => n.name === name)!, name, c.x, y, c.w, h));
			centre.set(name, [c.x + c.w / 2, y - h / 2]);
			y -= h;
		}
	}
	for (const g of ['Melkhout Gauge', 'Sandspruit Outlet']) features.push(point('gauge', g, centre.get(g)!));
	const RIVERS = [
		['Bosrand', 'Grootdraai', 'Wilgerivier', 'Melkhout Gauge'],
		['Klipdrift', 'Vaalbank', 'Lemoenkraal', 'Melkhout Gauge'],
		['Rietspruit', 'Uitkyk'],
		['Melkhout Gauge', 'Uitkyk', 'Sandspruit Outlet']
	];
	for (const r of RIVERS) features.push(line(r[0], r.map((n) => centre.get(n)!)));

	it('flags only the units against the boundary: 184.0 km², 12 % less than 210.2 km²', () => {
		const checks = mapChecks(features, nodes);
		expect(checks).toHaveLength(1);
		expect(checks[0]).toEqual({
			id: 'units-vs-boundary',
			text: "The units add up to 184.0 km², 12 % less than the boundary's 210.2 km².",
			featureIds: [features[0].id],
			nodeIds: nodes.map((n) => n.id)
		});
	});

	it('finds nothing once the boundary is drawn to the units (abutting parcels with rounded shared edges never overlap)', () => {
		const tight = features.map((f) => (f.kind === 'catchment_boundary' ? { ...f, areaM2: 190e6 } : f));
		expect(mapChecks(tight, nodes)).toEqual([]);
	});
});

describe('units with no farm parcel', () => {
	const a = unit('a', 'Alpha', 4);
	const b = unit('b', 'Bravo', 4);
	it('names each farm unit no parcel is linked to, and skips gauges and the other node kinds', () => {
		const features = [parcel(a, 'Alpha', 0, 0, 2, 2), parcel(null, 'Loose', 3, 0, 2, 2), point('dam', 'Bravo dam', [5, -5], { nodeId: 'b' })];
		const nodes = [a, b, unit('g', 'Weir', 0, { kind: 'gauge' }), unit('u', 'Town', 0, { kind: 'user' })];
		expect(mapChecks(features, nodes)).toEqual([{ id: 'unit-no-parcel:b', text: 'Bravo has no farm parcel linked.', featureIds: [], nodeIds: ['b'] }]);
	});
	it('is quiet when every unit has a parcel', () => {
		expect(mapChecks([parcel(a, 'Alpha', 0, 0, 2, 2), parcel(b, 'Bravo', 2, 0, 2, 2)], [a, b])).toEqual([]);
	});
});

describe('features outside the boundary', () => {
	const fence = boundary(0, 0, 10, 10);
	it('flags a parcel with some vertices out, a point out and a line wholly out, by how many points', () => {
		const half = parcel(null, 'Half out', 8, -2, 4, 2);
		const dam = point('dam', 'Far dam', [12, -5]);
		const river = line('Stray', [
			[11, -1],
			[14, -3]
		]);
		const checks = mapChecks([fence, half, dam, river], []);
		expect(checks.map((c) => [c.id, c.text, c.featureIds])).toEqual([
			[`outside:${half.id}`, 'Half out (farm parcel) has 2 of its 4 points outside the catchment boundary.', [half.id]],
			[`outside:${dam.id}`, 'Far dam (dam) is outside the catchment boundary.', [dam.id]],
			[`outside:${river.id}`, 'Stray (river) lies wholly outside the catchment boundary.', [river.id]]
		]);
	});
	it('counts a vertex on the boundary line as inside, and checks nothing without a boundary', () => {
		const onEdge = parcel(null, 'Edge', 0, 0, 3, 3);
		const out = point('gauge', 'Far weir', [12, -5]);
		expect(mapChecks([fence, onEdge, point('dam', 'Dam', [5, -5])], [])).toEqual([]);
		expect(mapChecks([onEdge, out], [])).toEqual([]);
	});
	it('treats a hole in the boundary as outside', () => {
		const holed = feature('catchment_boundary', 'Holed', {
			type: 'Polygon',
			coordinates: [(rect(0, 0, 10, 10) as { coordinates: MapPosition[][] }).coordinates[0], (rect(4, -4, 2, 2) as { coordinates: MapPosition[][] }).coordinates[0]]
		});
		expect(kinds(mapChecks([holed, point('gauge', 'In the hole', [5, -5])], []))).toEqual(['outside']);
	});
});

describe('overlapping farm parcels', () => {
	const ids = (checks: ReturnType<typeof mapChecks>) => checks.filter((c) => c.id.startsWith('overlap:')).map((c) => c.featureIds);

	it('flags a corner reaching into a neighbour', () => {
		const a = parcel(null, 'A', 0, 0, 2, 2);
		const b = parcel(null, 'B', 1.5, -1.5, 2, 2);
		const checks = mapChecks([a, b], []);
		expect(checks).toEqual([{ id: `overlap:${a.id}:${b.id}`, text: 'Farm parcels A and B overlap.', featureIds: [a.id, b.id], nodeIds: [] }]);
	});
	it('flags a crossing with no vertex inside the other (a plus sign)', () => {
		const a = parcel(null, 'Wide', 0, -1, 6, 1);
		const b = parcel(null, 'Tall', 2.5, 0, 1, 3);
		expect(ids(mapChecks([a, b], []))).toEqual([[a.id, b.id]]);
	});
	it('flags one parcel wholly inside another, and the same parcel imported twice', () => {
		const big = parcel(null, 'Big', 0, 0, 5, 5);
		const small = parcel(null, 'Small', 1, -1, 1, 1);
		expect(ids(mapChecks([big, small], []))).toEqual([[big.id, small.id]]);
		const twin = parcel(null, 'Twin', 0, 0, 5, 5);
		expect(ids(mapChecks([big, twin], []))).toEqual([[big.id, twin.id]]);
	});
	it('names the units of the overlapping parcels', () => {
		const a = unit('a', 'Alpha', 4);
		const b = unit('b', 'Bravo', 4);
		const checks = mapChecks([parcel(a, 'Alpha', 0, 0, 2, 2), parcel(b, 'Bravo', 1, 0, 2, 2)], [a, b]);
		expect(checks.find((c) => c.id.startsWith('overlap:'))?.nodeIds).toEqual(['a', 'b']);
	});
	it('ignores shared edges, touching corners, slivers within the tolerance, far parcels and other kinds', () => {
		const a = parcel(null, 'A', 0, 0, 2, 2);
		const side = parcel(null, 'Side', 2, 0, 2, 2);
		const corner = parcel(null, 'Corner', 2, -2, 2, 2);
		// Reaches 2 m into A, under the 5 m tolerance.
		const sliver = parcel(null, 'Sliver', -2 + 0.002, -2, 2, 2);
		const far = parcel(null, 'Far', 20, -20, 2, 2);
		const dam = feature('dam', 'Dam', rect(0.5, -0.5, 0.5, 0.5));
		expect(OVERLAP_TOLERANCE_M).toBeGreaterThan(2);
		expect(ids(mapChecks([a, side, corner, sliver, far, dam], []))).toEqual([]);
	});
	it('reads a multipolygon parcel part by part', () => {
		const multi = feature('farm_parcel', 'Two parts', {
			type: 'MultiPolygon',
			coordinates: [(rect(0, 0, 1, 1) as { coordinates: MapPosition[][] }).coordinates, (rect(5, 0, 1, 1) as { coordinates: MapPosition[][] }).coordinates]
		});
		const gap = parcel(null, 'In the gap', 2, 0, 2, 1);
		const onPart = parcel(null, 'On part two', 5.5, 0, 1, 1);
		expect(ids(mapChecks([multi, gap, onPart], []))).toEqual([[multi.id, onPart.id]]);
	});
});

describe("the units' total area against the boundary's", () => {
	const units = [unit('a', 'Alpha', 120), unit('b', 'Bravo', 100)];
	const parcels = [parcel(units[0], 'Alpha', 0, 0, 12, 10), parcel(units[1], 'Bravo', 12, 0, 10, 10)];
	it('flags units more than 10 % larger, saying both numbers', () => {
		const fence = boundary(-1, 1, 25, 7.8);
		const check = mapChecks([fence, ...parcels], units).find((c) => c.id === 'units-vs-boundary');
		expect(check?.text).toBe("The units add up to 220.0 km², 13 % more than the boundary's 195.0 km².");
		expect(check?.featureIds).toEqual([fence.id]);
		expect(check?.nodeIds).toEqual(['a', 'b']);
		// Exactly 10 % off is still within.
		expect(mapChecks([{ ...fence, areaM2: 200e6 }, ...parcels], units).find((c) => c.id === 'units-vs-boundary')).toBeUndefined();
	});
	it('stays quiet within 10 %, without a boundary and without units', () => {
		const within = { ...boundary(-1, 1, 24, 12), areaM2: 230e6 };
		expect(mapChecks([within, ...parcels], units).find((c) => c.id === 'units-vs-boundary')).toBeUndefined();
		expect(mapChecks(parcels, units).find((c) => c.id === 'units-vs-boundary')).toBeUndefined();
		expect(mapChecks([within], []).find((c) => c.id === 'units-vs-boundary')).toBeUndefined();
	});
});

describe("a unit's typed area against its parcel's", () => {
	it("flags a typed area more than 10 % off its parcel's, and sums a unit's parcels", () => {
		const a = unit('a', 'Alpha', 5);
		const b = unit('b', 'Bravo', 3);
		const features = [parcel(a, 'Alpha', 0, 0, 2, 2), parcel(b, 'Bravo 1', 2, 0, 2, 1), parcel(b, 'Bravo 2', 2, -1, 2, 1)];
		const checks = mapChecks(features, [a, b]);
		expect(checks.map((c) => [c.id, c.text, c.featureIds])).toEqual([
			['typed-area:a', "Alpha's typed area, 5.0 km², is 25 % more than its farm parcel's 4.0 km².", [features[0].id]],
			['typed-area:b', "Bravo's typed area, 3.0 km², is 25 % less than its 2 farm parcels' 4.0 km².", [features[1].id, features[2].id]]
		]);
	});
	it('stays quiet within 10 % and when the area came from the map', () => {
		const a = unit('a', 'Alpha', 4.3);
		const b = unit('b', 'Bravo', 9, { areaSource: 'map' });
		expect(mapChecks([parcel(a, 'Alpha', 0, 0, 2, 2), parcel(b, 'Bravo', 2, 0, 2, 2)], [a, b])).toEqual([]);
	});
});

describe('gauges not on a river line', () => {
	const river = line('Stream', [
		[0, 0],
		[10, 0],
		[10, -10]
	]);
	it('flags a gauge further than 100 m from every river, with its distance', () => {
		const near = point('gauge', 'Near', [5, -0.08]);
		const off = point('gauge', 'Off', [5, -0.3]);
		const far = point('gauge', 'Far', [5, -2.5]);
		const checks = mapChecks([river, near, off, far], []);
		const offM = Math.round(haversineM(off.geometry.coordinates as MapPosition, place([5, 0])));
		expect(offM).toBeGreaterThan(295);
		expect(offM).toBeLessThan(305);
		expect(checks.map((c) => [c.id, c.text])).toEqual([
			[`gauge-off-river:${off.id}`, `Gauge Off is ${offM} m from the nearest river line.`],
			[`gauge-off-river:${far.id}`, 'Gauge Far is 2.5 km from the nearest river line.']
		]);
	});
	it('measures to the nearest segment, not the nearest vertex', () => {
		expect(mapChecks([river, point('gauge', 'Bend', [10.05, -5])], [])).toEqual([]);
	});
	it('checks nothing without rivers, and ignores other points', () => {
		expect(mapChecks([point('gauge', 'Alone', [5, -5])], [])).toEqual([]);
		expect(mapChecks([river, point('dam', 'Dam', [5, -5])], [])).toEqual([]);
	});
	it('uses great-circle distances: 0.001° of latitude is about 111 m', () => {
		expect(haversineM([21, -33], [21, -33.001])).toBeCloseTo(111.2, 0);
		expect(GAUGE_RIVER_DISTANCE_M).toBe(100);
	});
});
