// The pure parts of each unit's MAP from the MAP grid (geo/unitMap.ts): the
// area-weighted mean over a parcel (a cell half inside counts half, cells
// without a value left out of both sums), the coverage rule, the source line
// and reading the grid back out of it. Invented grids only.
import { describe, expect, it } from 'vitest';
import type { Geometry, Position } from './geojson.js';
import type { Db } from '../db/tx.js';
import { gridOfSource, MAX_GRID_CELLS_PER_REQUEST, MIN_UNIT_COVERAGE, unitMapFromCells, unitMapSource, unitOverGrid, type UnitMapGrid } from './unitMap.js';

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

describe('unitMapFromCells', () => {
	it('weights each cell by the share of it inside the parcel, on the grid’s own origin', () => {
		// 25.05–25.25 E: all of column 250 (25.05–25.15), half of column 251 (25.15–25.25 → 25.15–25.20 is half). One row.
		const cells = new Map([
			['-301:250', 600],
			['-301:251', 900]
		]);
		const r = unitMapFromCells(poly(25.05, -30.1, 25.2, -30.0), GRID, cells);
		// (1 × 600 + 0.5 × 900) ÷ 1.5 = 700 (both cells in one row: the same area on the ellipsoid).
		expect(r).toEqual({ mapMm: 700, cells: 2, coveredShare: expect.closeTo(1, 9) });
	});

	it('leaves cells without a value out of both sums, and calls a unit below the coverage rule uncovered', () => {
		const one = new Map([['-301:250', 600]]);
		// 95 % of the parcel in the valued cell: covered, MAP from that cell alone.
		const most = unitMapFromCells(poly(25.05, -30.1, 25.155263, -30.0), GRID, one);
		expect(most).toMatchObject({ mapMm: 600, cells: 1 });
		expect((most as { coveredShare: number }).coveredShare).toBeGreaterThanOrEqual(MIN_UNIT_COVERAGE);
		// Half of it: uncovered, saying how much.
		const half = unitMapFromCells(poly(25.05, -30.1, 25.25, -30.0), GRID, one);
		expect(half).toEqual({ coveredShare: expect.closeTo(0.5, 6), reason: 'the grid has values for only 50 % of the unit’s parcel (at least 90 % is needed)' });
		expect(unitMapFromCells(poly(25.05, -30.1, 25.25, -30.0), GRID, new Map())).toEqual({ coveredShare: 0, reason: 'the grid has no value inside the unit’s parcel' });
	});

	it('refuses a parcel past the cell bound before reading, and a MAP that rounds below 1 mm', () => {
		const big = unitMapFromCells(poly(20, -34, 30, -24), GRID, new Map(), 1_000);
		expect(big).toMatchObject({ coveredShare: 0, reason: expect.stringMatching(/MAP grid cells, more than the 1[\s ,]000 one summary reads/) });
		expect(unitMapFromCells(poly(25.05, -30.1, 25.15, -30.0), GRID, new Map([['-301:250', 0.2]]))).toMatchObject({ reason: 'the grid’s MAP over the unit’s parcel rounds below 1 mm' });
		// Above the range a unit's MAP takes (the engine's mapMmError): a grid may hold up to 20 000 mm.
		expect(unitMapFromCells(poly(25.05, -30.1, 25.15, -30.0), GRID, new Map([['-301:250', 15_000]]))).toMatchObject({
			reason: 'the grid’s MAP over the unit’s parcel, 15000 mm, is above the 12000 mm a unit’s MAP takes'
		});
	});

	it('stops reading a grid once the request’s units have spanned its budget of cells, reading nothing more', async () => {
		let reads = 0;
		const db = { query: async () => ((reads += 1), { rows: [] }) } as unknown as Db;
		const grid: UnitMapGrid = { ...GRID, dataset: 'g', source: 's', version: '1', attribution: 'a', cells: 1, synthetic: false };
		const budget = { cells: MAX_GRID_CELLS_PER_REQUEST - 1 };
		const r = await unitOverGrid(db, grid, poly(25.05, -30.1, 25.25, -30.0), budget);
		expect(r).toMatchObject({ coveredShare: 0, reason: expect.stringMatching(/^the units together span more than the 1[\s ,]000[\s ,]000 cells of this grid one request reads/) });
		expect(reads).toBe(0);
		// Within it, the read happens and the span is counted.
		const fresh = { cells: 0 };
		await unitOverGrid(db, grid, poly(25.05, -30.1, 25.25, -30.0), fresh);
		expect(reads).toBe(1);
		expect(fresh.cells).toBe(2);
	});
});

describe('the source line', () => {
	it('names the grid, its version, the method and the cells, and gives the grid back', () => {
		const s = unitMapSource({ dataset: 'synthetic', version: 'synthetic 1' }, 12);
		expect(s).toBe('synthetic synthetic 1, area-weighted mean over the unit’s parcel, 12 cells');
		expect(unitMapSource({ dataset: 'g', version: '1' }, 1)).toBe('g 1, area-weighted mean over the unit’s parcel, 1 cell');
		expect(gridOfSource(s)).toBe('synthetic synthetic 1');
		// A label and version with spaces, digits and commas round-trip too.
		expect(gridOfSource(unitMapSource({ dataset: 'MAP 2020, v2', version: '2020 1.0' }, 3))).toBe('MAP 2020, v2 2020 1.0');
		// A MAP typed in is no grid's.
		expect(gridOfSource('the farm’s own gauge, 1995–2020')).toBeNull();
		expect(gridOfSource(null)).toBeNull();
	});
});
