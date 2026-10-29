// The 0.25° NEX-GDDP-CMIP6 cells a catchment boundary covers, with their
// weights (issue #621 slice 4): each cell's share inside the boundary ×
// cos(its centre's latitude), as feeds/boundaryCells.ts weighs CHIRPS's
// 0.05° cells, clipped exactly the same way (geo/clip.ts eachBand). Pure.
// The cells are the copy's (mirror/grid.ts: D1 tiled from 35.375° S,
// 10.125° E), so a cell outside D1 is a problem, not a read.
import { eachBand, GRID_WORK_BUDGET, GridWorkExceeded, openRing, signedArea2, type SignedPiece } from '../geo/clip.js';
import type { Geometry } from '../geo/geojson.js';
import { gridOf, MIRROR_REGION, regionSize } from '../mirror/grid.js';

export const CMIP6_STEP = 0.25;
/** A cell with less than this share inside is left out (as boundaryCells' MIN_SHARE). */
const MIN_SHARE = 1e-3;
/** The most 0.25° rows or columns a boundary may span (10°). */
const MAX_SPAN = 40;

export interface ClimateGridCell {
	/** The copy's row (northwards from 35.375° S) and column (eastwards from 10.125° E). */
	row: number;
	col: number;
	lat: number;
	lon: number;
	weight: number;
}

const round = (x: number, places = 9) => Number(x.toFixed(places));

/** The weighted 0.25° cells of a Polygon or MultiPolygon, or why there are none. */
export function climateCells(g: Geometry): { cells: ClimateGridCell[] } | { problem: string } {
	if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') return { problem: 'the catchment boundary is not a polygon' };
	const polygons = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((rings) => rings.map(openRing));
	let s = Infinity;
	let n = -Infinity;
	let w = Infinity;
	let e = -Infinity;
	for (const rings of polygons) for (const [x, y] of rings[0] ?? []) ((s = Math.min(s, y)), (n = Math.max(n, y)), (w = Math.min(w, x)), (e = Math.max(e, x)));
	if (!(s < n && w < e)) return { problem: 'the catchment boundary has no area' };
	const R = MIRROR_REGION;
	if (s < R.s || n > R.n || w < R.w || e > R.e) return { problem: `the catchment boundary reaches outside the region the climate projections are copied for (${R.s}° to ${R.n}°, ${R.w}° to ${R.e}°)` };
	const eps = 1e-6;
	const r0 = Math.floor(s / CMIP6_STEP + eps);
	const r1 = Math.ceil(n / CMIP6_STEP - eps);
	const c0 = Math.floor(w / CMIP6_STEP + eps);
	const c1 = Math.ceil(e / CMIP6_STEP - eps);
	if (r1 - r0 > MAX_SPAN || c1 - c0 > MAX_SPAN) return { problem: `the catchment boundary spans more than ${MAX_SPAN} rows or columns of 0.25° cells` };
	const grid = gridOf(R, CMIP6_STEP);
	const { rows, cols } = regionSize(R, CMIP6_STEP);
	const area = CMIP6_STEP * CMIP6_STEP;
	const out: ClimateGridCell[] = [];
	const all: SignedPiece[] = polygons.flatMap((rings) => rings.map((ring, i) => ({ ring, sign: i === 0 ? 1 : -1 })));
	try {
		eachBand(all, r0, r1, CMIP6_STEP, 'y', (r, pieces) => {
			const lat = round((r + 0.5) * CMIP6_STEP);
			const cos = Math.cos((lat * Math.PI) / 180);
			eachBand(pieces, c0, c1, CMIP6_STEP, 'x', (c, inCell) => {
				let a = 0;
				for (const p of inCell) a += (p.sign * Math.abs(signedArea2(p.ring))) / 2;
				const share = Math.min(1, a / area);
				if (!(share >= MIN_SHARE)) return;
				const lon = round((c + 0.5) * CMIP6_STEP);
				const row = Math.round((lat - grid.origin.lat) / CMIP6_STEP);
				const col = Math.round((lon - grid.origin.lon) / CMIP6_STEP);
				if (row < 0 || row >= rows || col < 0 || col >= cols) return;
				out.push({ row, col, lat, lon, weight: round(share * cos) });
			}, { vertices: 0, limit: GRID_WORK_BUDGET });
		}, { vertices: 0, limit: GRID_WORK_BUDGET });
	} catch (err) {
		if (err instanceof GridWorkExceeded) return { problem: 'the catchment boundary’s outline is too detailed to read the climate cells under it; simplify it' };
		throw err;
	}
	if (!out.length) return { problem: 'the catchment boundary covers no 0.25° cell enough to read' };
	return { cells: out };
}
