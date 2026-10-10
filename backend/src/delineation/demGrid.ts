// The DEM grid layer of the catchment map (docs/maps.md § DEM grid): a thinned
// grid of the elevation model's own cells, for looking at, not for modelling.
// One point every DEM_GRID_STRIDE cells along each row and column (one cell in
// STRIDE², 100 at the default) at the DEM's deepest zoom, each at its cell's
// centre with the cell's elevation. Cells are picked on the global pixel grid
// (their index a multiple of the stride), so the points stay put as the view
// pans. Web Mercator tiles, as the delineation reads them (dem.ts).
import type { Dem } from './dem.js';

/** Every this-many DEM cells along each axis: one point in 100 cells. */
export const DEM_GRID_STRIDE = 10;
/** Below this an elevation is the DEM's no-data or sea, not land. */
const NODATA_BELOW_M = -500;

/** A west, south, east, north box in WGS84 degrees. */
export interface Box {
	w: number;
	s: number;
	e: number;
	n: number;
}

/** One sampled cell: its centre and elevation, whole metres. */
export type DemPoint = [lon: number, lat: number, elevationM: number];

/** Global pixel x of a longitude at zoom z with tiles of `size` px (Web Mercator). */
const pxX = (lon: number, world: number) => ((lon + 180) / 360) * world;
const pxY = (lat: number, world: number) => {
	const s = Math.sin((Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180);
	return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world;
};
const lonOf = (x: number, world: number) => (x / world) * 360 - 180;
const latOf = (y: number, world: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / world))) * 180) / Math.PI;

/** The stride-aligned global pixel columns and rows whose centres lie in `box`. */
export function sampledPixels(box: Box, world: number, stride: number) {
	const x0 = Math.ceil((pxX(box.w, world) - 0.5) / stride) * stride;
	const x1 = Math.floor((pxX(box.e, world) - 0.5) / stride) * stride;
	// Rows grow southward.
	const y0 = Math.ceil((pxY(box.n, world) - 0.5) / stride) * stride;
	const y1 = Math.floor((pxY(box.s, world) - 0.5) / stride) * stride;
	const cols = x1 >= x0 ? (x1 - x0) / stride + 1 : 0;
	const rows = y1 >= y0 ? (y1 - y0) / stride + 1 : 0;
	return { x0, x1, y0, y1, count: cols * rows };
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * The DEM's stride-aligned cells in `box`, at most `max`: null when the box
 * holds more (counted from the grid before any tile is read: the caller says
 * zoom in), else each cell's centre and elevation, north to south, west to
 * east. A cell the DEM has no tile for, or a no-data cell, is left out.
 */
export async function demGridPoints(dem: Dem, box: Box, max: number, stride = DEM_GRID_STRIDE): Promise<{ points: DemPoint[]; zoom: number; cellM: number } | null> {
	const info = await dem.info();
	const z = info.maxZoom;
	// The tile side is the DEM's own; read one tile to learn it (cached by dem.ts).
	const n = 2 ** z;
	const centreTile = (lon: number, lat: number) => [Math.floor(((lon + 180) / 360) * n), Math.floor(pxY(lat, n))] as const;
	const [tx, ty] = centreTile((box.w + box.e) / 2, (box.s + box.n) / 2);
	const probe = await dem.tile(z, tx, ty);
	const size = probe?.size ?? 512;
	const world = n * size;
	const range = sampledPixels(box, world, stride);
	if (range.count > max) return null;
	const midLat = (box.s + box.n) / 2;
	const cellM = (40_075_016.686 * Math.cos((midLat * Math.PI) / 180)) / world;
	const points: DemPoint[] = [];
	for (let gy = range.y0; gy <= range.y1; gy += stride) {
		for (let gx = range.x0; gx <= range.x1; gx += stride) {
			const t = await dem.tile(z, Math.floor(gx / size), Math.floor(gy / size));
			if (!t) continue;
			const v = t.z[(gy % size) * t.size + (gx % size)];
			if (v === undefined || !Number.isFinite(v) || v < NODATA_BELOW_M) continue;
			points.push([round6(lonOf(gx + 0.5, world)), round6(latOf(gy + 0.5, world)), Math.round(v)]);
		}
	}
	return { points, zoom: z, cellM: Math.round(cellM) };
}
