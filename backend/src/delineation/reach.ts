// The river reach nearest a click, for its upstream area: the expected area
// the outlet is matched to (place.ts, issue #374). Read from river_reference
// (171), the operator's loaded network (HydroRIVERS, or the synthetic set);
// none loaded, or none within the radius, means no expected area and the
// plain snap with its larger-channel guard.
import type { Db } from '../db/tx.js';
import type { Position } from '../geo/geojson.js';
import { MATCH_RADIUS_M } from './place.js';

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

/** The line's distance from p (m): a LineString or a MultiLineString's coordinates. */
export function lineDistM(p: Position, coordinates: Position[] | Position[][]): number {
	const lines = (typeof coordinates[0]?.[0] === 'number' ? [coordinates] : coordinates) as Position[][];
	let best = Infinity;
	for (const line of lines) for (let i = 0; i + 1 < line.length; i++) best = Math.min(best, segmentDistM(p, line[i]!, line[i + 1]!));
	return best;
}

/** The nearest reach with an upstream area within `radiusM` of the click, or null. */
export async function nearestReach(db: Db, click: Position, radiusM = MATCH_RADIUS_M): Promise<NearReach | null> {
	const dLat = radiusM / 110950;
	const dLon = radiusM / (111320 * Math.cos((click[1] * Math.PI) / 180));
	// The bounding-box index (river_reference_bbox_idx) narrows it to the reaches whose box meets the click's.
	const { rows } = await db.query<{ dataset: string; reach_id: string; upstream_km2: number; geometry: { coordinates: Position[] | Position[][] } }>(
		`SELECT dataset, reach_id, upstream_km2, geometry FROM river_reference
		  WHERE upstream_km2 IS NOT NULL AND max_lon >= $1 AND min_lon <= $3 AND max_lat >= $2 AND min_lat <= $4
		  LIMIT 500`,
		[click[0] - dLon, click[1] - dLat, click[0] + dLon, click[1] + dLat]
	);
	let best: NearReach | null = null;
	for (const r of rows) {
		const d = lineDistM(click, r.geometry.coordinates);
		if (d <= radiusM && (!best || d < best.distanceM)) best = { dataset: r.dataset, reachId: Number(r.reach_id), upstreamKm2: r.upstream_km2, distanceM: d };
	}
	return best;
}
