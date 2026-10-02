// The synthetic DEM committed for delineation (backend/fixtures/dem/,
// written by `pnpm -C backend gen:dem-fixture`, backend/scripts/dem-fixture.ts).
// Invented terrain, no real place's elevations: a valley inside an elliptical
// ridge, its river running south along the axis to an outlet on the rim, with
// a dam (a wall across the river and its flat reservoir behind it) and a
// closed pit on a flank, so depression filling, flats and snapping are all
// exercised. Everything outside the ridge falls away from it.
//
// The tests and the e2e click the points below and know the areas to expect.
import { TARGET_ZOOM } from './delineate.js';

/** Zoom of the fixture's tiles; delineation reads min(TARGET_ZOOM, max zoom), so this one. */
export const FIXTURE_ZOOM = 10;
if (FIXTURE_ZOOM > TARGET_ZOOM) throw new Error('the fixture must not be finer than the zoom delineation reads');
/** 256 px tiles, 2 × 2 of them: 512 × 512 cells of about 128 m. */
export const FIXTURE_TILE = 256;
export const FIXTURE_TILES = 2;
/** The top-left tile (zoom 10): in the Western Cape's latitudes, nowhere in particular. */
export const FIXTURE_X0 = 570;
export const FIXTURE_Y0 = 612;
export const FIXTURE_CELLS = FIXTURE_TILE * FIXTURE_TILES;

const W = 2 ** FIXTURE_ZOOM * FIXTURE_TILE;
/** Longitude and latitude of a fixture-cell position (cells from the fixture's top-left corner; .5 = a cell's centre). */
export function fixtureLonLat(cx: number, cy: number): [number, number] {
	const x = FIXTURE_X0 * FIXTURE_TILE + cx;
	const y = FIXTURE_Y0 * FIXTURE_TILE + cy;
	return [Math.round(((x / W) * 360 - 180) * 1e7) / 1e7, Math.round(((Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / W))) * 180) / Math.PI) * 1e7) / 1e7];
}

/** The ridge: an ellipse centred (CX, CY), semi-axes A (east–west) and B (north–south), in cells. */
const CX = 256;
const CY = 230;
const A = 90;
const B = 120;
/** The outlet: where the river leaves the ellipse through its southern rim. */
export const OUTLET_CELL = { x: CX, y: CY + B } as const;
/** The dam wall across the river, and the reservoir's level behind it. */
export const DAM_CELL = { x: CX, y: CY + 20 } as const;
const DAM_WALL_M = 25;
/** A closed pit on the eastern flank (fills, then spills to the river). */
const PIT = { x: CX + 50, y: CY - 40, depthM: 30, radius: 6 };

/** Cell size near the fixture (m): zoom 10, 256 px tiles, about 33.5° S. */
export const FIXTURE_CELL_M = (2 * Math.PI * 6378137 * Math.cos((fixtureLonLat(CX, CY)[1] * Math.PI) / 180)) / W;

/** The valley floor: rising 1 % up the river from the outlet and 6 % away from it. */
const valley = (x: number, y: number) => 300 + 0.01 * (OUTLET_CELL.y - y) * FIXTURE_CELL_M + 0.06 * Math.abs(x - CX) * FIXTURE_CELL_M;
const RIDGE_M = 20;

/**
 * Elevation (m) at cell (x, y) of the fixture: inside the ellipse the valley,
 * rising RIDGE_M over its outer tenth to the ridge (except where the river
 * leaves); outside, the ridge falling 15 % away from the ellipse, steeper
 * than the valley's slope along it, so nothing outside drains in. Rounded to
 * 1/256 m, as Terrarium stores it.
 */
export function fixtureElevation(x: number, y: number): number {
	const cell = FIXTURE_CELL_M;
	const px = x + 0.5;
	const py = y + 0.5;
	const s = Math.sqrt(((px - CX) / A) ** 2 + ((py - CY) / B) ** 2);
	let z: number;
	if (x === CX && y >= OUTLET_CELL.y) {
		// The river's channel south of the outlet, below everything beside it.
		z = valley(CX, OUTLET_CELL.y) - 2 - 0.01 * (y - OUTLET_CELL.y) * cell;
	} else if (s < 1) {
		z = valley(x, y);
		// The ridge's inner slope, cut by the river's gap in the south.
		const gap = y > CY && Math.abs(x - CX) <= 2;
		if (!gap && s > 0.9) z += (RIDGE_M * (s - 0.9)) / 0.1;
		const dp = Math.hypot(x - PIT.x, y - PIT.y);
		if (dp < PIT.radius) z -= PIT.depthM * (1 - dp / PIT.radius);
		// The dam: a wall across the valley at DAM_CELL, the reservoir flat behind it at the crest less 5 m.
		const level = valley(CX, DAM_CELL.y) + DAM_WALL_M - 5;
		if (y === DAM_CELL.y && Math.abs(x - CX) <= 12) z += DAM_WALL_M;
		else if (y < DAM_CELL.y && y > DAM_CELL.y - 40 && z < level) z = level;
	} else {
		// The point of the ellipse on the way to the centre, and the distance to it (m).
		const qx = CX + (px - CX) / s;
		const qy = CY + (py - CY) / s;
		z = valley(qx, qy) + RIDGE_M - 0.15 * Math.hypot(px - qx, py - qy) * cell;
	}
	return Math.round(z * 256) / 256;
}

/** The ellipse's area (m²): what the outlet's catchment should come to, near enough. */
export const BASIN_AREA_M2 = Math.PI * A * B * FIXTURE_CELL_M * FIXTURE_CELL_M;
/** Bounds of the fixture (west, south, east, north). */
export const FIXTURE_BOUNDS = ((): [number, number, number, number] => {
	const [w, n] = fixtureLonLat(0, 0);
	const [e, s] = fixtureLonLat(FIXTURE_CELLS, FIXTURE_CELLS);
	return [w, s, e, n];
})();
export const FIXTURE_FILE = new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url);
