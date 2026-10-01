// GeoJSON checks (geo/geojson.ts): what the map refuses, and why, before
// anything is stored.
import { describe, expect, it } from 'vitest';
import {
	centerOf,
	checkGeometry,
	GEO_MAX_BYTES,
	GEO_MAX_FEATURES,
	GEO_MAX_VERTICES,
	kindFromWord,
	parseGeoJson,
	pointInGeometry,
	proposeKinds,
	ringSelfIntersects,
	type Geometry,
	type Position
} from './geojson.js';

const box = (x0: number, y0: number, x1: number, y1: number): Position[] => [
	[x0, y0],
	[x1, y0],
	[x1, y1],
	[x0, y1],
	[x0, y0]
];
const fc = (...features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });
const feature = (geometry: unknown, properties: Record<string, unknown> = {}) => ({ type: 'Feature', properties, geometry });
const poly = (...rings: Position[][]) => ({ type: 'Polygon', coordinates: rings });
const problemOf = (g: unknown) => {
	const r = checkGeometry(g);
	return 'problem' in r ? r.problem : null;
};

describe('parseGeoJson', () => {
	it('reads a FeatureCollection, keeping only the allowlisted properties and the name', () => {
		const text = fc(feature(poly(box(21.1, -33.9, 21.2, -33.8)), { name: 'Upper catchment', description: 'from the survey', owner_id: '8001015009087', ref: 'Q1' }));
		const { features, problems } = parseGeoJson(text);
		expect(problems).toEqual([]);
		expect(features).toHaveLength(1);
		expect(features[0]).toMatchObject({ index: 1, name: 'Upper catchment', properties: { description: 'from the survey', ref: 'Q1' } });
		expect(features[0]!.properties).not.toHaveProperty('owner_id');
		expect(features[0]!.areaM2).toBeGreaterThan(9e7);
	});

	it('takes one Feature or a bare geometry too', () => {
		expect(parseGeoJson(JSON.stringify(feature({ type: 'Point', coordinates: [21, -33] }))).features).toHaveLength(1);
		expect(parseGeoJson(JSON.stringify({ type: 'Point', coordinates: [21, -33] })).features[0]!.geometry.type).toBe('Point');
	});

	it('refuses a file in another coordinate system, naming it, and never guesses', () => {
		const text = JSON.stringify({ type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::22289' } }, features: [] });
		expect(parseGeoJson(text).problems[0]!.message).toMatch(/EPSG::22289.*reproject it to WGS84/);
		const ok = JSON.stringify({ type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } }, features: [feature({ type: 'Point', coordinates: [21, -33] })] });
		expect(parseGeoJson(ok).problems).toEqual([]);
	});

	it('refuses projected coordinates (a Lo zone’s metres) as not longitude/latitude', () => {
		const lo = fc(feature(poly(box(-45_000, 3_700_000, -44_000, 3_701_000))));
		expect(parseGeoJson(lo).problems[0]).toEqual({ feature: 1, message: expect.stringMatching(/looks projected.*reproject it to WGS84/) });
	});

	it('refuses 3D coordinates and unsupported geometry types', () => {
		expect(problemOf({ type: 'Point', coordinates: [21, -33, 120] })).toMatch(/3D coordinates/);
		expect(problemOf({ type: 'GeometryCollection', geometries: [] })).toMatch(/GeometryCollection geometry/);
		expect(problemOf({ type: 'MultiPoint', coordinates: [[21, -33]] })).toMatch(/MultiPoint geometry/);
		expect(problemOf(null)).toMatch(/no geometry/);
	});

	it('refuses an unclosed ring, a ring with too few positions or no area, a ring that crosses itself and a hole outside', () => {
		expect(problemOf(poly(box(21, -34, 22, -33).slice(0, 4)))).toMatch(/not closed/);
		expect(problemOf(poly([[21, -34], [22, -34], [21, -34]]))).toMatch(/at least 4 positions/);
		expect(problemOf(poly([[21, -34], [22, -34], [23, -34], [21, -34]]))).toMatch(/no area/);
		const bowtie: Position[] = [[21, -34], [22, -33], [22, -34], [21, -32], [21, -34]];
		expect(problemOf(poly(bowtie))).toMatch(/crosses itself/);
		expect(problemOf(poly(box(21, -34, 22, -33), box(23, -34, 23.5, -33.5)))).toMatch(/hole outside/);
		expect(problemOf(poly(box(21, -34, 22, -33), box(21.2, -33.8, 21.4, -33.6)))).toBeNull();
	});

	it('takes a position repeated in a row as one vertex', () => {
		const ring: Position[] = [[21, -34], [22, -34], [22, -34], [22, -33], [21, -33], [21, -34]];
		expect(problemOf(poly(ring))).toBeNull();
	});

	it('refuses a feature with more than the vertex limit, a file over the size limit or with too many features', () => {
		const n = GEO_MAX_VERTICES + 1;
		const circle: Position[] = Array.from({ length: n }, (_, i) => [21 + 0.1 * Math.cos((2 * Math.PI * i) / n), -33 + 0.1 * Math.sin((2 * Math.PI * i) / n)]);
		circle.push(circle[0]!);
		expect(problemOf(poly(circle))).toMatch(/more than 50[\s,]000 positions/);
		const big = ' '.repeat(GEO_MAX_BYTES + 1);
		expect(parseGeoJson(big).problems[0]!.message).toMatch(/larger than 5 MB/);
		const many = fc(...Array.from({ length: GEO_MAX_FEATURES + 1 }, () => feature({ type: 'Point', coordinates: [21, -33] })));
		expect(parseGeoJson(many).problems[0]!.message).toMatch(/the most one upload takes is 500/);
	});

	it('refuses a ring too complex to check rather than spending quadratic time on it', () => {
		// A star with 8 000 spikes: a simple ring, but the edges near its centre all
		// overlap, so a pairwise check would be quadratic. Past the budget it is
		// refused as too complex, quickly.
		const n = 8000;
		const zig: Position[] = Array.from({ length: n }, (_, i) => {
			const r = i % 2 ? 0.001 : 0.5;
			return [21 + r * Math.cos((2 * Math.PI * i) / n), -33 + r * Math.sin((2 * Math.PI * i) / n)];
		});
		zig.push(zig[0]!);
		const started = performance.now();
		expect(problemOf(poly(zig))).toMatch(/too complex to check/);
		expect(performance.now() - started).toBeLessThan(10_000);
	});

	it('lists every bad feature of a file with its place, and keeps the good ones', () => {
		const text = fc(feature({ type: 'Point', coordinates: [21, -33] }), feature({ type: 'Point', coordinates: [21, -33, 5] }), { type: 'Nope' });
		const { features, problems } = parseGeoJson(text);
		expect(features.map((f) => f.index)).toEqual([1]);
		expect(problems.map((p) => p.feature)).toEqual([2, 3]);
	});

	it('refuses text that isn’t JSON, and an empty collection', () => {
		expect(parseGeoJson('not json').problems[0]!.message).toMatch(/not valid JSON/);
		expect(parseGeoJson(fc()).problems[0]!.message).toMatch(/no features/);
	});
});

describe('ringSelfIntersects', () => {
	it('passes a convex and a concave ring and catches a touching one', () => {
		expect(ringSelfIntersects(box(0, 0, 1, 1))).toBe(false);
		expect(ringSelfIntersects([[0, 0], [2, 0], [2, 2], [1, 1], [0, 2], [0, 0]])).toBe(false);
		// The ring comes back to (1, 0) halfway round: it touches itself.
		expect(ringSelfIntersects([[0, 0], [1, 0], [2, 0], [2, 1], [1, 0], [1, 1], [0, 1], [0, 0]])).toBe(true);
	});
});

describe('pointInGeometry and centerOf', () => {
	const donut: Geometry = { type: 'Polygon', coordinates: [box(0, 0, 4, 4), box(1, 1, 3, 3)] };
	it('is in the polygon, not in its hole, and in any part of a MultiPolygon', () => {
		expect(pointInGeometry([0.5, 0.5], donut)).toBe(true);
		expect(pointInGeometry([2, 2], donut)).toBe(false);
		expect(pointInGeometry([5, 5], donut)).toBe(false);
		expect(pointInGeometry([10.5, 0.5], { type: 'MultiPolygon', coordinates: [[box(0, 0, 1, 1)], [box(10, 0, 11, 1)]] })).toBe(true);
		expect(pointInGeometry([0, 0], { type: 'Point', coordinates: [0, 0] })).toBe(false);
	});
	it('centres a point on itself, a polygon on its centroid, a MultiPolygon on its largest part', () => {
		expect(centerOf({ type: 'Point', coordinates: [21, -33] })).toEqual([21, -33]);
		expect(centerOf({ type: 'Polygon', coordinates: [box(20, -34, 22, -32)] })).toEqual([21, -33]);
		expect(centerOf({ type: 'MultiPolygon', coordinates: [[box(0, 0, 1, 1)], [box(10, 0, 14, 4)]] })).toEqual([12, 2]);
		expect(centerOf({ type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 2]] })).toEqual([1, 1]);
	});
});

describe('proposing each feature’s kind (issue #326 D2)', () => {
	const parsed = (...features: unknown[]) => {
		const r = parseGeoJson(fc(...features));
		expect(r.problems).toEqual([]);
		return r.features;
	};
	const kinds = (fs: ReturnType<typeof parsed>, hasBoundary = false) => proposeKinds(fs, { hasBoundary }).map((p) => p.kind);
	const point = (x: number, y: number) => ({ type: 'Point', coordinates: [x, y] });
	const line = { type: 'LineString', coordinates: [[1, 1], [5, 5]] };

	it('reads the words a file uses for a kind, case, separators and plurals aside', () => {
		expect(kindFromWord('Boundary')).toBe('catchment_boundary');
		expect(kindFromWord('CATCHMENT')).toBe('catchment_boundary');
		expect(kindFromWord('catchment_boundary')).toBe('catchment_boundary');
		expect(kindFromWord('Farm parcels')).toBe('farm_parcel');
		expect(kindFromWord('farm-parcel')).toBe('farm_parcel');
		expect(kindFromWord('Fields')).toBe('farm_parcel');
		expect(kindFromWord('reservoir')).toBe('dam');
		expect(kindFromWord('Weirs')).toBe('gauge');
		expect(kindFromWord('station')).toBe('gauge');
		expect(kindFromWord('stream')).toBe('river');
		expect(kindFromWord('Other')).toBe('other');
		expect(kindFromWord('road')).toBeNull();
		expect(kindFromWord('')).toBeNull();
	});

	it('takes the kind from a `kind`, `type` or `layer` property (any key case), and does not keep it', () => {
		const fs = parsed(
			feature(poly(box(0, 0, 10, 10)), { Layer: 'Parcels' }),
			feature(point(2, 2), { TYPE: 'Reservoir' }),
			feature(poly(box(1, 1, 2, 2)), { kind: 'boundary' }),
			feature(line, { kind: 'Stream', type: 'ignored' })
		);
		expect(proposeKinds(fs, { hasBoundary: false })).toEqual([
			{ kind: 'farm_parcel', from: 'property' },
			{ kind: 'dam', from: 'property' },
			{ kind: 'catchment_boundary', from: 'property' },
			{ kind: 'river', from: 'property' }
		]);
		expect(fs[0]!.properties).toEqual({});
	});

	it('infers from the shape: a line a river, a point a gauge, a polygon a parcel, the largest polygon round the rest the boundary', () => {
		const fs = parsed(feature(poly(box(1, 1, 2, 2))), feature(line), feature(poly(box(0, 0, 10, 10))), feature(point(3, 3)), feature(poly(box(6, 6, 8, 8))));
		expect(proposeKinds(fs, { hasBoundary: true })).toEqual([
			{ kind: 'farm_parcel', from: 'geometry' },
			{ kind: 'river', from: 'geometry' },
			{ kind: 'catchment_boundary', from: 'geometry' },
			{ kind: 'gauge', from: 'geometry' },
			{ kind: 'farm_parcel', from: 'geometry' }
		]);
	});

	it('proposes no boundary when the largest polygon leaves a feature outside, or a property already names one', () => {
		expect(kinds(parsed(feature(poly(box(0, 0, 10, 10))), feature(poly(box(1, 1, 2, 2))), feature(point(20, 20))))).toEqual(['farm_parcel', 'farm_parcel', 'gauge']);
		expect(kinds(parsed(feature(poly(box(0, 0, 10, 10))), feature(poly(box(1, 1, 2, 2)), { kind: 'catchment' })))).toEqual(['farm_parcel', 'catchment_boundary']);
	});

	it('makes a lone polygon the boundary only while the project has none', () => {
		const lone = parsed(feature(poly(box(0, 0, 10, 10))));
		expect(kinds(lone, false)).toEqual(['catchment_boundary']);
		expect(kinds(lone, true)).toEqual(['farm_parcel']);
	});

	it('falls back to the shape, with a note, when the property names no kind or one that can’t be that shape', () => {
		const fs = parsed(feature(line, { kind: 'Gauge' }), feature(point(1, 1), { type: 'road' }));
		expect(proposeKinds(fs, { hasBoundary: true })).toEqual([
			{ kind: 'river', from: 'geometry', note: 'the file says “Gauge”, which can’t be a LineString' },
			{ kind: 'gauge', from: 'geometry', note: 'the file says “road”, which isn’t a kind the map knows' }
		]);
	});
});
