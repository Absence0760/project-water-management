// The boundary's evaporation from grid cells (geo/evaporation.ts, issue #326
// B-evap): the area-weighted mean over the cells with a value, a cell half
// inside counting half, cells without a value left out of both sums and
// reported as coverage, nothing proposed below MIN_COVERAGE, a grid whose
// cell corners sit half a cell off whole multiples (dPET's), and the
// citation.
import { describe, expect, it } from 'vitest';
import { citeEvaporation, evaporationExtent, evaporationFromCells, MIN_COVERAGE } from './evaporation.js';
import type { Geometry } from './geojson.js';

const rect = (w: number, s: number, e: number, n: number): Geometry => ({
	type: 'Polygon',
	coordinates: [
		[
			[w, s],
			[e, s],
			[e, n],
			[w, n],
			[w, s]
		]
	]
});
const row = (v: number) => Array.from({ length: 12 }, (_, m) => v + m);
/** A 1° grid with corners on whole degrees (origin 0). */
const WHOLE = { cellDeg: 1, originLon: 0, originLat: 0 };

describe('evaporationFromCells', () => {
	it('weights each cell by its area inside the boundary (half a cell counts half)', () => {
		// Cell (row −34, col 20) has all of it inside; cell (−34, 21) half.
		const cells = new Map([
			['-34:20', row(100)],
			['-34:21', row(40)]
		]);
		const r = evaporationFromCells(rect(20, -34, 21.5, -33), WHOLE, cells);
		if ('problem' in r) throw new Error(r.problem);
		// The two cells are in one row, so they have the same area: weights 1 and 0.5.
		expect(r.monthlyMm[0]).toBeCloseTo((100 * 1 + 40 * 0.5) / 1.5, 1);
		expect(r.monthlyMm[11]).toBeCloseTo((111 * 1 + 51 * 0.5) / 1.5, 1);
		expect(r.coverage).toBeCloseTo(1, 9);
		expect(r.cells).toBe(2);
		expect(r.annualMm).toBeCloseTo(r.monthlyMm.reduce((a, b) => a + b, 0), 6);
	});

	it('leaves cells without a value out, and reports how much of the boundary they leave uncovered', () => {
		const r = evaporationFromCells(rect(20, -34, 22, -33), WHOLE, new Map([['-34:20', row(80)]]));
		if ('problem' in r) throw new Error(r.problem);
		expect(r.monthlyMm).toEqual(row(80));
		// Two cells of equal area, one with a value.
		expect(r.coverage).toBeCloseTo(0.5, 9);
		expect(MIN_COVERAGE).toBe(0.5);
	});

	it('proposes nothing below MIN_COVERAGE or with no value at all', () => {
		const third = evaporationFromCells(rect(20, -34, 23, -33), WHOLE, new Map([['-34:20', row(80)]]));
		expect(third).toEqual({ problem: expect.stringMatching(/values for only 33 % of the boundary/) });
		expect(evaporationFromCells(rect(20, -34, 21, -33), WHOLE, new Map())).toEqual({ problem: expect.stringMatching(/no value inside the boundary/) });
		expect(evaporationFromCells({ type: 'Point', coordinates: [20, -33] }, WHOLE, new Map())).toEqual({ problem: 'not a polygon' });
	});

	it('reads a grid whose cells are centred on whole tenths (corners half a cell off)', () => {
		const grid = { cellDeg: 0.1, originLon: 0.05, originLat: 0.05 };
		// The cell centred on (21.3, −33.7) spans 21.25–21.35, −33.75 to −33.65: row ⌊(−33.75 − 0.05) / 0.1⌋ = −338, col 212.
		const r = evaporationFromCells(rect(21.26, -33.74, 21.34, -33.66), grid, new Map([['-338:212', row(60)]]));
		if ('problem' in r) throw new Error(r.problem);
		expect(r).toMatchObject({ monthlyMm: row(60), cells: 1 });
		expect(r.coverage).toBeCloseTo(1, 9);
		expect(evaporationExtent(rect(21.26, -33.74, 21.34, -33.66), grid)).toEqual({ rows: [-338, -337], cols: [212, 213] });
	});

	it('refuses a boundary past the cell limit before clipping', () => {
		expect(evaporationFromCells(rect(10, -40, 30, -20), { cellDeg: 0.1, originLon: 0, originLat: 0 }, new Map(), 1000)).toEqual({
			problem: expect.stringMatching(/spans 40\D000 evaporation cells, more than the 1\D000/)
		});
	});
});

it('citeEvaporation names the source, version, period and label', () => {
	expect(citeEvaporation({ dataset: 'dPET-1991-2020', source: 'dPET (Singer et al. 2021)', version: 'hPET v3', firstYear: 1991, lastYear: 2020 })).toBe(
		'dPET (Singer et al. 2021) (hPET v3, 1991–2020 monthly means; dataset “dPET-1991-2020”)'
	);
});
