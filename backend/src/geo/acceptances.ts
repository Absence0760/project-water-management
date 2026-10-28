// What each value accepted from the map was taken over (issue #646 item 4,
// the hydrologist's review F7 and F8; docs/maps.md § Checks): the polygon a
// unit's MAP, its rain feed's cells and a planted area from land cover were
// read over, and the boundary an evaporation row was summarised over, each as
// it stood then (`{ featureId, updatedAt, areaM2 }`, 273_acceptance_polygons).
// GET …/map/features returns them beside the features, so the Map's Checks
// and the Start data list can say that a value was taken over an outline
// redrawn since (frontend map/stale.ts). Read-only, under the caller's RLS
// (viewer: the same tables the Settings and Crops panels show).
import type { Db } from '../db/tx.js';

/** A polygon as it stood when a value was read over it. */
export interface PolygonStamp {
	featureId: string;
	updatedAt: string;
	areaM2: number;
}

/** Two areas of one polygon within this (m²) are one outline: a rename or relink bumps updated_at but not the area. */
export const OUTLINE_SLACK_M2 = 0.5;

/**
 * Whether the polygon a value was read over is another outline now: another feature, or the same one edited since
 * with another area. A rename or a relink (which bump updated_at) keeps the outline; so, rarely, would a redraw to
 * exactly the same area. The frontend's map/stale.ts holds the same rule.
 */
export const outlineChanged = (then: PolygonStamp, now: PolygonStamp): boolean =>
	then.featureId !== now.featureId || (then.updatedAt !== now.updatedAt && Math.abs(then.areaM2 - now.areaM2) > OUTLINE_SLACK_M2);

export interface MapAcceptances {
	/** Each unit whose MAP came from the grid since 273: the polygon it was taken over. */
	unitMap: { nodeId: string; polygon: PolygonStamp }[];
	/** Each unit's own CHIRPS feed (its config's `unit` mark, feeds/fromUnits.ts): the polygon its cells came from. */
	unitRain: { nodeId: string; featureId: string; updatedAt: string; areaKm2: number }[];
	/** Each planted area accepted from land cover since 273: the crop and the polygons summed. */
	landCover: { nodeId: string; cropId: string; cropName: string; polygons: PolygonStamp[] }[];
	/** Each evaporation row accepted from the map: its target and the boundary it was summarised over (null before 273). */
	evaporation: { target: 'pe' | 'apan'; boundary: PolygonStamp | null }[];
}

/** The project's acceptances from the map, each with what it was taken over. */
export async function mapAcceptances(db: Db, projectId: string): Promise<MapAcceptances> {
	// One after another: the transaction's client runs one query at a time.
	const unitMap = await db.query<{ nodeId: string; polygon: PolygonStamp }>(
		`SELECT id AS "nodeId", map_polygon AS polygon FROM node WHERE project_id = $1 AND map_polygon IS NOT NULL ORDER BY sort_order, id`,
		[projectId]
	);
	const unitRain = await db.query<{ nodeId: string; featureId: string; updatedAt: string; areaKm2: number }>(
		`SELECT config -> 'unit' ->> 'nodeId' AS "nodeId", config -> 'unit' ->> 'featureId' AS "featureId",
			config -> 'unit' ->> 'updatedAt' AS "updatedAt", (config -> 'unit' ->> 'areaKm2')::float8 AS "areaKm2"
		 FROM data_feed WHERE project_id = $1 AND source = 'chirps' AND jsonb_typeof(config -> 'unit') = 'object'
		 ORDER BY created_at, id`,
		[projectId]
	);
	const landCover = await db.query<{ nodeId: string; cropId: string; cropName: string; polygons: PolygonStamp[] }>(
		`SELECT p.node_id AS "nodeId", p.crop_id AS "cropId", c.name AS "cropName", p.polygons
		 FROM crop_area_land_cover p JOIN crop c ON c.id = p.crop_id
		 WHERE p.project_id = $1 AND p.polygons IS NOT NULL ORDER BY p.node_id, c.name, p.crop_id`,
		[projectId]
	);
	const evaporation = await db.query<{ target: 'pe' | 'apan'; boundary: PolygonStamp | null }>(
		`SELECT target, boundary FROM evaporation_accepted WHERE project_id = $1 ORDER BY target`,
		[projectId]
	);
	return {
		unitMap: unitMap.rows,
		// A mark the feed config check let through always has all four; one that doesn't is skipped, not guessed.
		unitRain: unitRain.rows.filter((r) => r.nodeId && r.featureId && r.updatedAt && Number.isFinite(r.areaKm2)),
		landCover: landCover.rows,
		evaporation: evaporation.rows
	};
}
