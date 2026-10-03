// The DEM's own junction for a click at a confluence (issue #374's follow-up,
// docs/design/delineation-snapping.md § Confluences). Area matching alone
// can't tell "the river below the junction" from "the main river above it":
// they differ only by the tributary, often under 5 %, well inside Lehner's 50 %
// tolerance, yet that is the whole of the editor's choice. So: match each
// river above the junction to its channel (place.ts), follow each downhill
// until they meet, and the meeting cell is the DEM's junction. The river
// below is that cell (everything from every branch); each river above is
// its own branch's last cell before it (that branch only). Each river's
// outlet then goes on its own channel, on its side of that junction, at the
// cell nearest the click (issue #390): a click beside a confluence
// (reach.ts junctionBeside) as well as one at it. Measured and tested
// against the routing Delineate uses
// (docs/design/delineation-snapping.md § Beside a confluence); pure.
import { DX, DY, OUT } from './flow.js';
import { place, WIDE_MATCH_M, type PlaceGrid } from './place.js';

/** How far (m) the branches' paths may run before they must have met: past it the DEM's junction is too far from the click to trust. */
export const JUNCTION_PATH_M = 4000;
/**
 * How far (m) a junction placement may move the click before it is flagged: further, the DEM's rivers meet away from the mapped
 * junction (a quarter of junctions are over 1.1 km apart), and the outlet a gauge records may be another site. Not a cap: falling
 * back to the area match past it put 4–5 times as many clicks on the wrong side (delineation-snapping.md § Beside a confluence).
 */
export const JUNCTION_FLAG_M = 500;
/** How far (m) a branch's channel is looked for from the click once the river is named. */
export const JUNCTION_MATCH_M = WIDE_MATCH_M;

export interface JunctionRiver {
	key: string;
	role: 'above' | 'below' | 'along';
	km2: number;
}

/** The DEM's junction and each river's cell at it (the old outlets, before projecting onto the river's own channel). */
export interface JunctionBranches {
	/** Where every branch has met: the river below's first cell. */
	junction: number;
	/** The tributary's and the main river's last cell before the junction, by key. */
	tributary: { key: string; end: number };
	main: { key: string; end: number };
	/** Every river's cell at the junction, by key: the branches' ends, the junction for the river below, a third river above by area. */
	ends: Map<string, number>;
}

type JunctionGrid = PlaceGrid & { dir: Uint8Array };

function stepper(g: JunctionGrid) {
	const { nx, ny, dir, acc } = g;
	const down = (c: number) => {
		const d = dir[c]!;
		if (d === OUT) return -1;
		const x = (c % nx) + DX[d]!;
		const y = Math.floor(c / nx) + DY[d]!;
		return x < 0 || y < 0 || x >= nx || y >= ny ? -1 : y * nx + x;
	};
	/** The most-drained neighbour flowing into c (its channel upstream), or -1 at a channel's head. */
	const up = (c: number, not = -1) => {
		const cx = c % nx;
		const cy = (c - cx) / nx;
		let best = -1;
		for (let d = 0; d < 8; d++) {
			const x = cx + DX[d]!;
			const y = cy + DY[d]!;
			if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
			const k = y * nx + x;
			if (k === not || down(k) !== c) continue;
			if (best < 0 || acc[k]! > acc[best]!) best = k;
		}
		return best;
	};
	return { down, up };
}

/**
 * The DEM's junction for a confluence's rivers, or null when it can't be
 * found (fewer than two rivers above, the tributary not matched, no inflow
 * big enough within JUNCTION_PATH_M).
 *
 * The tributary (the smallest river above) anchors it: its area is distinct,
 * so matching finds its channel. Following it downhill, the junction is the
 * first cell where an inflow of at least half the main river's area joins
 * from another neighbour; the main river above is that neighbour, the most
 * drained one flowing into the junction. The main river is never matched by
 * area: within Lehner's tolerance its cells and the river below's look alike.
 */
export function junctionBranches(g: JunctionGrid, cx: number, cy: number, rivers: readonly JunctionRiver[], snapRadiusM: number): JunctionBranches | null {
	const above = rivers.filter((r) => r.role === 'above').sort((a, b) => a.km2 - b.km2);
	if (above.length < 2 || rivers.some((r) => r.role === 'along')) return null;
	const { nx, ny, acc } = g;
	const cellKm2 = (g.cellSizeM * g.cellSizeM) / 1e6;
	const { down, up } = stepper(g);
	const tributary = above[0]!;
	const main = above[above.length - 1]!;
	const t = place(g, cx, cy, { snapRadiusM, expectedKm2: tributary.km2, chosen: true });
	if (!t || t.how !== 'matched') return null;
	const steps = Math.ceil(JUNCTION_PATH_M / g.cellSizeM) * 2;
	// Half the main river's area, but no more than a quarter of the routed window: a river bigger than the window
	// (the Orange) brings only what drains inside it.
	const joins = Math.min(0.5 * main.km2, 0.25 * nx * ny * cellKm2);
	let prev = t.cell;
	for (let k = down(prev), n = 0; k >= 0 && n < steps; prev = k, k = down(k), n++) {
		// What reaches k from neighbours other than the tributary's own path.
		const inflowKm2 = (acc[k]! - acc[prev]! - 1) * cellKm2;
		if (inflowKm2 < joins) continue;
		const mainCell = up(k, prev);
		if (mainCell < 0) return null;
		const ends = new Map<string, number>([
			[tributary.key, prev],
			[main.key, mainCell]
		]);
		for (const r of rivers) if (r.role === 'below') ends.set(r.key, k);
		// A third river above (rare): matched by area, as without a junction.
		for (const r of above.slice(1, -1)) {
			const p = place(g, cx, cy, { snapRadiusM, expectedKm2: r.km2, chosen: true });
			if (!p) return null;
			ends.set(r.key, p.cell);
		}
		return { junction: k, tributary: { key: tributary.key, end: prev }, main: { key: main.key, end: mainCell }, ends };
	}
	return null;
}

/**
 * Each river's outlet cell, by key, on its own side of the DEM's junction;
 * null when the junction can't be found (junctionBranches): the caller then
 * matches by area.
 *
 * Each river goes on its own channel at the cell nearest the click, so the
 * junction decides the side and the click the place along the river
 * (delineate-7): the tributary and the main river on their channels upstream
 * of their branch's last cell, the river below on the junction's path
 * downhill. Before, every river went at the junction itself, which moved a
 * gauge a few hundred metres from it as far as the junction (up to 2 km
 * where the DEM's junction is off the mapped one); a click right at the
 * junction still lands there. A third river above stays matched by area.
 */
export function junctionOutlets(g: JunctionGrid, cx: number, cy: number, rivers: readonly JunctionRiver[], snapRadiusM: number): Map<string, number> | null {
	const b = junctionBranches(g, cx, cy, rivers, snapRadiusM);
	if (!b) return null;
	const { nx } = g;
	const { down, up } = stepper(g);
	// Far enough to pass the click wherever the junction is: the junction within JUNCTION_PATH_M of the tributary's
	// matched cell, that within JUNCTION_MATCH_M of the click.
	const steps = Math.ceil((JUNCTION_PATH_M + JUNCTION_MATCH_M) / g.cellSizeM) * 2;
	const nearest = (from: number, next: (c: number) => number) => {
		let best = from;
		let bestD = Infinity;
		for (let c = from, n = 0; c >= 0 && n < steps; c = next(c), n++) {
			const x = c % nx;
			const d = Math.hypot(x + 0.5 - cx, (c - x) / nx + 0.5 - cy);
			if (d < bestD) (best = c), (bestD = d);
		}
		return best;
	};
	const out = new Map(b.ends);
	out.set(b.tributary.key, nearest(b.tributary.end, (c) => up(c)));
	out.set(b.main.key, nearest(b.main.end, (c) => up(c)));
	const below = nearest(b.junction, down);
	for (const r of rivers) if (r.role === 'below') out.set(r.key, below);
	return out;
}
