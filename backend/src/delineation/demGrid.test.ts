// The DEM grid (demGrid.ts) over the committed synthetic DEM (fixture.ts:
// zoom 10, 2 × 2 tiles of 256 px): every 10th cell each way on the global
// pixel grid, at its centre, with the cell's own elevation; the same cells
// whatever box asks; refused (null) past the cap, counted before any read;
// nothing where the DEM has no tile.
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDem } from './dem.js';
import { DEM_GRID_STRIDE, demGridPoints, sampledPixels } from './demGrid.js';
import { FIXTURE_CELLS, FIXTURE_FILE, FIXTURE_TILE, FIXTURE_X0, FIXTURE_Y0, FIXTURE_ZOOM, fixtureElevation, fixtureLonLat } from './fixture.js';

const dem = openDem(fileURLToPath(FIXTURE_FILE));
const WORLD = 2 ** FIXTURE_ZOOM * FIXTURE_TILE;
/** The fixture's whole extent, a hair inside its edges. */
const [w, n] = fixtureLonLat(0, 0);
const [e, s] = fixtureLonLat(FIXTURE_CELLS, FIXTURE_CELLS);
const whole = { w: w + 1e-6, s: s + 1e-6, e: e - 1e-6, n: n - 1e-6 };

describe('demGridPoints', () => {
	it('gives every 10th cell each way across the fixture, at its centre, with that cell’s elevation', async () => {
		const got = (await demGridPoints(dem, whole, 10_000))!;
		expect(got.zoom).toBe(FIXTURE_ZOOM);
		// 512 cells a side, the multiples of 10 from the global index; the fixture's terrain falls far below
		// sea level away from its ridge, and those cells (< −500 m, no land) are left out as no-data.
		const side = sampledPixels(whole, WORLD, DEM_GRID_STRIDE);
		let land = 0;
		for (let gy = side.y0; gy <= side.y1; gy += DEM_GRID_STRIDE)
			for (let gx = side.x0; gx <= side.x1; gx += DEM_GRID_STRIDE)
				if (fixtureElevation(gx - FIXTURE_X0 * FIXTURE_TILE, gy - FIXTURE_Y0 * FIXTURE_TILE) >= -500) land++;
		expect(side.count).toBeGreaterThan(50 * 50);
		expect(got.points.length).toBe(land);
		expect(land).toBeGreaterThan(500);
		for (const [lon, lat, m] of got.points.slice(0, 200)) {
			// Back to the fixture's cell from the point's centre.
			const gx = Math.floor(((lon + 180) / 360) * WORLD);
			const sinLat = Math.sin((lat * Math.PI) / 180);
			const gy = Math.floor((0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * WORLD);
			expect(gx % DEM_GRID_STRIDE).toBe(0);
			expect(gy % DEM_GRID_STRIDE).toBe(0);
			expect(m).toBe(Math.round(fixtureElevation(gx - FIXTURE_X0 * FIXTURE_TILE, gy - FIXTURE_Y0 * FIXTURE_TILE)));
		}
		expect(got.cellM).toBeGreaterThan(100);
	});

	it('keeps the same cells whatever box asks: a smaller box gives the points of the bigger one inside it', async () => {
		const all = (await demGridPoints(dem, whole, 10_000))!.points;
		const [w2, n2] = fixtureLonLat(100, 100);
		const [e2, s2] = fixtureLonLat(300, 300);
		const part = (await demGridPoints(dem, { w: w2, s: s2, e: e2, n: n2 }, 10_000))!.points;
		expect(part.length).toBeGreaterThan(0);
		const key = (p: number[]) => `${p[0]},${p[1]}`;
		const allKeys = new Set(all.map(key));
		for (const p of part) expect(allKeys.has(key(p))).toBe(true);
	});

	it('refuses a box with more points than asked for, and gives none where the DEM has no tile', async () => {
		expect(await demGridPoints(dem, whole, 100)).toBeNull();
		const away = await demGridPoints(dem, { w: 30, s: -10, e: 30.05, n: -9.95 }, 10_000);
		expect(away!.points).toEqual([]);
	});
});
