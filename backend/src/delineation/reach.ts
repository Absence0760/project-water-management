// The mapped river reach near a click, for wording only: when a catchment is
// too large to delineate, the refusal quotes what the mapped river drains
// (delineate.ts tooLargeText, the hydrologist's review finding 11). Read from
// river_reference (171), the operator's loaded network (HydroRIVERS, or the
// synthetic set); none loaded, or none within the radius, means the plain
// sentence.
//
// It never places the outlet. Issue #374 matched the outlet to the reach's
// upstream area and asked which river at a mapped confluence; issue #472
// took that out, since the DEM's rivers often run somewhere else than the
// mapped lines (place.ts).
import type { Db } from '../db/tx.js';
import type { Position } from '../geo/geojson.js';

/** How far (m) from a click a reach counts as the river there. */
export const REACH_NEAR_M = 1000;

export interface NearReach {
	dataset: string;
	reachId: number;
	/** Its upstream area at its downstream end (km²). */
	upstreamKm2: number;
	/** The click's distance from its line (m). */
	distanceM: number;
}

/** Metres from p to the segment a–b, on a local equirectangular plane. */
function segmentDistM(p: Position, a: Position, b: Position): number {
	const kx = 111320 * Math.cos((p[1] * Math.PI) / 180);
	const ky = 110950;
	const ax = (a[0] - p[0]) * kx;
	const ay = (a[1] - p[1]) * ky;
	const dx = (b[0] - a[0]) * kx;
	const dy = (b[1] - a[1]) * ky;
	const len2 = dx * dx + dy * dy;
	const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
	return Math.hypot(ax + t * dx, ay + t * dy);
}
const linesOf = (coordinates: Position[] | Position[][]): Position[][] => (typeof coordinates[0]?.[0] === 'number' ? [coordinates as Position[]] : (coordinates as Position[][]));

/** The line's distance from p (m): a LineString or a MultiLineString's coordinates. */
export function lineDistM(p: Position, coordinates: Position[] | Position[][]): number {
	let best = Infinity;
	for (const line of linesOf(coordinates)) for (let i = 0; i + 1 < line.length; i++) best = Math.min(best, segmentDistM(p, line[i]!, line[i + 1]!));
	return best;
}

/** Every reach with an upstream area within `radiusM` of the click, the nearest first. */
async function reachesNear(db: Db, click: Position, radiusM: number): Promise<NearReach[]> {
	const dLat = radiusM / 110950;
	const dLon = radiusM / (111320 * Math.cos((click[1] * Math.PI) / 180));
	// The bounding-box index (river_reference_bbox_idx) narrows it to the reaches whose box meets the click's.
	const { rows } = await db.query<{ dataset: string; reach_id: string; upstream_km2: number; geometry: { coordinates: Position[] | Position[][] } }>(
		`SELECT dataset, reach_id, upstream_km2, geometry FROM river_reference
		  WHERE upstream_km2 IS NOT NULL AND max_lon >= $1 AND min_lon <= $3 AND max_lat >= $2 AND min_lat <= $4
		  LIMIT 500`,
		[click[0] - dLon, click[1] - dLat, click[0] + dLon, click[1] + dLat]
	);
	const out: NearReach[] = [];
	for (const r of rows) {
		const d = lineDistM(click, r.geometry.coordinates);
		if (d > radiusM) continue;
		out.push({ dataset: r.dataset, reachId: Number(r.reach_id), upstreamKm2: r.upstream_km2, distanceM: d });
	}
	return out.sort((a, b) => a.distanceM - b.distanceM);
}

/** The nearest reach with an upstream area within `radiusM` of the click, or null. */
export async function nearestReach(db: Db, click: Position, radiusM = REACH_NEAR_M): Promise<NearReach | null> {
	const [r] = await reachesNear(db, click, radiusM);
	return r ?? null;
}
