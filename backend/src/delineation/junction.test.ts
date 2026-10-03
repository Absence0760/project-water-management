import { describe, expect, it } from 'vitest';
import { accumulate, OUT } from './flow.js';
import { junctionOutlets } from './junction.js';

// A 21 × 25 grid of 100 m cells (0.01 km² each): the main river south down
// column 10, fed by the hillside west of it (rows drain east into it); a
// tributary west along row 12 from x = 15, fed by a small block above it;
// it joins the main river at (10, 12). The rest drains east off the grid.
const N = { x: 21, y: 25 };
const E = 0;
const S = 2;
const W = 4;
function grid() {
	const n = N.x * N.y;
	const dir = new Uint8Array(n);
	const edge = new Uint8Array(n);
	for (let y = 0; y < N.y; y++)
		for (let x = 0; x < N.x; x++) {
			const i = y * N.x + x;
			if (x === 0 || y === 0 || x === N.x - 1 || y === N.y - 1) {
				edge[i] = 1;
				dir[i] = OUT;
			} else if (x === 10) dir[i] = S;
			else if (x < 10) dir[i] = E;
			else if (y === 12 && x <= 15) dir[i] = W;
			else if (x <= 15 && y >= 9 && y < 12) dir[i] = S;
			else dir[i] = E;
		}
	const acc = accumulate(N.x, N.y, dir);
	return { nx: N.x, ny: N.y, dir, edge, acc, cellSizeM: 100 };
}
const cell = (x: number, y: number) => y * N.x + x;
const km2 = (g: ReturnType<typeof grid>, c: number) => g.acc[c]! * 0.01;

describe('junctionOutlets', () => {
	it('puts each river at the DEM’s own junction: the tributary and the main river on their branches, the river below at the junction', () => {
		const g = grid();
		const trib = km2(g, cell(11, 12));
		const main = km2(g, cell(10, 11));
		const below = km2(g, cell(10, 12));
		const out = junctionOutlets(g, 10.6, 12.4, [
			{ key: 'below', role: 'below', km2: below },
			{ key: 'main', role: 'above', km2: main },
			{ key: 'trib', role: 'above', km2: trib }
		], 150)!;
		expect(out.get('trib')).toBe(cell(11, 12));
		expect(out.get('main')).toBe(cell(10, 11));
		expect(out.get('below')).toBe(cell(10, 12));
		// What the editor's choice turns on: the river below is both branches (plus its own cell and its row's 9 hillside cells
		// from the west), the main river above is the main branch alone.
		expect(km2(g, out.get('below')!)).toBeCloseTo(km2(g, out.get('main')!) + km2(g, out.get('trib')!) + 0.1, 6);
	});

	it('finds the junction even with the reaches’ areas off by a third (HydroRIVERS is not the DEM)', () => {
		const g = grid();
		const out = junctionOutlets(g, 10.6, 12.4, [
			{ key: 'main', role: 'above', km2: km2(g, cell(10, 11)) * 1.33 },
			{ key: 'trib', role: 'above', km2: km2(g, cell(11, 12)) * 0.75 }
		], 150)!;
		expect(out.get('main')).toBe(cell(10, 11));
		expect(out.get('trib')).toBe(cell(11, 12));
	});

	it('gives up (null) with fewer than two rivers above, a river along the point, or no inflow big enough', () => {
		const g = grid();
		expect(junctionOutlets(g, 10.6, 12.4, [{ key: 'main', role: 'above', km2: 1 }, { key: 'below', role: 'below', km2: 1.3 }], 150)).toBeNull();
		expect(junctionOutlets(g, 10.6, 12.4, [{ key: 'a', role: 'along', km2: 1 }, { key: 't', role: 'above', km2: 0.2 }, { key: 'm', role: 'above', km2: 1 }], 150)).toBeNull();
		// A "main river" far bigger than anything that joins the tributary: no junction to find.
		expect(junctionOutlets(g, 10.6, 12.4, [{ key: 'm', role: 'above', km2: 500 }, { key: 't', role: 'above', km2: km2(g, cell(11, 12)) }], 150)).toBeNull();
	});
});
