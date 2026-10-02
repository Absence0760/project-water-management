// The share of each grid cell a polygon covers, on a regular lon/lat grid of
// any cell size (issue #326 B-landcover and B-evap; docs/maps.md § Cultivated
// area from land cover, § Evaporation from the map). Pure and dependency-free.
//
// The grid is the land-cover dataset's (cropland_dataset.cell_deg): cell
// (row, col) is the square with south-west corner (col × cell, row × cell).
// Each ring is clipped to its rows of cells, then each row's pieces to the
// row's cells, by halving the range (geo/clip.ts eachBand), so the share is exact to floating point, holes
// are subtracted and the parts of a MultiPolygon add up. The share is in
// degree space; within a cell of a few hundred metres it differs from the
// ellipsoidal share by far less than 1e-5. Overlapping parts of a
// MultiPolygon are counted twice, as they are in its area (geo/area.ts).
import { ringAreaM2 } from './area.js';
import { eachBand, openRing, signedArea2, type SignedPiece } from './clip.js';
import type { Geometry, Position } from './geojson.js';

/** A cell the polygon covers: its indices, the share of it inside, and its whole area on the ellipsoid (m²). */
export interface CellShare {
	row: number;
	col: number;
	share: number;
	cellM2: number;
}

export type GridSharesResult = { cells: CellShare[]; rows: [number, number]; cols: [number, number] } | { problem: string };

/** A sliver below this share of a cell is left out (it can't move a sum of cell areas by more than that share of one cell). */
export const MIN_CELL_SHARE = 1e-6;
const EDGE_EPS = 1e-9;

/** The cell indices [first, last) the range [lo, hi] spans, a grid line adding no empty cell. */
export const cellSpan = (lo: number, hi: number, cellDeg: number): [number, number] => [
	Math.floor(lo / cellDeg + EDGE_EPS),
	Math.ceil(hi / cellDeg - EDGE_EPS)
];

/** The area of the cell with south-west corner (west, south), m², on the ellipsoid. */
export const cellAreaM2 = (west: number, south: number, cellDeg: number): number => {
	const e = west + cellDeg;
	const n = south + cellDeg;
	return ringAreaM2([
		[west, south],
		[e, south],
		[e, n],
		[west, n]
	]);
};

/**
 * The cells of `cellDeg` a Polygon or MultiPolygon covers, or why it can't
 * be read: not a polygon, no area, or a bounding box of more than `maxCells`
 * cells (a bound on the work, checked before any clipping). With `only`,
 * cells it rejects are never clipped (a land-cover grid lists the cells
 * with cropland; the rest add nothing). `grid` names the grid in the
 * too-many-cells problem.
 */
export function gridShares(
	g: Geometry,
	cellDeg: number,
	maxCells: number,
	only?: (row: number, col: number) => boolean,
	grid = 'land-cover'
): GridSharesResult {
	if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') return { problem: 'not a polygon' };
	if (!(cellDeg > 0)) return { problem: 'the grid has no cell size' };
	const polygons = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((rings) => rings.map(openRing));
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
	if (!(south < north && west < east)) return { problem: 'the polygon has no area' };
	const rows = cellSpan(south, north, cellDeg);
	const cols = cellSpan(west, east, cellDeg);
	const n = (rows[1] - rows[0]) * (cols[1] - cols[0]);
	if (n > maxCells) return { problem: `the polygon’s extent spans ${n.toLocaleString('en-ZA')} ${grid} cells, more than the ${maxCells.toLocaleString('en-ZA')} one summary reads` };
	const cellArea = cellDeg * cellDeg;
	const cells: CellShare[] = [];
	// Each ring split into its rows, then each row's pieces into its cells, by halving (clip.ts eachBand): the work
	// grows with the vertices times log(cells), not vertices × cells, so a crafted many-vertex ring stays cheap.
	const all: SignedPiece[] = polygons.flatMap((rings) => rings.map((ring, i) => ({ ring, sign: i === 0 ? 1 : -1 })));
	eachBand(all, rows[0], rows[1], cellDeg, 'y', (r, pieces) => {
		const bottom = r * cellDeg;
		// Every cell in a row has the same area on the ellipsoid.
		let rowCellM2: number | null = null;
		eachBand(pieces, cols[0], cols[1], cellDeg, 'x', (c, inCell) => {
			if (only && !only(r, c)) return;
			let area = 0;
			for (const p of inCell) area += (p.sign * Math.abs(signedArea2(p.ring))) / 2;
			const share = area / cellArea;
			if (!(share >= MIN_CELL_SHARE)) return;
			rowCellM2 ??= cellAreaM2(c * cellDeg, bottom, cellDeg);
			cells.push({ row: r, col: c, share, cellM2: rowCellM2 });
		});
	});
	return { cells, rows, cols };
}
