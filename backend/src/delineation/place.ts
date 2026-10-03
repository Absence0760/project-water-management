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
//     Point; the radius measured from the exact click to each cell's centre
//     since delineate-4 / start-5, issue #387), and a warning when a channel
//     with LARGER_FACTOR times its upstream cells runs within GUARD_RADIUS_M:
//     it caught 61–100 % of that
//     rule's wrong placements, with at most 5 % false alarms. The warning
//     names that channel; the caller offers it, never moves there by itself
//     (near a confluence it is the wrong river).
//
// Two refinements (delineate-5, the hydrologist persona's findings 4 and 7):
//
//  3. A click on the DEM's own channel (the red lines, CHANNEL_MIN_KM2 or
//     more within ON_CHANNEL_CELLS of it) and off the reach's line (more
//     than ON_LINE_M from it) whose area is outside the reach's 50 % band
//     isn't moved past the snap radius by the match: the reach's area says
//     what the reach drains, not that the editor meant the reach. It snaps,
//     and the matching channel is offered (`larger.reach`), never taken: 7 of
//     23 clicks on 1–8 km² red lines 250–900 m from mapped rivers were moved
//     170–830 m onto rivers 10–300× their size. A click on the mapped line
//     itself still matches: there the line is what was clicked, and a small
//     channel under it is the displacement rule 1 exists for. The other way
//     round holds everywhere: a click on a channel LARGER than the band (a
//     gauge on a river whose nearest mapped line is a tributary's, within a
//     junction's reach) stays on it too, the tributary's channel offered: 9
//     of 446 gauges were silently moved onto a tributary 0.01–0.1× their area.
//  4. No match within MATCH_RADIUS_M and a snap into a gully (under
//     GULLY_SHARE of the reach's area): the match is tried again out to
//     WIDE_MATCH_M (the matching channel lies 1.2–1.5 km off at the 90th
//     percentile) and that channel offered, not taken: at that radius Lehner's
//     ranking lands on another river 5–8 % of the time, so the editor decides.
//
// And one for a head reach (delineate-11): the area at the click assumed
// HydroRIVERS' 10 km² at the reach's upper end (reach.ts HEAD_KM2), but on
// GLO-30 that spot drains 6–14 km², so a click near the head slid down its own
// channel to where the DEM drains the constant's figure. expectedOnGrid reads
// the DEM's own area there instead: from the cell the constant matches, up the
// channel (the larger branch at each fork) to its cell nearest the reach's
// upper end, and rebuilds the area at the click from it.
import type { Position } from '../geo/geojson.js';
import { DX, DY, snap } from './flow.js';

/** How far the area match looks (m): 1 km placed none on another river; 2.5 km placed 5–7 % there. */
export const MATCH_RADIUS_M = 1000;
/** How far it looks once the river is named (a confluence's pick), or to offer a channel for a gully (rule 4). */
export const WIDE_MATCH_M = 2500;
/** Least area accordance (%) a matched cell may have (Lehner 2012). */
export const MIN_ACCORDANCE = 50;
/** How far the larger-channel guard looks (m). */
export const GUARD_RADIUS_M = 1000;
/** How many times the snapped cell's upstream cells a channel needs to be "much larger". */
export const LARGER_FACTOR = 100;
/** The least upstream area (km²) of a channel cell: the Map's red lines (channels.ts CHANNEL_MIN_KM2, kept equal by a test). */
export const ON_CHANNEL_KM2 = 1;
/** How near the click (cells, from the exact click to a cell's centre) a channel cell must be for the click to be on it: a drawn line is simplified by half a cell. */
export const ON_CHANNEL_CELLS = 1.5;
/** How near (m) the mapped reach's line a click must be to be a click on that line (the snap radius): past it rule 3 applies to a smaller channel too. */
export const ON_LINE_M = 150;
/** A snap draining less than this share of the reach's area is a gully (the research's < 0.1×): then the wider match is offered. */
export const GULLY_SHARE = 0.1;

/**
 * A head reach's (nothing flows into it, reach.ts): its upper end, how far down its line the click lies (0–1, by length) and
 * its own area (km², at its lower end), for expectedOnGrid.
 */
export interface HeadHint {
	at: Position;
	fraction: number;
	reachKm2: number;
}
/** How near (m) a head reach's upper end the DEM's channel must pass for its area to be read there (headAreaKm2). */
export const HEAD_STEM_M = 1000;
/** Where the climb up a channel stops (km²): its last cell drains about a tenth of a square kilometre. */
export const STEM_END_KM2 = 0.1;

export interface PlaceOpts {
	snapRadiusM: number;
	expectedKm2?: number | null;
	chosen?: boolean;
	/** How far the click is from the reach's line (m; reach.ts distanceM); unknown counts as on it, so rule 3 stays off. */
	reachDistanceM?: number | null;
}

/**
 * The DEM's upstream area (km²) at a head reach's upper end, (hx, hy) in fractional cells: climbing from `from` (a cell on
 * the reach's channel) up the channel, always into the most-drained cell flowing into it, until it drains under STEM_END_KM2,
 * the area of its cell nearest the upper end. Null when the climb passes no nearer than HEAD_STEM_M (the channel isn't the
 * reach's), when that cell's catchment runs past the window (`open`, flow.ts openFlags: its area there is only a floor), or
 * when it drains more than the whole reach. Pure.
 */
export function headAreaKm2(g: PlaceGrid & { dir: Uint8Array; open?: Uint8Array }, from: number, hx: number, hy: number, reachKm2: number): number | null {
	const { nx, ny, acc, dir, cellSizeM } = g;
	const endCells = (STEM_END_KM2 * 1e6) / (cellSizeM * cellSizeM);
	let best = -1;
	let bestD = Infinity;
	for (let c = from; c >= 0; ) {
		const x = c % nx;
		const y = (c - x) / nx;
		const d = Math.hypot(x + 0.5 - hx, y + 0.5 - hy) * cellSizeM;
		if (d < bestD) (best = c), (bestD = d);
		let up = -1;
		for (let k = 0; k < 8; k++) {
			const ux = x - DX[k]!;
			const uy = y - DY[k]!;
			if (ux < 0 || uy < 0 || ux >= nx || uy >= ny) continue;
			const u = uy * nx + ux;
			if (dir[u] === k && acc[u]! >= endCells && (up < 0 || acc[u]! > acc[up]!)) up = u;
		}
		c = up;
	}
	if (best < 0 || bestD > HEAD_STEM_M || g.open?.[best]) return null;
	const km2 = (acc[best]! * cellSizeM * cellSizeM) / 1e6;
	return km2 > reachKm2 ? null : km2;
}

/**
 * The area to match the click at (cx, cy) to in this grid: `opts.expectedKm2` (reach.ts reachFor's, which counts a head
 * reach's upper end as HEAD_KM2), unless the reach is a head reach (`head`) and the grid reads its upper end's area
 * (headAreaKm2, climbing from the cell that area matches): then that area plus the rest of the reach's in proportion down
 * the line, as reach.ts areaAlong does. `toGrid` maps a position to fractional cells. Pure.
 */
export function expectedOnGrid(
	g: PlaceGrid & { dir: Uint8Array; open?: Uint8Array },
	cx: number,
	cy: number,
	opts: PlaceOpts,
	head: HeadHint | null | undefined,
	toGrid: (p: Position) => readonly [number, number]
): number | null | undefined {
	if (!head || !opts.expectedKm2) return opts.expectedKm2;
	const first = place(g, cx, cy, opts);
	if (first?.how !== 'matched') return opts.expectedKm2;
	const [hx, hy] = toGrid(head.at);
	const top = headAreaKm2(g, first.cell, hx, hy, head.reachKm2);
	return top === null ? opts.expectedKm2 : top + (head.reachKm2 - top) * head.fraction;
}

export interface Placement {
	cell: number;
	/** matched: the cell whose upstream area best matches the expected one; snapped: the most-drained cell near the click. */
	how: 'matched' | 'snapped';
	/**
	 * Only when snapped: a channel to offer instead, its cell and distance. Without `reach`, a channel with
	 * ≥ LARGER_FACTOR × the snapped cell's cells within GUARD_RADIUS_M (its cell nearest the click); with `reach`, the
	 * channel matching the reach's area that rule 3 or 4 didn't take (`onChannel`: rule 3, the click was on a channel).
	 */
	larger: { cell: number; distanceM: number; reach?: { onChannel: boolean } } | null;
}

export interface PlaceGrid {
	nx: number;
	ny: number;
	acc: Int32Array;
	edge: Uint8Array;
	/** One cell's side (m), for areas and distances. */
	cellSizeM: number;
}

/**
 * The click's cell coordinates in the grid (fractional); the expected upstream area (km²) when a river reach gives one;
 * `chosen`: the editor named that river at a confluence, so it is matched out to WIDE_MATCH_M and taken (rules 3 and 4 don't apply);
 * `reachDistanceM`: the click's distance from that reach's line, for rule 3.
 */
export function place(g: PlaceGrid, cx: number, cy: number, opts: PlaceOpts): Placement | null {
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
	const accordance = (cells: number) => {
		const a = cells * cellKm2;
		return (100 * Math.min(a, expected!)) / Math.max(a, expected!);
	};
	/** Lehner's ranking within R: the best cell within the band and its distance, or null. */
	const match = (R: number) => {
		let best = -1;
		let bestOc = Infinity;
		let bestD = 0;
		disc(R, (i, d) => {
			const ac = accordance(acc[i]!);
			if (ac < MIN_ACCORDANCE) return;
			const oc = 100 - ac + (2 * 50 * d) / R;
			if (oc < bestOc) (best = i), (bestOc = oc), (bestD = d);
		});
		return best < 0 ? null : { cell: best, distanceM: bestD };
	};
	let offer: Placement['larger'] = null;
	const hasExpected = !!expected && expected > 0;
	const matched = hasExpected ? match(opts.chosen ? WIDE_MATCH_M : MATCH_RADIUS_M) : null;
	if (matched) {
		// Rule 3: the click on a channel of its own, outside the band, isn't carried past the snap radius to the reach's channel.
		if (opts.chosen || matched.distanceM <= opts.snapRadiusM || !onOwnChannel(g, cx, cy, { expectedKm2: expected!, reachDistanceM: opts.reachDistanceM })) {
			return { cell: matched.cell, how: 'matched', larger: null };
		}
		offer = { ...matched, reach: { onChannel: true } };
	}
	// Measured from the exact click in metres, so the snap distance never exceeds snapRadiusM (issue #387).
	const cell = snap(nx, ny, acc, edge, cx, cy, opts.snapRadiusM / cellSizeM);
	if (cell === null) return null;
	if (offer) return { cell, how: 'snapped', larger: offer };
	// The guard: the biggest channel within reach; if it has LARGER_FACTOR times the snapped cell's cells, offer its nearest
	// cell (at least half the biggest's cells, so on that channel), not its most-drained one, which lies downstream at the disc's edge.
	let max = 0;
	disc(GUARD_RADIUS_M, (i) => {
		if (acc[i]! > max) max = acc[i]!;
	});
	if (max >= LARGER_FACTOR * acc[cell]!) {
		let near = -1;
		let nearD = Infinity;
		disc(GUARD_RADIUS_M, (i, d) => {
			if (acc[i]! >= Math.max(LARGER_FACTOR * acc[cell]!, max / 2) && d < nearD) (near = i), (nearD = d);
		});
		return { cell, how: 'snapped', larger: { cell: near, distanceM: nearD } };
	}
	// Rule 4: a gully where a reach said a river is: its matching channel further out, offered.
	if (hasExpected && !opts.chosen && acc[cell]! * cellKm2 < GULLY_SHARE * expected!) {
		const far = match(WIDE_MATCH_M);
		if (far) return { cell, how: 'snapped', larger: { ...far, reach: { onChannel: false } } };
	}
	return { cell, how: 'snapped', larger: null };
}

/**
 * Rule 3's test: the click is on a DEM channel of its own (ON_CHANNEL_KM2 or more within ON_CHANNEL_CELLS) whose area is
 * outside the reach's 50 % band. On the reach's line (within ON_LINE_M; unknown counts as on it), a channel smaller than the
 * band is the displaced line's gully (rule 1's case), so only a larger one counts there: another, bigger river under a
 * tributary's line (a gauge beside a junction). Delineate and Sub-catchments also use it to keep such a click off a junction
 * nobody picked a river at (reach.ts junctionBeside), whose side rule is for clicks on the river.
 */
export function onOwnChannel(g: PlaceGrid, cx: number, cy: number, opts: { expectedKm2: number | null | undefined; reachDistanceM?: number | null }): boolean {
	const expected = opts.expectedKm2;
	if (!expected || expected <= 0) return false;
	const { nx, ny, acc, edge, cellSizeM } = g;
	const cellKm2 = (cellSizeM * cellSizeM) / 1e6;
	const r = ON_CHANNEL_CELLS;
	let best = -1;
	for (let y = Math.floor(cy - r); y <= Math.floor(cy + r); y++) {
		for (let x = Math.floor(cx - r); x <= Math.floor(cx + r); x++) {
			if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
			const i = y * nx + x;
			if (edge[i] || Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > r) continue;
			if (acc[i]! * cellKm2 >= ON_CHANNEL_KM2 && (best < 0 || acc[i]! > acc[best]!)) best = i;
		}
	}
	if (best < 0) return false;
	const a = acc[best]! * cellKm2;
	if ((100 * Math.min(a, expected)) / Math.max(a, expected) >= MIN_ACCORDANCE) return false;
	return a > expected || (opts.reachDistanceM ?? 0) > ON_LINE_M;
}
