// GeoJSON checks (geo/geojson.ts): what the map refuses, and why, before
// anything is stored.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { circle, sawtooth } from '../__tests__/shapes.js';
import {
	centerOf,
	checkGeometry,
	GEO_MAX_BYTES,
	GEO_MAX_FEATURES,
	GEO_MAX_VERTICES,
	holesNested,
	interiorPoint,
	intersectionArea,
	kindFromWord,
	parseGeoJson,
	pointInGeometry,
	OVERLAP_SHARE,
	polygonsOverlap,
	proposeKinds,
	checkRings,
	freePoint,
	ringSelfIntersects,
	touchesOn,
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

	it('makes a name one line (the Map draws it as a label; issue #385), trimmed to 100 characters, and falls to the next key when nothing is left', () => {
		const pt = { type: 'Point', coordinates: [21, -33] };
		const names = (props: Record<string, unknown>) => parseGeoJson(fc(feature(pt, props))).features[0]!.name;
		expect(names({ name: 'Lower\r\nweir\tB' })).toBe('Lower weir B');
		expect(names({ name: 'Weir\u2028\u0085A' })).toBe('Weir A');
		expect(names({ name: '\n\u0007', label: 'From the label' })).toBe('From the label');
		expect(names({ name: `${'x'.repeat(99)}\n${'y'.repeat(10)}` })).toBe('x'.repeat(99));
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

describe('interiorPoint (the frontend pieces.ts copy’s parity cases)', () => {
	const sq = (x: number, y: number, s: number): Position[] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];
	it('lands inside a U and beside a hole, where the centroid would not', () => {
		const u: Position[] = [[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3], [0, 0]];
		const uPoly: Geometry = { type: 'Polygon', coordinates: [u] };
		expect(pointInGeometry(centerOf(uPoly), uPoly)).toBe(false);
		expect(pointInGeometry(interiorPoint({ type: 'Polygon', coordinates: [u] })!, uPoly)).toBe(true);
		const holed: Geometry = { type: 'Polygon', coordinates: [sq(0, 0, 3), sq(1, 1, 1)] };
		expect(pointInGeometry(interiorPoint({ type: 'Polygon', coordinates: [sq(0, 0, 3), sq(1, 1, 1)] })!, holed)).toBe(true);
	});
	it('takes the largest part of a multipolygon, and is null for a degenerate ring', () => {
		expect(interiorPoint({ type: 'MultiPolygon', coordinates: [[sq(0, 0, 1)], [sq(10, 10, 4)]] })![0]).toBeGreaterThan(10);
		expect(interiorPoint({ type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0]]] })).toBeNull();
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

	it('names a feature from a `layer` that names no kind when it has no name (QGIS "Merge vector layers"), with no note', () => {
		// QGIS writes each source layer's name in `layer`: a file of sub-catchments
		// carries their names there and nothing in `name`.
		const fs = parsed(
			feature(poly(box(0, 0, 1, 1)), { layer: ' Upper unit ', Area: 12.5 }),
			feature(poly(box(2, 2, 3, 3)), { LAYER: 'Lower unit' }),
			feature(poly(box(4, 4, 5, 5)), { layer: 'Dams' }),
			feature(poly(box(6, 6, 7, 7)), { name: 'Upper', layer: 'Subcatchments' }),
			feature(poly(box(8, 8, 9, 9)), { layer: 'Middle unit', type: 'parcel' })
		);
		expect(fs.map((f) => f.name)).toEqual(['Upper unit', 'Lower unit', '', 'Upper', 'Middle unit']);
		expect(fs.map((f) => f.kindHint)).toEqual([null, null, 'Dams', 'Subcatchments', 'parcel']);
		expect(proposeKinds(fs, { hasBoundary: true })).toEqual([
			{ kind: 'farm_parcel', from: 'geometry' },
			{ kind: 'farm_parcel', from: 'geometry' },
			{ kind: 'dam', from: 'property' },
			{ kind: 'farm_parcel', from: 'geometry', note: 'the file says “Subcatchments”, which isn’t a kind the map knows' },
			{ kind: 'farm_parcel', from: 'property' }
		]);
		expect(fs[0]!.properties).toEqual({});
	});

	it('falls back to the shape, with a note, when the property names no kind or one that can’t be that shape', () => {
		const fs = parsed(feature(line, { kind: 'Gauge' }), feature(point(1, 1), { type: 'road' }));
		expect(proposeKinds(fs, { hasBoundary: true })).toEqual([
			{ kind: 'river', from: 'geometry', note: 'the file says “Gauge”, which can’t be a LineString' },
			{ kind: 'gauge', from: 'geometry', note: 'the file says “road”, which isn’t a kind the map knows' }
		]);
	});
});

describe('the self-intersection sweep is bounded (round-4 hardening)', () => {
	// The sweep's work is bounded by a count (GEO_MAX_PAIR_CHECKS), so a refusal
	// as too complex is the proof the bound held. How long it takes is a
	// wall-clock claim: geojson.perf.test.ts (the perf project).
	it('refuses a 50 000-vertex sawtooth (every edge overlapping in longitude) as too complex; it used to take ~9 s', () => {
		expect(checkGeometry({ type: 'Polygon', coordinates: [sawtooth(GEO_MAX_VERTICES - 10)] })).toEqual({ problem: expect.stringMatching(/too complex/) });
	});

	it('still takes a 50 000-vertex circle, and a short sawtooth', () => {
		expect(checkGeometry({ type: 'Polygon', coordinates: [circle(GEO_MAX_VERTICES - 1)] })).toHaveProperty('geometry');
		expect(checkGeometry({ type: 'Polygon', coordinates: [sawtooth(200)] })).toHaveProperty('geometry');
	});

	it('refuses a hole that crosses its outer ring or another hole, and takes holes that stay apart', () => {
		const outer = box(0, 0, 4, 4);
		expect(checkGeometry({ type: 'Polygon', coordinates: [outer, box(1, 1, 5, 2)] })).toEqual({ problem: expect.stringMatching(/cross each other/) });
		expect(checkGeometry({ type: 'Polygon', coordinates: [outer, box(1, 1, 2, 2), box(1.5, 1.5, 3, 3)] })).toEqual({ problem: expect.stringMatching(/cross/) });
		expect(checkGeometry({ type: 'Polygon', coordinates: [outer, box(1, 1, 2, 2), box(2.5, 2.5, 3, 3)] })).toHaveProperty('geometry');
		expect(checkRings([box(0, 0, 1, 1), box(2, 2, 3, 3)])).toEqual({ problem: null, touches: [], disconnected: false });
	});
});

describe('overlapping parts and nested holes', () => {
	const mp = (...polygons: Position[][][]) => ({ type: 'MultiPolygon', coordinates: polygons });

	it('refuses MultiPolygon parts that overlap, or the same part twice, which counted the overlap twice in the area', () => {
		expect(checkGeometry(mp([box(20, -30, 20.1, -29.9)], [box(20.05, -30, 20.15, -29.9)]))).toEqual({ problem: expect.stringMatching(/parts that overlap/) });
		expect(checkGeometry(mp([box(20, -30, 20.1, -29.9)], [box(20, -30, 20.1, -29.9)]))).toEqual({ problem: expect.stringMatching(/parts that overlap/) });
		// One part wholly inside the other, and two crossing like a plus sign (no vertex of either inside the other).
		expect(checkGeometry(mp([box(0, 0, 4, 4)], [box(1, 1, 2, 2)]))).toEqual({ problem: expect.stringMatching(/overlap/) });
		expect(checkGeometry(mp([box(0, 1, 3, 2)], [box(1, 0, 2, 3)]))).toEqual({ problem: expect.stringMatching(/overlap/) });
	});

	it('takes parts that share an edge or a corner, sit apart, or sit in another part’s hole, with the area of each once', () => {
		const shared = checkGeometry(mp([box(0, 0, 1, 1)], [box(1, 0, 2, 1)], [box(2, 1, 3, 2)]));
		expect(shared).toHaveProperty('geometry');
		const one = checkGeometry(poly(box(0, 0, 1, 1)));
		expect((shared as { areaM2: number }).areaM2).toBeCloseTo(2 * (one as { areaM2: number }).areaM2 + (checkGeometry(poly(box(2, 1, 3, 2))) as { areaM2: number }).areaM2, 0);
		// Shared edges in opposite directions, the second part's edge split at a vertex of its own.
		expect(checkGeometry(mp([box(0, 0, 1, 1)], [[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0.5], [1, 0]]]))).toHaveProperty('geometry');
		expect(checkGeometry(mp([box(0, 0, 4, 4), box(1, 1, 3, 3)], [box(1.5, 1.5, 2.5, 2.5)]))).toHaveProperty('geometry');
		expect(checkGeometry(mp([box(0, 0, 1, 1)], [box(5, 5, 6, 6)]))).toHaveProperty('geometry');
	});

	it('takes neighbours digitised to overlap by a sliver along their shared edge (as the DWS quaternaries do), up to OVERLAP_SHARE of the area', () => {
		// 0.1° boxes, the second reaching 0.00001° (about 1 m, 0.005 % of their area) into the first: passes; 0.001° (0.5 %): refused.
		expect(checkGeometry(mp([box(20, -30, 20.1, -29.9)], [box(20.09999, -30, 20.2, -29.9)]))).toHaveProperty('geometry');
		expect(checkGeometry(mp([box(20, -30, 20.1, -29.9)], [box(20.099, -30, 20.2, -29.9)]))).toEqual({ problem: expect.stringMatching(/parts that overlap/) });
		expect(OVERLAP_SHARE).toBe(0.001);
	});

	it('refuses a hole inside another hole (its area was taken away twice), and takes holes side by side', () => {
		const outer = box(20, -30, 20.1, -29.9);
		expect(checkGeometry(poly(outer, box(20.01, -29.99, 20.09, -29.91), box(20.02, -29.98, 20.08, -29.92)))).toEqual({ problem: expect.stringMatching(/hole inside another hole/) });
		expect(checkGeometry(poly(outer, box(20.01, -29.99, 20.04, -29.91), box(20.06, -29.99, 20.09, -29.91)))).toHaveProperty('geometry');
	});

	it('takes two 24 000-vertex neighbours along a winding shared edge (two quaternaries, say)', () => {
		const m = 24_000;
		// Running diagonally, so the self-intersection sweep (by longitude) sees a few edges at a time too.
		const edge: Position[] = Array.from({ length: m }, (_, k) => [Math.round((k / m + 0.001 * Math.sin(k / 7)) * 1e7) / 1e7, Math.round((k / m) * 1e7) / 1e7]);
		const top = edge[m - 1]!;
		const east: Position[] = [...edge, [2, top[1]], [2, 0], edge[0]!];
		const west: Position[] = [...[...edge].reverse(), [-1, 0], [-1, top[1]], top];
		expect(polygonsOverlap([[east], [west]])).toBe(false);
		expect(checkGeometry(mp([east], [west]))).toHaveProperty('geometry');
	});

	it('refuses a comb whose every edge spans every slab as too complex, rather than spending quadratic time on it', () => {
		// A zigzag of long teeth at distinct heights, inside the hole of a second part: each slab holds every tooth.
		const n = 20_000;
		const comb: Position[] = Array.from({ length: n }, (_, i) => [i / n, i % 2 ? 1 - i * 1e-7 : i * 1e-7]);
		comb.push([1, -1], [0, -1], comb[0]!);
		const frame = [box(-2, -3, 3, 4), box(-1, -2, 2, 3)];
		expect(checkGeometry(mp([comb], frame))).toEqual({ problem: expect.stringMatching(/too complex to check for overlaps/) });
	});
});

describe('nested holes, checked without comparing every pair (round-4 hardening)', () => {
	const outer = box(19.9, -30.1, 20.2, -29.8);
	/** A C: an annulus round (x0, y0) between radii r and R, open over the east (`n` vertices on each arc). */
	const cShape = (x0: number, y0: number, r: number, R: number, n: number): Position[] => {
		const at = (rad: number, k: number): Position => {
			const a = ((10 + (340 * k) / (n - 1)) * Math.PI) / 180;
			return [Math.round((x0 + rad * Math.cos(a)) * 1e7) / 1e7, Math.round((y0 + rad * Math.sin(a)) * 1e7) / 1e7];
		};
		const ring = [...Array.from({ length: n }, (_, k) => at(R, k)), ...Array.from({ length: n }, (_, k) => at(r, n - 1 - k))];
		return [...ring, ring[0]!];
	};
	/** A k × k grid of small square holes filling the square of side `side` centred on (x0, y0). */
	const grid = (x0: number, y0: number, side: number, k: number): Position[][] => {
		const step = side / k;
		const out: Position[][] = [];
		for (let i = 0; i < k; i++) {
			for (let j = 0; j < k; j++) {
				const [w, s] = [x0 - side / 2 + i * step, y0 - side / 2 + j * step];
				out.push(box(w + 0.2 * step, s + 0.2 * step, w + 0.8 * step, s + 0.8 * step));
			}
		}
		return out;
	};

	it('finds a hole inside a hole inside a hole, and one that shares its west edge with the hole around it', () => {
		expect(holesNested([box(0, 0, 10, 10), box(1, 1, 9, 9), box(2, 2, 8, 8)])).toBe(true);
		expect(holesNested([box(2, 2, 3, 3), box(0, 0, 10, 10)])).toBe(true);
		expect(holesNested([box(0, 0, 4, 1), box(0, 0.25, 4, 0.75)].reverse())).toBe(true);
		expect(holesNested([box(0, 0, 1, 1), box(2, 0, 3, 1), box(0, 2, 3, 3)])).toBe(false);
	});

	it('takes small holes inside a big C-shaped hole’s box but outside the C (positive control: one in the C’s body is refused)', () => {
		const c = cShape(20.05, -29.95, 0.02, 0.04, 10_000);
		const small = grid(20.05, -29.95, 0.026, 60);
		expect(small.length).toBe(3_600);
		expect(checkGeometry(poly(outer, c, ...small))).toHaveProperty('geometry');
		// The same, with one more small hole in the C's body (west of its centre, between the radii).
		const inBody = box(20.05 - 0.0305, -29.9505, 20.05 - 0.0295, -29.9495);
		expect(checkGeometry(poly(outer, c, ...small, inBody))).toEqual({ problem: expect.stringMatching(/hole inside another hole/) });
	});

	it('takes a polygon with 4 900 holes side by side, which comparing every pair refused as too complex', () => {
		const holes = grid(20.05, -29.95, 0.1, 70);
		expect(problemOf(poly(outer, ...holes))).toBeNull();
		// Positive control: the same holes with one inside another is refused.
		const last = holes[holes.length - 1]!;
		const [w, s] = last[0]!;
		const [e, n] = last[2]!;
		const inner = box(w + (e - w) / 4, s + (n - s) / 4, e - (e - w) / 4, n - (n - s) / 4);
		expect(problemOf(poly(outer, ...holes, inner))).toMatch(/hole inside another hole/);
	});
});

describe('rings that touch at a point, as OGC and GEOS allow (Waterbodies v0.0.3: 218 of 15 442 refused)', () => {
	const outer = box(0, 0, 4, 4);
	const ok = (...rings: Position[][]) => expect(problemOf(poly(...rings))).toBeNull();
	const refused = (re: RegExp, ...rings: Position[][]) => expect(problemOf(poly(...rings))).toMatch(re);

	it('takes a hole touching its outer ring at a vertex, starting there, with the hole’s area taken away once', () => {
		// The hole's first vertex lies on the outer ring's west edge: pointInRing's answer there is arbitrary, so another vertex is tested.
		const hole: Position[] = [[0, 2], [1, 3], [1, 1], [0, 2]];
		ok(outer, hole);
		const whole = checkGeometry(poly(outer)) as { areaM2: number };
		expect((checkGeometry(poly(outer, hole)) as { areaM2: number }).areaM2 / whole.areaM2).toBeCloseTo(15 / 16, 3);
		// At a vertex of the outer ring too: a notch's inner corner (4, 3), the hole diagonally below it, as a raster outline has it.
		const notched: Position[] = [[0, 0], [5, 0], [5, 4], [4, 4], [4, 3], [3, 3], [3, 4], [0, 4], [0, 0]];
		ok(notched, [[4, 3], [4, 2], [5 - 0.5, 2], [5 - 0.5, 3], [4, 3]]);
	});

	it('takes two holes touching at a vertex, and three rings meeting at one point (no loop)', () => {
		ok(outer, box(1, 1, 2, 2), box(2, 2, 3, 3));
		// Two holes touching each other and the outer ring at (0, 2): one point, so the interior stays one piece.
		ok(outer, [[0, 2], [1, 3], [1, 2.5], [0, 2]], [[0, 2], [1, 1.5], [1, 1], [0, 2]]);
	});

	it('refuses rings that run along each other, at the outer ring or between holes', () => {
		refused(/run along each other/, outer, box(0, 1, 1, 2));
		refused(/run along each other/, outer, box(1, 1, 2, 2), box(2, 1, 3, 2));
		// Along part of an edge only.
		refused(/run along each other/, outer, box(1, 1, 2, 2), box(2, 1.5, 3, 3));
	});

	it('refuses rings that cross, through edges or only at vertices', () => {
		refused(/cross each other/, outer, box(1, 1, 5, 2));
		// Hole B passes into hole A at A's bottom edge (1, 1) and out at its top (1, 3), both at a vertex of B.
		const a = box(0.5, 1, 2, 3);
		const b: Position[] = [[1, 1], [1.5, 0.5], [3.5, 0.5], [3.5, 3.5], [1, 3.5], [1, 3], [0.75, 2], [1, 1]];
		refused(/cross each other/, outer, a, b);
		expect(checkRings([outer, a, b]).problem).toBe('cross');
		// A hole's vertex inside the outer ring's edge, passing through it there (and back in through the edge's inside), either way round.
		const through: Position[] = [[0, 2], [-1, 3], [1, 3], [0, 2]];
		refused(/cross each other/, outer, through);
		refused(/cross each other/, outer, [...through].reverse());
	});

	it('takes hundreds of holes meeting at one point (a star, no loop), checking the point once rather than every pair', () => {
		// Thin triangles fanned round (2, 2), the outer ring's middle: valid for GEOS. Pairwise checks at the point cost ~1 s at 1 200.
		const n = 600;
		const fan = Array.from({ length: n }, (_, k): Position[] => {
			const ray = (t: number): Position => {
				const a = (2 * Math.PI * t) / n;
				return [Math.round((2 + 1.5 * Math.cos(a)) * 1e7) / 1e7, Math.round((2 + 1.5 * Math.sin(a)) * 1e7) / 1e7];
			};
			return [[2, 2], ray(k + 0.1), ray(k + 0.6), [2, 2]];
		});
		expect(problemOf(poly(outer, ...fan))).toBeNull();
		// Positive control: one more triangle overlapping a neighbour's wedge at the point crosses it.
		const extra: Position[] = [[2, 2], [2 + 1.4, 2 + 0.002], [2 + 1.4, 2 + 0.01], [2, 2]];
		expect(problemOf(poly(outer, ...fan, extra))).toMatch(/cross each other/);
	});

	it('refuses a ring touching or doubling back on itself, as GEOS does (“Ring Self-intersection”)', () => {
		// Comes back to (1, 0) halfway round: a self-touch, which GEOS refuses (its self-touching-ring option is off by default).
		refused(/crosses itself/, [[0, 0], [1, 0], [2, 0], [2, 1], [1, 0], [1, 1], [0, 1], [0, 0]]);
		// The same as a hole: the message names the ring.
		refused(/ring that crosses or touches itself/, box(-1, -1, 3, 3), [[0, 0], [1, 0], [2, 0], [2, 1], [1, 0], [1, 1], [0, 1], [0, 0]]);
		// A spike: an edge returning along the one before (its end lies on that edge).
		refused(/crosses itself/, [[0, 0], [2, 0], [2, 2], [2, 3], [2, 2.5], [0, 2], [0, 0]]);
	});

	it('refuses holes that cut the interior into pieces: a hole touching the outer ring twice, or holes touching in a loop', () => {
		refused(/cut it into pieces/, outer, [[0, 2], [2, 1], [4, 2], [2, 3], [0, 2]]);
		refused(/cut it into pieces/, outer, [[2, 0], [4, 2], [2, 4], [0, 2], [2, 0]]);
		// Three holes touching pairwise at three different points: the triangle between them is cut off.
		refused(/cut it into pieces/, outer, [[1, 1], [2, 1], [1.5, 0.5], [1, 1]], [[2, 1], [1.5, 2], [2.5, 2], [2, 1]], [[1.5, 2], [1, 1], [0.5, 2], [1.5, 2]]);
		expect(checkRings([outer, [[0, 2], [2, 1], [4, 2], [2, 3], [0, 2]]])).toMatchObject({ problem: null, disconnected: true });
	});

	it('says a hole outside touching the ring is outside, and a hole inside another touching it there is nested', () => {
		refused(/hole outside/, outer, [[4, 4], [5, 4.5], [5, 5], [4.5, 5], [4, 4]]);
		// Touching twice from outside: GEOS says outside before disconnected, and so does this.
		refused(/hole outside/, outer, [[4, 1], [5, 2], [4, 3], [4.5, 2], [4, 1]]);
		// The inner hole starts at the outer hole's corner it touches.
		refused(/hole inside another hole/, outer, box(1, 1, 3, 3), [[1, 1], [2, 1.5], [2, 2], [1.5, 2], [1, 1]]);
	});

	it('takes a pixel-traced waterbody whose holes touch its outline and each other at pixel corners, and refuses the loop that cuts a pixel off', () => {
		// 30 m pixels near the Western Cape: islands of land in a dam, traced along pixel edges (as DE Africa's Waterbodies are).
		const px = 0.0003;
		const at = (i: number, j: number): Position => [Math.round((19.5 + i * px) * 1e7) / 1e7, Math.round((-33.9 + j * px) * 1e7) / 1e7];
		const pixel = (i: number, j: number, from: 0 | 1 | 2 | 3 = 0): Position[] => {
			const corners = [at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j)];
			const r = [...corners.slice(from), ...corners.slice(0, from)];
			return [...r, r[0]!];
		};
		// An 8 × 8 outline with a notch of land at the top (pixel 3, 7) and at the bottom (pixel 6, 0).
		const shell = [[0, 0], [6, 0], [6, 1], [7, 1], [7, 0], [8, 0], [8, 8], [4, 8], [4, 7], [3, 7], [3, 8], [0, 8], [0, 0]].map(([i, j]) => at(i!, j!));
		const islands = [
			pixel(4, 6, 1), // its corner (4, 7) is the top notch's: the ring starts there
			pixel(5, 5), // touches the first at (5, 6)
			pixel(1, 1), // alone
			pixel(5, 1), // touches the bottom notch at (6, 1)
			pixel(2, 6) // touches the top notch at (3, 7)
		];
		const r = checkGeometry(poly(shell, ...islands));
		expect(r).toHaveProperty('geometry');
		expect((r as { areaM2: number }).areaM2 / (checkGeometry(poly(shell)) as { areaM2: number }).areaM2).toBeCloseTo((64 - 2 - 5) / (64 - 2), 3);
		const verdict = checkRings([shell, ...islands]);
		expect(verdict.problem === null && verdict.touches.length).toBe(4);
		// Positive control: one more island at (3, 5)-(4, 6) touches the islands either side, closing a loop round the land pixel (3, 6).
		expect(problemOf(poly(shell, ...islands, pixel(3, 5)))).toMatch(/cut it into pieces/);
	});

	it('finds a point of a ring off the ring it touches', () => {
		const hole: Position[] = [[0, 2], [1, 3], [1, 1], [0, 2]];
		const v = checkRings([outer, hole]);
		if (v.problem !== null) throw new Error('refused');
		const on = touchesOn(v.touches);
		expect([...on(1)]).toEqual(['0,2']);
		expect([...on(0)]).toEqual(['0,2']);
		expect(freePoint(hole, on(1), on(0))).toEqual([1, 3]);
		expect(freePoint(outer, new Set(), on(1))).toEqual([0, 0]);
		// A vertex where the ring touches a third ring, not this one, still serves.
		expect(freePoint(hole, on(1), new Set())).toEqual([0, 2]);
	});
});

describe('the Map upload’s example file (issue #456)', () => {
	// The file the upload sheet's "Expected format" offers (frontend/src/lib/components/map/example-features.geojson):
	// it must pass these same checks, with the kind each feature names.
	const text = readFileSync(new URL('../../../frontend/src/lib/components/map/example-features.geojson', import.meta.url), 'utf8');

	it('passes every check and proposes the kind its `kind` property names', () => {
		const r = parseGeoJson(text);
		expect(r.problems).toEqual([]);
		expect(r.features.map((f) => f.name)).toEqual(['Example catchment', 'Example farm', 'Example river', 'Example weir']);
		expect(proposeKinds(r.features, { hasBoundary: false })).toEqual([
			{ kind: 'catchment_boundary', from: 'property' },
			{ kind: 'farm_parcel', from: 'property' },
			{ kind: 'river', from: 'property' },
			{ kind: 'gauge', from: 'property' }
		]);
	});
});

// The dam to waterbody match's measure (dams/observed/match.ts): the area
// inside both of two regions, each its rings read even-odd.
describe('intersectionArea', () => {
	/** A rectangle w × h degrees from (x, y), closed. */
	const rect = (x: number, y: number, w: number, h = w): [number, number][] => [
		[x, y],
		[x + w, y],
		[x + w, y + h],
		[x, y + h],
		[x, y]
	];

	it('measures the overlap of two squares, either way round', () => {
		expect(intersectionArea([rect(0, 0, 2)], [rect(1, 1, 2)])).toBeCloseTo(1, 9);
		expect(intersectionArea([rect(1, 1, 2)], [rect(0, 0, 2)])).toBeCloseTo(1, 9);
		// One inside the other: the smaller's area.
		expect(intersectionArea([rect(0, 0, 4)], [rect(1, 1, 1)])).toBeCloseTo(1, 9);
	});

	it('leaves out a hole, on either side', () => {
		const holed = [rect(0, 0, 2), rect(0.5, 0.5, 1)];
		expect(intersectionArea(holed, [rect(0, 0, 2)])).toBeCloseTo(3, 9);
		expect(intersectionArea([rect(0, 0, 2)], holed)).toBeCloseTo(3, 9);
		// The right half: 2, less the hole's half (0.5).
		expect(intersectionArea(holed, [rect(1, 0, 1, 2)])).toBeCloseTo(1.5, 9);
		// Wholly inside the hole: nothing.
		expect(intersectionArea(holed, [rect(0.6, 0.6, 0.5)])).toBeCloseTo(0, 9);
	});

	it('leaves out holes that touch the outer ring and each other at a vertex (a Waterbodies outline), once each', () => {
		// A triangle touching the west edge at (0, 0.5) and a square at (0.5, 1); that square touching another at (1, 1).
		const holed = [rect(0, 0, 2), [[0, 0.5], [0.5, 0.5], [0.5, 1], [0, 0.5]] as [number, number][], rect(0.5, 1, 0.5), rect(1, 0.5, 0.5)];
		expect(checkRings(holed)).toMatchObject({ problem: null, disconnected: false });
		expect(intersectionArea(holed, [rect(0, 0, 2)])).toBeCloseTo(4 - 0.125 - 0.25 - 0.25, 9);
		expect(intersectionArea([rect(0, 0, 2)], holed)).toBeCloseTo(4 - 0.125 - 0.25 - 0.25, 9);
	});

	it('adds up every part of a MultiPolygon', () => {
		// Two unit squares 1° apart; a 2 × 1 band over half of each.
		const parts = [rect(0, 0, 1), rect(2, 0, 1)];
		expect(intersectionArea(parts, [rect(0.5, 0, 2, 1)])).toBeCloseTo(1, 9);
		expect(intersectionArea(parts, parts)).toBeCloseTo(2, 9);
		// The band between the parts touches neither.
		expect(intersectionArea(parts, [rect(1.2, 0, 0.6, 1)])).toBeCloseTo(0, 9);
	});

	it('is 0 for disjoint regions, boxes apart or overlapping', () => {
		expect(intersectionArea([rect(0, 0, 1)], [rect(2, 2, 1)])).toBe(0);
		// Two triangles in one box, either side of a gap.
		const lower: [number, number][] = [[0, 0], [1, 0], [0, 1], [0, 0]];
		const upper: [number, number][] = [[1, 1], [0.2, 1], [1, 0.2], [1, 1]];
		expect(intersectionArea([lower], [upper])).toBeCloseTo(0, 9);
	});

	it('is 0 for regions that only share an edge', () => {
		// Side by side: the boxes meet along x = 1.
		expect(intersectionArea([rect(0, 0, 1)], [rect(1, 0, 1)])).toBe(0);
		// One box, split along its diagonal.
		const below: [number, number][] = [[0, 0], [2, 0], [0, 2], [0, 0]];
		const above: [number, number][] = [[2, 0], [2, 2], [0, 2], [2, 0]];
		expect(intersectionArea([below], [above])).toBeCloseTo(0, 9);
		expect(intersectionArea([below], [rect(0, 0, 2)])).toBeCloseTo(2, 9);
	});

	it('counts its work through spend, which may stop it', () => {
		let steps = 0;
		intersectionArea([rect(0, 0, 2)], [rect(1, 1, 2)], (n) => void (steps += n));
		expect(steps).toBeGreaterThan(0);
		expect(() =>
			intersectionArea([rect(0, 0, 2)], [rect(1, 1, 2)], () => {
				throw new Error('too much');
			})
		).toThrow('too much');
	});
});
