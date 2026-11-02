// The grid cells a catchment boundary covers (issue #326 B-rain, WP-2.10 ×
// WP-3.12; docs/maps.md § Rain from the boundary): CHIRPS's 0.05° cells
// (CHIRPS_GRID), or the 0.1° cells of our copy's reference ET (ET0_GRID,
// AgERA5 and NASA POWER over region D1). Pure: the from-boundary routes
// (feeds/fromBoundary.ts) call it on the project's `catchment_boundary` map
// feature, and the from-units route (feeds/fromUnits.ts) on each unit's parcel.
//
// Each cell of the grid the boundary touches gets the weight
//     share of the cell inside the boundary × cos(the cell centre's latitude),
// the same weighting bboxCells gives a box (feeds/config.ts), so the feed's
// rainfall is the area-weighted mean over the boundary itself rather than over
// the box around it. Holes are subtracted; the parts of a MultiPolygon add up.
//
// Method: exact clipping, not sampling (geo/clip.ts). Every ring is clipped to each cell
// square with Sutherland–Hodgman (the cell is convex, so clipping a concave
// ring to it still gives a polygon whose signed area is exactly the area of
// the intersection: the extra edges the algorithm leaves along the cell's
// sides run there and back and cancel), and the share is that area over the
// cell's, in degrees. A ring is first clipped to its row of cells, then each
// row's piece to the row's cells, so the work is about (rows + cells) ×
// vertices. The share is exact to floating point; sampling on a fine grid
// would carry an error of the order of the sample spacing along the boundary
// and cost far more points for the same accuracy. Within a 0.05° cell the
// degree-space share and the true (ellipsoidal) share differ by under 1e-4,
// since the cell's width changes by that little from its bottom to its top
// (under 2e-4 in a 0.1° cell).
//
// A cell with less than MIN_SHARE of its area inside is left out: its weight
// would move the mean by less than that share of one cell's rain, and every
// listed cell is read on every day (and must have data: a listed sea cell
// fails the fetch).
import { geometryAreaM2 } from '../geo/area.js';
import { eachBand, GRID_WORK_BUDGET, GridWorkExceeded, openRing as open, signedArea2, type SignedPiece } from '../geo/clip.js';
import type { Geometry, Position } from '../geo/geojson.js';
import { MIRROR_REGION, PRODUCT_GRIDS } from '../mirror/grid.js';
import { BBOX_MAX_CELLS, BBOX_MAX_ROWS, CHIRPS_CELL_DEG, type WeightedCell } from './config.js';

/**
 * The grid a boundary's cells are cut on: square cells of `step` degrees
 * whose edges fall on its multiples, inside `bounds`.
 */
export interface BoundaryGrid {
	step: number;
	/** The grid's product in a problem's words: "the 0.05° CHIRPS cells". */
	name: string;
	/** The box the grid covers; a boundary reaching past it is refused with `outside`. */
	bounds: { w: number; s: number; e: number; n: number };
	outside: string;
	/** About how much area a feed's BBOX_MAX_CELLS cells cover at South African latitudes, km², for the limit's words. */
	aboutKm2: string;
}

/** CHIRPS v3 covers 50° S to 50° N over land; the feed's grid check takes ±60 (config.ts Lat). */
export const CHIRPS_GRID: BoundaryGrid = {
	step: CHIRPS_CELL_DEG,
	name: 'CHIRPS',
	bounds: { w: -180, s: -60, e: 180, n: 60 },
	outside: 'reaches beyond 60° of latitude, outside the CHIRPS grid',
	aboutKm2: '2,500'
};

/**
 * The reference ET copy's grid (feeds/fromMirrorEt0.ts): AgERA5's 0.1° cells,
 * centred on x.x5° (ingest/agera5.py), over region D1, whose edges are whole
 * tenths, so a cell's edges fall on multiples of 0.1° as here. NASA POWER's
 * days are regridded onto the same cells. A listed cell's centre names the
 * one cell that holds it (fromMirrorEt0.ts et0Cell).
 */
export const ET0_GRID: BoundaryGrid = {
	step: PRODUCT_GRIDS.agera5_et0.step,
	name: 'AgERA5',
	bounds: MIRROR_REGION,
	outside: `reaches outside the region our copy of the reference evapotranspiration holds (${MIRROR_REGION.w}–${MIRROR_REGION.e}° E, ${-MIRROR_REGION.n}–${-MIRROR_REGION.s}° S)`,
	aboutKm2: '10,000'
};

/** A cell with less than this share of its area inside the boundary is left out (0.1 % of a cell, about 0.03 km²). */
export const MIN_SHARE = 1e-3;
/**
 * The most grid rows or columns a boundary's extent may span before the
 * cells are even counted (10° of CHIRPS cells, 20° of reference ET ones): a bound on the work, far past the feed’s own
 * limit of BBOX_MAX_CELLS cells in BBOX_MAX_ROWS rows.
 */
export const MAX_SPAN = 200;
/** The limit, said the same way wherever a boundary is too big. */
const limit = (grid: BoundaryGrid) =>
	`one feed reads at most ${BBOX_MAX_CELLS} cells in ${BBOX_MAX_ROWS} rows (about ${grid.aboutKm2} km² at South African latitudes): attach feeds for parts of the catchment by hand instead`;

/** A cell the boundary covers: its centre, its weight (as bboxCells), and the share of it inside the boundary. */
export interface BoundaryCell extends WeightedCell {
	share: number;
}

export type BoundaryCellsResult =
	| {
			cells: BoundaryCell[];
			rows: number;
			/** The whole area of the cells read, km² (on the ellipsoid, geo/area.ts). */
			cellsKm2: number;
			/** The part of them inside the boundary, km² (each cell's area × its share): the boundary's area, less the slivers left out. */
			insideKm2: number;
	  }
	| { problem: string };

const EDGE_EPS = 1e-6;
const round = (x: number, places = 9) => Number(x.toFixed(places));

/** The cell indices [first, last) a pair of edges spans along one axis, a bound on a grid line adding no sliver (as config.ts span). */
const span = (lo: number, hi: number, step: number): [number, number] => [Math.floor(lo / step + EDGE_EPS), Math.ceil(hi / step - EDGE_EPS)];

/** Area of the cell of `step` degrees with south-west corner (west, south), km², on the ellipsoid. */
const cellKm2 = (west: number, south: number, step: number) => {
	const e = west + step;
	const n = south + step;
	return geometryAreaM2({ type: 'Polygon', coordinates: [[[west, south], [e, south], [e, n], [west, n], [west, south]]] })! / 1e6;
};

/**
 * The weighted cells of `grid` (CHIRPS's unless told) under a Polygon or
 * MultiPolygon boundary, or the reason there are none it can use: too big
 * for one feed, outside the grid, or not a polygon. The geometry is one the
 * map stored, so its rings are already checked (closed, simple, holes inside:
 * geo/geojson.ts). `what` names the polygon in a problem (a unit's parcel,
 * feeds/fromUnits.ts).
 */
export function boundaryCells(g: Geometry, what = 'the catchment boundary', grid: BoundaryGrid = CHIRPS_GRID): BoundaryCellsResult {
	const step = grid.step;
	const deg = `${step}°`;
	if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') return { problem: `${what} is not a polygon` };
	const polygons = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((rings) => rings.map(open));
	let south = Infinity;
	let north = -Infinity;
	let west = Infinity;
	let east = -Infinity;
	for (const rings of polygons) {
		for (const [x, y] of rings[0] ?? []) {
			south = Math.min(south, y);
			north = Math.max(north, y);
			west = Math.min(west, x);
			east = Math.max(east, x);
		}
	}
	if (!(south < north && west < east)) return { problem: `${what} has no area` };
	const box = grid.bounds;
	if (south < box.s || north > box.n || west < box.w || east > box.e) return { problem: `${what} ${grid.outside}` };
	const [r0, r1] = span(south, north, step);
	const [c0, c1] = span(west, east, step);
	if (r1 - r0 > MAX_SPAN || c1 - c0 > MAX_SPAN) {
		return { problem: `${what} spans ${r1 - r0} rows and ${c1 - c0} columns of ${deg} cells; ${limit(grid)}` };
	}
	const cellArea = step * step;
	const cells: BoundaryCell[] = [];
	const rows = new Set<number>();
	let cellsKm2 = 0;
	let insideKm2 = 0;
	// Each ring split into its rows, then each row's pieces into its cells, by halving (geo/clip.ts eachBand): the work
	// grows with the vertices times log(cells), not vertices × cells, so a crafted many-vertex ring stays cheap.
	const all: SignedPiece[] = polygons.flatMap((rings) => rings.map((ring, i) => ({ ring, sign: i === 0 ? 1 : -1 })));
	const work = { vertices: 0, limit: GRID_WORK_BUDGET };
	try {
		eachBand(all, r0, r1, step, 'y', (r, pieces) => {
			const bottom = r * step;
			const lat = round((r + 0.5) * step);
			const cos = Math.cos((lat * Math.PI) / 180);
			eachBand(pieces, c0, c1, step, 'x', (c, inCell) => {
				const left = c * step;
				let area = 0;
				for (const p of inCell) area += (p.sign * Math.abs(signedArea2(p.ring))) / 2;
				const share = Math.min(1, area / cellArea);
				if (!(share >= MIN_SHARE)) return;
				const km2 = cellKm2(left, bottom, step);
				cellsKm2 += km2;
				insideKm2 += km2 * share;
				rows.add(r);
				cells.push({ lat, lon: round((c + 0.5) * step), weight: round(share * cos), share: round(share, 6) });
			}, work);
		}, work);
	} catch (err) {
		if (err instanceof GridWorkExceeded) return { problem: `${what}’s outline is too detailed to read the ${grid.name} cells under it (more than ${err.limit.toLocaleString('en-ZA')} vertex cuts); simplify it` };
		throw err;
	}
	if (!cells.length) return { problem: `${what} covers no ${deg} cell enough to read` };
	if (cells.length > BBOX_MAX_CELLS || rows.size > BBOX_MAX_ROWS) {
		return { problem: `${what} covers ${cells.length} of the ${deg} ${grid.name} cells in ${rows.size} rows; ${limit(grid)}` };
	}
	return { cells, rows: rows.size, cellsKm2: round(cellsKm2, 3), insideKm2: round(insideKm2, 3) };
}
