// Where a click on the map goes on the DEM's channel network (issue #374,
// docs/design/delineation-snapping.md). The river lines an editor clicks
// (HydroRIVERS, the basemap's waterways) sit off the channel the DEM routes
// along: on South African reaches the matching channel was a median 150–260 m
// from the HydroRIVERS line, 1.2–1.4 km at the 90th percentile, so the old
// rule (the most-drained cell within 150 m) put 45–57 % of clicks into a
// gully. Two rules, measured on 220 reaches:
//
//  1. With an expected upstream area (the nearest river reach's), Lehner's
//     station allocation (2012, as restated by Burek & Smilovic 2023, ESSD
//     15, §2.1.1): every cell within MATCH_RADIUS_M whose upstream area is
//     within 50 % of the expected one, ranked by OC = RA + 2·RD (RA = 100 −
//     the area accordance in %, 0–50; RD = the distance, 0 at the click to 50
//     at the radius). 67–87 % placed right, none in a gully or on another
//     river; no cell passing is "no match" and falls through to 2.
//  2. Otherwise the most-drained cell within the snap radius (Snap Pour
//     Point), and a warning when a channel with LARGER_FACTOR times its
//     upstream cells runs within GUARD_RADIUS_M: it caught 61–100 % of that
//     rule's wrong placements, with at most 5 % false alarms. The warning
//     names that channel; the caller offers it, never moves there by itself
//     (near a confluence it is the wrong river).
import { snap } from './flow.js';

/** How far the area match looks (m): 1 km placed none on another river; 2.5 km placed 5–7 % there. */
export const MATCH_RADIUS_M = 1000;
/** Least area accordance (%) a matched cell may have (Lehner 2012). */
export const MIN_ACCORDANCE = 50;
/** How far the larger-channel guard looks (m). */
export const GUARD_RADIUS_M = 1000;
/** How many times the snapped cell's upstream cells a channel needs to be "much larger". */
export const LARGER_FACTOR = 100;

export interface Placement {
	cell: number;
	/** matched: the cell whose upstream area best matches the expected one; snapped: the most-drained cell near the click. */
	how: 'matched' | 'snapped';
	/** Only when snapped: a channel with ≥ LARGER_FACTOR × its upstream cells within GUARD_RADIUS_M: its cell nearest the click. */
	larger: { cell: number; distanceM: number } | null;
}

export interface PlaceGrid {
	nx: number;
	ny: number;
	acc: Int32Array;
	edge: Uint8Array;
	/** One cell's side (m), for areas and distances. */
	cellSizeM: number;
}

/** The click's cell coordinates in the grid (fractional); the expected upstream area (km²) when a river reach gives one. */
export function place(g: PlaceGrid, cx: number, cy: number, opts: { snapRadiusM: number; expectedKm2?: number | null }): Placement | null {
	const { nx, ny, acc, edge, cellSizeM } = g;
	const cellKm2 = (cellSizeM * cellSizeM) / 1e6;
	const disc = (m: number, visit: (i: number, d: number) => void) => {
		const r = Math.ceil(m / cellSizeM);
		const ix = Math.floor(cx);
		const iy = Math.floor(cy);
		for (let y = iy - r; y <= iy + r; y++) {
			if (y < 0 || y >= ny) continue;
			for (let x = ix - r; x <= ix + r; x++) {
				if (x < 0 || x >= nx) continue;
				const i = y * nx + x;
				if (edge[i]) continue;
				const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) * cellSizeM;
				if (d <= m) visit(i, d);
			}
		}
	};
	const expected = opts.expectedKm2;
	if (expected && expected > 0) {
		let best = -1;
		let bestOc = Infinity;
		disc(MATCH_RADIUS_M, (i, d) => {
			const a = acc[i]! * cellKm2;
			const accordance = (100 * Math.min(a, expected)) / Math.max(a, expected);
			if (accordance < MIN_ACCORDANCE) return;
			const oc = 100 - accordance + (2 * 50 * d) / MATCH_RADIUS_M;
			if (oc < bestOc) (best = i), (bestOc = oc);
		});
		if (best >= 0) return { cell: best, how: 'matched', larger: null };
	}
	const radius = Math.max(1, Math.round(opts.snapRadiusM / cellSizeM));
	const cell = snap(nx, ny, acc, edge, Math.floor(cx), Math.floor(cy), radius);
	if (cell === null) return null;
	// The guard: the biggest channel within reach; if it has LARGER_FACTOR times the snapped cell's cells, offer its nearest
	// cell (at least half the biggest's cells, so on that channel), not its most-drained one, which lies downstream at the disc's edge.
	let max = 0;
	disc(GUARD_RADIUS_M, (i) => {
		if (acc[i]! > max) max = acc[i]!;
	});
	if (max < LARGER_FACTOR * acc[cell]!) return { cell, how: 'snapped', larger: null };
	let near = -1;
	let nearD = Infinity;
	disc(GUARD_RADIUS_M, (i, d) => {
		if (acc[i]! >= Math.max(LARGER_FACTOR * acc[cell]!, max / 2) && d < nearD) (near = i), (nearD = d);
	});
	return { cell, how: 'snapped', larger: { cell: near, distanceM: nearD } };
}
