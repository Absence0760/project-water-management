// The pure part of each unit's monthly A-pan from an A-pan grid
// (geo/unitApan.ts): the area-weighted mean over a parcel month by month (a
// cell half inside counts half, cells without a value left out of both sums),
// the 90 % coverage rule and the cell cap. Invented grids only.
import { describe, expect, it } from 'vitest';
import type { Geometry, Position } from './geojson.js';
import { unitApanFromCells } from './unitApan.js';
import { MIN_UNIT_COVERAGE } from './unitMap.js';

const ring = (w: number, s: number, e: number, n: number): Position[] => [
	[w, s],
	[e, s],
	[e, n],
	[w, n],
	[w, s]
];
const poly = (w: number, s: number, e: number, n: number): Geometry => ({ type: 'Polygon', coordinates: [ring(w, s, e, n)] });
/** A 0.1° grid with origin (0.05, 0): cell (row, col) has its south-west corner at (0.05 + col × 0.1, row × 0.1). */
const GRID = { cellDeg: 0.1, originLon: 0.05, originLat: 0 };
const row = (base: number) => Array.from({ length: 12 }, (_, m) => base + m);

describe('unitApanFromCells', () => {
	it('weights each cell by the share of it inside the parcel, month by month', () => {
		const cells = new Map([
			['-301:250', row(100)],
			['-301:251', row(250)]
		]);
		// All of column 250, half of column 251, one row: (1 × v₁ + 0.5 × v₂) ÷ 1.5 = 150 + m.
		const r = unitApanFromCells(poly(25.05, -30.1, 25.2, -30.0), GRID, cells);
		if (!('monthlyMm' in r)) throw new Error(r.reason);
		expect(r.monthlyMm).toEqual(row(150));
		expect(r.annualMm).toBe(12 * 150 + 66);
		expect(r.cells).toBe(2);
		expect(r.coveredShare).toBeCloseTo(1, 9);
	});

	it('leaves cells without a value out of both sums, and calls a parcel under 90 % covered uncovered, saying how much', () => {
		const one = new Map([['-301:250', row(200)]]);
		const most = unitApanFromCells(poly(25.05, -30.1, 25.155263, -30.0), GRID, one);
		expect(most).toMatchObject({ monthlyMm: row(200), cells: 1 });
		expect((most as { coveredShare: number }).coveredShare).toBeGreaterThanOrEqual(MIN_UNIT_COVERAGE);
		const half = unitApanFromCells(poly(25.05, -30.1, 25.25, -30.0), GRID, one);
		expect(half).toEqual({ coveredShare: expect.closeTo(0.5, 6), reason: 'the grid has values for only 50 % of the unit’s parcel (at least 90 % is needed)' });
		expect(unitApanFromCells(poly(26.05, -30.1, 26.15, -30.0), GRID, one)).toEqual({ coveredShare: 0, reason: 'the grid has no value inside the unit’s parcel' });
	});

	it('refuses a parcel whose box spans more cells than one unit may read', () => {
		const r = unitApanFromCells(poly(20, -31, 22, -29), GRID, new Map(), 100);
		expect(r).toMatchObject({ coveredShare: 0 });
		expect((r as { reason: string }).reason).toMatch(/A-pan grid/);
	});
});
