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
import { snap } from './flow.js';

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
export function place(
	g: PlaceGrid,
	cx: number,
	cy: number,
	opts: {
		snapRadiusM: number;
		expectedKm2?: number | null;
		chosen?: boolean;
		/** How far the click is from the reach's line (m; reach.ts distanceM); unknown counts as on it, so rule 3 stays off. */
		reachDistanceM?: number | null;
	}
): Placement | null {
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
		let onChannel = -1;
		if (!opts.chosen && matched.distanceM > opts.snapRadiusM) {
			disc(ON_CHANNEL_CELLS * cellSizeM, (i) => {
				if (acc[i]! * cellKm2 >= ON_CHANNEL_KM2 && (onChannel < 0 || acc[i]! > acc[onChannel]!)) onChannel = i;
			});
		}
		// On the reach's line, a channel smaller than the band is the displaced line's gully (rule 1's case); a larger one is another,
		// bigger river under a tributary's line (a gauge beside a junction), so it counts wherever the line is.
		const smaller = onChannel >= 0 && acc[onChannel]! * cellKm2 < expected!;
		const applies = onChannel >= 0 && accordance(acc[onChannel]!) < MIN_ACCORDANCE && (!smaller || (opts.reachDistanceM ?? 0) > ON_LINE_M);
		if (!applies) return { cell: matched.cell, how: 'matched', larger: null };
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
