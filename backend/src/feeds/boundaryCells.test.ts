// The CHIRPS cells of a catchment boundary (boundaryCells.ts): each cell's
// share inside the polygon against shapes whose answer is known by hand,
// holes and MultiPolygons, the shares adding up to the polygon's own area,
// agreement with bboxCells for a rectangle, the limits, and the seeded
// Sandspruit boundary read through the fixtures (local-first).
import { describe, expect, it } from 'vitest';
import { buildExamples } from '../../scripts/examples/catchments.js';
import { sandspruitMap } from '../../scripts/examples/map.js';
import { geometryAreaM2 } from '../geo/area.js';
import type { Geometry, Position } from '../geo/geojson.js';
import { boundaryCells, MIN_SHARE } from './boundaryCells.js';
import { bboxCells, BBOX_MAX_CELLS, FeedInput } from './config.js';
import { fixtureHttp } from './fixtures.js';
import { fetchChirps } from './sources/chirps.js';

const D = 0.05;
const cos = (lat: number) => Math.cos((lat * Math.PI) / 180);
const poly = (...rings: Position[][]): Geometry => ({ type: 'Polygon', coordinates: rings.map((r) => [...r, r[0]!]) });
/** An anticlockwise rectangle ring. */
const rect = (w: number, s: number, e: number, n: number): Position[] => [
	[w, s],
	[e, s],
	[e, n],
	[w, n]
];
const ok = (g: Geometry) => {
	const r = boundaryCells(g);
	if ('problem' in r) throw new Error(r.problem);
	return r;
};
const byCell = (g: Geometry) => Object.fromEntries(ok(g).cells.map((c) => [`${c.lat},${c.lon}`, c]));
/** Twice the shoelace area of a ring, in square degrees. */
const deg2 = (ring: Position[]) => Math.abs(ring.reduce((s, [x1, y1], i) => s + x1 * ring[(i + 1) % ring.length]![1] - ring[(i + 1) % ring.length]![0] * y1, 0)) / 2;

describe('boundaryCells', () => {
	it('gives a cell wholly inside a share of 1, weighted by cos(latitude), as bboxCells does', () => {
		const c = byCell(poly(rect(25.1, -20.2, 25.2, -20.1)));
		expect(Object.keys(c).sort()).toEqual(['-20.125,25.125', '-20.125,25.175', '-20.175,25.125', '-20.175,25.175']);
		expect(c['-20.125,25.125']!.share).toBeCloseTo(1, 9);
		expect(c['-20.175,25.175']!.weight).toBeCloseTo(cos(-20.175), 9);
	});

	it('splits a cell-sized square straddling four cells into quarters', () => {
		const c = byCell(poly(rect(25.125, -20.175, 25.175, -20.125)));
		expect(Object.values(c).map((x) => x.share)).toEqual([0.25, 0.25, 0.25, 0.25]);
	});

	it('gives half a cell to a right triangle on its diagonal', () => {
		const c = byCell(poly([[25.1, -20.15], [25.15, -20.15], [25.1, -20.1]]));
		expect(Object.keys(c)).toEqual(['-20.125,25.125']);
		expect(c['-20.125,25.125']!.share).toBeCloseTo(0.5, 9);
	});

	it('clips a concave (L-shaped) boundary exactly: the notch cell is left out', () => {
		// Two cells by two, less the north-east cell.
		const L: Position[] = [[25.1, -20.2], [25.2, -20.2], [25.2, -20.15], [25.15, -20.15], [25.15, -20.1], [25.1, -20.1]];
		const c = byCell(poly(L));
		expect(Object.keys(c).sort()).toEqual(['-20.125,25.125', '-20.175,25.125', '-20.175,25.175']);
		for (const x of Object.values(c)) expect(x.share).toBeCloseTo(1, 9);
		// A U whose arms run through one cell: the cell holds the two arms, not the gap between them.
		const U: Position[] = [[25.1, -20.15], [25.15, -20.15], [25.15, -20.1], [25.14, -20.1], [25.14, -20.14], [25.11, -20.14], [25.11, -20.1], [25.1, -20.1]];
		expect(byCell(poly(U))['-20.125,25.125']!.share).toBeCloseTo(deg2(U) / (D * D), 9);
	});

	it('subtracts holes', () => {
		// A 2 × 2 block with its south-west cell cut out, and half of its north-east cell.
		const g = poly(rect(25.1, -20.2, 25.2, -20.1), rect(25.1, -20.2, 25.15, -20.15).reverse(), rect(25.15, -20.15, 25.175, -20.1).reverse());
		const c = byCell(g);
		expect(c['-20.175,25.125']).toBeUndefined();
		expect(c['-20.125,25.175']!.share).toBeCloseTo(0.5, 9);
		expect(c['-20.125,25.125']!.share).toBeCloseTo(1, 9);
	});

	it('adds up the parts of a MultiPolygon', () => {
		const g: Geometry = { type: 'MultiPolygon', coordinates: [poly(rect(25.1, -20.15, 25.125, -20.1)).coordinates as Position[][], poly(rect(25.3, -20.15, 25.35, -20.1)).coordinates as Position[][]] };
		const c = byCell(g);
		expect(c['-20.125,25.125']!.share).toBeCloseTo(0.5, 9);
		expect(c['-20.125,25.325']!.share).toBeCloseTo(1, 9);
		expect(Object.keys(c)).toHaveLength(2);
	});

	it('shares add up to the polygon’s own area, for a star that crosses many cells', () => {
		const star: Position[] = Array.from({ length: 22 }, (_, i) => {
			const r = i % 2 ? 0.07 : 0.2;
			const a = (i / 22) * 2 * Math.PI;
			return [21.3 + r * Math.cos(a), -33.7 + r * Math.sin(a)];
		});
		const r = ok(poly(star));
		const shares = r.cells.reduce((s, c) => s + c.share, 0);
		// Only the slivers below MIN_SHARE are lost, at most one per cell.
		expect(Math.abs(shares * D * D - deg2(star))).toBeLessThan(r.cells.length * MIN_SHARE * D * D);
		// And on the ellipsoid, the inside area is the polygon's geodesic area to within the slivers and the per-cell degree weighting (< 0.1 %).
		const geodesic = geometryAreaM2(poly(star))! / 1e6;
		expect(Math.abs(r.insideKm2 - geodesic) / geodesic).toBeLessThan(1e-3);
		expect(r.cellsKm2).toBeGreaterThan(r.insideKm2);
	});

	it('gives a rectangle the same cells and weights as the same bounding box', () => {
		const box = { south: -20.13, west: 25.12, north: -20.05, east: 25.2 };
		const got = ok(poly(rect(box.west, box.south, box.east, box.north))).cells.map(({ lat, lon, weight }) => ({ lat, lon, weight }));
		const want = bboxCells(box);
		expect(got.map((c) => [c.lat, c.lon])).toEqual(want.map((c) => [c.lat, c.lon]));
		got.forEach((c, i) => expect(c.weight).toBeCloseTo(want[i]!.weight, 9));
	});

	it('leaves out a cell the boundary barely touches', () => {
		// 1e-4 of a cell's height pokes into the row below.
		const c = byCell(poly(rect(25.1, -20.150005, 25.15, -20.1)));
		expect(Object.keys(c)).toEqual(['-20.125,25.125']);
	});

	it('refuses a boundary too big for one feed, saying how big it is and what to do', () => {
		const r = boundaryCells(poly(rect(25, -20.6, 25.6, -20)));
		expect(r).toEqual({ problem: expect.stringMatching(/covers 144 of the 0\.05° CHIRPS cells in 12 rows; one feed reads at most 100 cells in 25 rows/) });
		expect(boundaryCells(poly(rect(25, -40, 25.05, -20)))).toEqual({ problem: expect.stringMatching(/spans 400 rows/) });
		expect(boundaryCells(poly(rect(25, -30.3, 25.05, -29)))).toEqual({ problem: expect.stringMatching(/in 26 rows/) });
	});

	it('refuses what is not a polygon, and a boundary beyond the grid', () => {
		expect(boundaryCells({ type: 'Point', coordinates: [25, -20] })).toEqual({ problem: 'the catchment boundary is not a polygon' });
		expect(boundaryCells(poly(rect(25, -61, 25.05, -60.5)))).toEqual({ problem: expect.stringMatching(/beyond 60°/) });
	});

	it('produces cells the feed config takes', () => {
		const r = ok(poly(rect(25.1, -20.2, 25.2, -20.1)));
		expect(FeedInput.safeParse({ source: 'chirps', config: { cells: r.cells.map(({ lat, lon, weight }) => ({ lat, lon, weight })) } }).success).toBe(true);
		expect(BBOX_MAX_CELLS).toBe(100);
	});
});

describe('the seeded Sandspruit boundary (issue #326 B-rain)', () => {
	const model = buildExamples({ fit: false }).find((e) => e.name.includes('Sandspruit'))!.model;
	const boundary = sandspruitMap(model).find((f) => f.kind === 'catchment_boundary')!.geometry;

	it('covers a handful of cells whose inside area is the boundary’s', () => {
		const r = ok(boundary);
		expect(r.cells.length).toBeGreaterThan(8);
		expect(r.cells.length).toBeLessThanOrEqual(25);
		const area = geometryAreaM2(boundary)! / 1e6;
		expect(Math.abs(r.insideKm2 - area) / area).toBeLessThan(5e-3);
	});

	it('reads offline through the fixtures (FEED_SOURCE=fixtures), every cell inside the sample grid’s cover', async () => {
		const cells = ok(boundary).cells;
		const got = await fetchChirps(fixtureHttp(() => '2026-03-10'), cells, '2026-01-01', '2026-01-10');
		expect(got.values).toHaveLength(10);
		expect(got.values.every((v) => v !== null && v >= 0)).toBe(true);
	});
});
