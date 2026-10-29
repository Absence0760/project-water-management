// The 0.25° climate cells under a catchment boundary (issue #621 slice 4), and
// the FUTURE_YIELD switch: pure, no DB.
import { describe, expect, it } from 'vitest';
import type { Geometry } from '../geo/geojson.js';
import { climateCells } from './cells.js';
import { futureYieldEnabled } from './store.js';

const sq = (lon: number, lat: number, dx: number, dy = dx): Geometry => ({ type: 'Polygon', coordinates: [[[lon, lat], [lon + dx, lat], [lon + dx, lat + dy], [lon, lat + dy], [lon, lat]]] });

describe('climateCells', () => {
	it('puts a boundary inside one cell in that cell, on the copy’s grid (row 7, column 45 at 33.625° S, 21.375° E)', () => {
		const r = climateCells(sq(21.3, -33.7, 0.1));
		if ('problem' in r) throw new Error(r.problem);
		expect(r.cells).toEqual([{ row: 7, col: 45, lat: -33.625, lon: 21.375, weight: Number((0.16 * Math.cos((33.625 * Math.PI) / 180)).toFixed(9)) }]);
	});

	it('weighs the cells a boundary straddles by their share inside × cos(latitude)', () => {
		// Half of 21.25–21.5 and half of 21.5–21.75 in longitude, all of one row.
		const r = climateCells(sq(21.375, -33.75, 0.25, 0.25));
		if ('problem' in r) throw new Error(r.problem);
		expect(r.cells.map((c) => [c.row, c.col]).sort()).toEqual([[7, 45], [7, 46]]);
		expect(r.cells[0]!.weight).toBeCloseTo(r.cells[1]!.weight, 9);
		const total = r.cells.reduce((s, c) => s + c.weight, 0);
		expect(total).toBeCloseTo(Math.cos((33.625 * Math.PI) / 180), 6);
	});

	it('refuses what it can’t read: outside the copy’s region, not a polygon', () => {
		expect(climateCells(sq(5, -33.7, 0.1))).toMatchObject({ problem: expect.stringMatching(/outside the region/) });
		expect(climateCells({ type: 'Point', coordinates: [21.3, -33.7] } as never)).toEqual({ problem: 'the catchment boundary is not a polygon' });
	});
});

describe('FUTURE_YIELD', () => {
	it('is off unless on, and refuses anything else', () => {
		expect(futureYieldEnabled({})).toBe(false);
		expect(futureYieldEnabled({ FUTURE_YIELD: 'off' })).toBe(false);
		expect(futureYieldEnabled({ FUTURE_YIELD: 'on' })).toBe(true);
		expect(() => futureYieldEnabled({ FUTURE_YIELD: 'yes' })).toThrow('unknown FUTURE_YIELD "yes"');
	});
});
