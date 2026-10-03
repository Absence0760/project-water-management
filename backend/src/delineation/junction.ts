// The DEM's own junction for a click at a confluence (issue #374's follow-up,
// docs/design/delineation-snapping.md § Confluences). Area matching alone
// can't tell "the river below the junction" from "the main river above it":
// they differ only by the tributary, often under 5 %, well inside Lehner's 50 %
// tolerance, yet that is the whole of the editor's choice. So: match each
// river above the junction to its channel (place.ts), follow each downhill
// until they meet, and the meeting cell is the DEM's junction. The river
// below is that cell (everything from every branch); each river above is
// its own branch's last cell before it (that branch only). Measured and
// tested against the routing Delineate uses; pure.
import { DX, DY, OUT } from './flow.js';
import { place, WIDE_MATCH_M, type PlaceGrid } from './place.js';

/** How far (m) the branches' paths may run before they must have met: past it the DEM's junction is too far from the click to trust. */
export const JUNCTION_PATH_M = 4000;
/** How far (m) a branch's channel is looked for from the click once the river is named. */
export const JUNCTION_MATCH_M = WIDE_MATCH_M;

export interface JunctionRiver {
	key: string;
	role: 'above' | 'below' | 'along';
	km2: number;
}

/**
 * Each river's outlet cell at the DEM's junction, by key; null when it can't
 * be found (fewer than two rivers above, the tributary not matched, no inflow
 * big enough within JUNCTION_PATH_M): the caller then matches by area.
 *
 * The tributary (the smallest river above) anchors it: its area is distinct,
 * so matching finds its channel. Following it downhill, the junction is the
 * first cell where an inflow of at least half the main river's area joins
 * from another neighbour; the main river above is that neighbour, the most
 * drained one flowing into the junction. The main river is never matched by
 * area: within Lehner's tolerance its cells and the river below's look alike.
 */
export function junctionOutlets(g: PlaceGrid & { dir: Uint8Array }, cx: number, cy: number, rivers: readonly JunctionRiver[], snapRadiusM: number): Map<string, number> | null {
	const above = rivers.filter((r) => r.role === 'above').sort((a, b) => a.km2 - b.km2);
	if (above.length < 2 || rivers.some((r) => r.role === 'along')) return null;
	const { nx, ny, dir, acc } = g;
	const cellKm2 = (g.cellSizeM * g.cellSizeM) / 1e6;
	const down = (c: number) => {
		const d = dir[c]!;
		if (d === OUT) return -1;
		const x = (c % nx) + DX[d]!;
		const y = Math.floor(c / nx) + DY[d]!;
		return x < 0 || y < 0 || x >= nx || y >= ny ? -1 : y * nx + x;
	};
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
		let mainCell = -1;
		const kx = k % nx;
		const ky = (k - kx) / nx;
		for (let d = 0; d < 8; d++) {
			const x = kx + DX[d]!;
			const y = ky + DY[d]!;
			if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
			const c = y * nx + x;
			if (c === prev || down(c) !== k) continue;
			if (mainCell < 0 || acc[c]! > acc[mainCell]!) mainCell = c;
		}
		if (mainCell < 0) return null;
		const out = new Map<string, number>([
			[tributary.key, prev],
			[main.key, mainCell]
		]);
		for (const r of rivers) if (r.role === 'below') out.set(r.key, k);
		// A third river above (rare): matched by area, as without a junction.
		for (const r of above.slice(1, -1)) {
			const p = place(g, cx, cy, { snapRadiusM, expectedKm2: r.km2, chosen: true });
			if (!p) return null;
			out.set(r.key, p.cell);
		}
		return out;
	}
	return null;
}
