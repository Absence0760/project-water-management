// The synthetic water occurrence raster committed for tracing a dam (issue
// #326 C2; backend/fixtures/water/, written by `pnpm -C backend
// gen:water-fixture`, backend/scripts/water-fixture.ts). Invented water only,
// no real place's: over the e2e tests' synthetic catchment (21.3–21.4° E,
// 33.6–33.7° S), a dam whose edge is wet less often than its middle, with an
// island; a thin, seldom-wet stream from it to a pond, so the share asked for
// decides whether they join; and a lake cut off by the raster's east edge.
// Values are the share of observations (%) a cell was water; 0 is dry land.
//
// The tests and the e2e click the points below and know the cells to expect.
import { TRACE_ZOOM } from './damTrace.js';

/** Zoom of the fixture's tiles: tracing reads min(TRACE_ZOOM, max zoom), so this one. */
export const WATER_FIXTURE_ZOOM = 12;
if (WATER_FIXTURE_ZOOM > TRACE_ZOOM) throw new Error('the fixture must not be finer than the zoom tracing reads');
export const WATER_FIXTURE_TILE = 256;
export const WATER_FIXTURE_TILES = 2;
/** The top-left tile (zoom 12): 21.27–21.45° E, 33.58–33.72° S. */
export const WATER_FIXTURE_X0 = 2290;
export const WATER_FIXTURE_Y0 = 2454;
export const WATER_FIXTURE_CELLS = WATER_FIXTURE_TILE * WATER_FIXTURE_TILES;

const W = 2 ** WATER_FIXTURE_ZOOM * WATER_FIXTURE_TILE;
/** Longitude and latitude of a fixture-cell position (cells from the top-left; .5 = a cell's centre). */
export function waterLonLat(cx: number, cy: number): [number, number] {
	const x = WATER_FIXTURE_X0 * WATER_FIXTURE_TILE + cx;
	const y = WATER_FIXTURE_Y0 * WATER_FIXTURE_TILE + cy;
	return [Math.round(((x / W) * 360 - 180) * 1e7) / 1e7, Math.round(((Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / W))) * 180) / Math.PI) * 1e7) / 1e7];
}

/** The dam: an ellipse centred here (cells), semi-axes DAM_A across and DAM_B down; wet 85 % in its inner 70 %, 35 % at its edge. */
const DAM = { x: 150, y: 330, a: 14, b: 9 };
/** An island near the middle: dry. */
const ISLAND = { x: 153, y: 330, r: 2 };
/** A stream south from the dam to the pond, one cell wide, wet 15 % of the time. */
const STREAM = { x: 150, y0: 339, y1: 372 };
/** The pond the stream reaches: wet 70 %. */
const POND = { x: 150, y: 377, r: 4 };
/** A lake along the raster's east edge (its data stops there). */
const LAKE = { x0: 496, y0: 100, y1: 200 };

/** Occurrence (%) of cell (x, y). */
export function fixtureOccurrence(x: number, y: number): number {
	const r = Math.hypot((x - DAM.x) / DAM.a, (y - DAM.y) / DAM.b);
	if (Math.hypot(x - ISLAND.x, y - ISLAND.y) <= ISLAND.r) return 0;
	if (r < 0.7) return 85;
	if (r < 1) return 35;
	if (x === STREAM.x && y >= STREAM.y0 && y <= STREAM.y1) return 15;
	if (Math.hypot(x - POND.x, y - POND.y) <= POND.r) return 70;
	if (x >= LAKE.x0 && y >= LAKE.y0 && y <= LAKE.y1) return 90;
	return 0;
}

/** A click in the dam's water (its middle, beside the island). [lon, lat] */
export const DAM_CLICK = waterLonLat(DAM.x - 6 + 0.5, DAM.y + 0.5);
/** A click on dry land just beside the dam's edge (under 60 m out): moved onto the water. */
export const DAM_NEAR_CLICK = waterLonLat(DAM.x + DAM.a + 1 + 0.5, DAM.y + 0.5);
/** A click well away from any water. */
export const DRY_CLICK = waterLonLat(60.5, 60.5);
/** A click in the lake the raster's edge cuts off. */
export const LAKE_CLICK = waterLonLat(LAKE.x0 + 5.5, (LAKE.y0 + LAKE.y1) / 2 + 0.5);

/** Bounds of the fixture (west, south, east, north). */
export const WATER_FIXTURE_BOUNDS = ((): [number, number, number, number] => {
	const [w, n] = waterLonLat(0, 0);
	const [e, s] = waterLonLat(WATER_FIXTURE_CELLS, WATER_FIXTURE_CELLS);
	return [w, s, e, n];
})();
export const WATER_FIXTURE_FILE = new URL('../../fixtures/water/synthetic-water.pmtiles', import.meta.url);
