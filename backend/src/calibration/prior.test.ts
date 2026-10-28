// The regional prior route's pure parts (issue #622 step 5): a boundary's
// centroid, the target's attributes (area, MAP and aridity known, the rest
// unknown until a target's HydroATLAS attributes load), and the ranges a fit
// or start uses (x1 from the soil relation only when it has skill and the
// target has a PAWC).
import { regionalPrior, type Gr4jDonor } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { centroidOf, priorRanges, PriorQuery, PriorStart, targetAttributes } from './prior.js';

const ring = (w: number, s: number, e: number, n: number) => [
	[w, s],
	[e, s],
	[e, n],
	[w, n],
	[w, s]
];

describe('centroidOf', () => {
	it('is a box’s middle, and the area-weighted mean of a multipolygon’s parts', () => {
		const [x, y] = centroidOf({ type: 'Polygon', coordinates: [ring(21, -34, 22, -33)] })!;
		expect(x).toBeCloseTo(21.5, 12);
		expect(y).toBeCloseTo(-33.5, 12);
		// A unit square at x 0–1 and a 2 × 1 rectangle at x 10–12: (0.5 × 1 + 11 × 2) / 3.
		const [mx] = centroidOf({ type: 'MultiPolygon', coordinates: [[ring(0, 0, 1, 1)], [ring(10, 0, 12, 1)]] })!;
		expect(mx).toBeCloseTo((0.5 + 22) / 3, 12);
		expect(centroidOf({ type: 'Point', coordinates: [1, 2] })).toBeNull();
		expect(centroidOf({ type: 'Polygon', coordinates: [[[1, 1], [1, 1], [1, 1]]] })).toBeNull();
	});
});

describe('targetAttributes', () => {
	it('takes the area, MAP and aridity the project gives, and leaves the HydroATLAS-only ones unknown', () => {
		expect(targetAttributes({ areaKm2: 120, mapMm: 640, aridity: 0.45 })).toEqual({ aridity: 0.45, mapMm: 640, slopeDeg: null, clayPct: null, sandPct: null, forestPct: null, areaKm2: 120 });
	});
});

describe('priorRanges', () => {
	const NONE = { aridity: null, mapMm: null, slopeDeg: null, clayPct: null, sandPct: null, forestPct: null, areaKm2: null };
	// x1 = 2 × PAWC exactly: the soil relation fits with skill.
	const donors: Gr4jDonor[] = Array.from({ length: 8 }, (_, i) => ({
		id: `D${i}`,
		lon: 20 + i * 0.1,
		lat: -33,
		attributes: NONE,
		params: { x1: 2 * (60 + 20 * i) * (1 + 0.01 * ((i % 3) - 1)), x2: 0, x3: 50 + i, x4: 1.5 },
		pawcMm: 60 + 20 * i
	}));

	it('takes x1 from the soil relation at the target’s PAWC, else the donors’', () => {
		const withSoil = regionalPrior({ lon: 20.3, lat: -33, attributes: NONE, pawcMm: 100 }, donors);
		if (!withSoil.ok) throw new Error(withSoil.reason);
		const a = priorRanges(withSoil);
		expect(a.x1From).toBe('soil');
		expect(a.ranges.x1.p50).toBeCloseTo(200, -1);
		expect(a.ranges.x3).toEqual(withSoil.params.x3);
		const noSoil = regionalPrior({ lon: 20.3, lat: -33, attributes: NONE }, donors);
		if (!noSoil.ok) throw new Error(noSoil.reason);
		expect(priorRanges(noSoil)).toEqual({ ranges: noSoil.params, x1From: 'donors' });
	});
});

describe('the query and body', () => {
	it('take a gauge id and a dataset label, nothing else', () => {
		expect(PriorQuery.parse({})).toEqual({});
		expect(() => PriorQuery.parse({ zone: 'not-a-uuid' })).toThrow();
		expect(() => PriorQuery.parse({ other: '1' })).toThrow();
		expect(PriorStart.parse({ zone: null })).toEqual({ zone: null });
		expect(() => PriorStart.parse({ params: { x1: 1 } })).toThrow();
	});
});
