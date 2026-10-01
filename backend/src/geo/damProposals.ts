// A dam on the map → the values the model's dam could take from it (issue
// #326 Part B, "B-dams"; docs/maps.md § Dams from the register and the map):
//
//  * from the register of dams (dam_register_reference, 154): the registered
//    dams within RADIUS_M of the dam's place on the map (a polygon's centroid,
//    or the point), nearest first, each with its capacity, wall height and
//    source;
//  * from the map: a dam polygon's full-supply area (map_feature.area_m2,
//    computed on the server, geo/area.ts).
//
// This only *proposes*. The modeller accepts one value at a time
// (geo/damRoutes.ts), and the acceptance is a model revision naming the
// source. The repo ships an invented register (`dataset: 'synthetic'`) for
// development and tests; a proposal from it says so.
import type { Db } from '../db/tx.js';
import { centerOf, type Geometry, type Position } from './geojson.js';

/** How far from the dam on the map a registered dam may be and still be proposed (m). */
export const RADIUS_M = 1000;
/** At most this many registered dams are proposed. */
export const MAX_PROPOSALS = 5;
/** The label the committed fixture loads under; a proposal from it is marked synthetic. */
export const SYNTHETIC_DAM_DATASET = 'synthetic';

/** WGS84 mean radius (m), for the great-circle distance. */
const MEAN_RADIUS_M = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance between two lon/lat positions, m (haversine on the mean sphere; well under 0.5 % off the ellipsoid's at these ranges). */
export function distanceM(a: Position, b: Position): number {
	const dLat = rad(b[1] - a[1]);
	const dLon = rad(b[0] - a[0]);
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
	return 2 * MEAN_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A lon/lat box that holds every point within `radiusM` of `p` (a little larger, never smaller). */
export function searchBox(p: Position, radiusM: number): { minLon: number; maxLon: number; minLat: number; maxLat: number } {
	const dLat = (radiusM / MEAN_RADIUS_M) * (180 / Math.PI) * 1.01;
	const cos = Math.max(Math.cos(rad(Math.min(89, Math.abs(p[1]) + dLat))), 1e-6);
	const dLon = Math.min(180, dLat / cos);
	return { minLon: p[0] - dLon, maxLon: p[0] + dLon, minLat: p[1] - dLat, maxLat: p[1] + dLat };
}

export interface RegisterDam {
	registerNo: string;
	name: string;
	river: string | null;
	farm: string | null;
	lon: number;
	lat: number;
	capacityM3: number | null;
	wallHeightM: number | null;
	surfaceAreaM2: number | null;
	completionYear: number | null;
	dataset: string;
	source: string;
	loadedAt: string;
}

export interface RegisterProposal extends RegisterDam {
	/** From the dam's place on the map, m. */
	distanceM: number;
	/** True for the repo's invented list: never real values. */
	synthetic: boolean;
}

/** The dams within `radiusM` of `p`, nearest first (ties by register number), at most `limit`. */
export function nearestDams(dams: readonly RegisterDam[], p: Position, radiusM = RADIUS_M, limit = MAX_PROPOSALS): RegisterProposal[] {
	return dams
		.map((d) => ({ ...d, distanceM: distanceM(p, [d.lon, d.lat]), synthetic: d.dataset === SYNTHETIC_DAM_DATASET }))
		.filter((d) => d.distanceM <= radiusM)
		.sort((a, b) => a.distanceM - b.distanceM || a.registerNo.localeCompare(b.registerNo))
		.slice(0, limit);
}

interface RegisterRow {
	register_no: string;
	dataset: string;
	name: string;
	river: string | null;
	farm: string | null;
	lon: number;
	lat: number;
	capacity_m3: number | null;
	wall_height_m: number | null;
	surface_area_m2: number | null;
	completion_year: number | null;
	source: string;
	loaded_at: Date;
}

/** The registered dams near `p` (the box narrows, the distance decides). */
export async function registerDamsNear(db: Db, p: Position, radiusM = RADIUS_M, limit = MAX_PROPOSALS): Promise<RegisterProposal[]> {
	const b = searchBox(p, radiusM);
	const { rows } = await db.query<RegisterRow>(
		`SELECT register_no, dataset, name, river, farm, lon, lat, capacity_m3, wall_height_m, surface_area_m2, completion_year, source, loaded_at
		 FROM dam_register_reference
		 WHERE lat BETWEEN $1 AND $2 AND lon BETWEEN $3 AND $4`,
		[b.minLat, b.maxLat, b.minLon, b.maxLon]
	);
	return nearestDams(
		rows.map((r) => ({
			registerNo: r.register_no,
			name: r.name,
			river: r.river,
			farm: r.farm,
			lon: r.lon,
			lat: r.lat,
			capacityM3: r.capacity_m3,
			wallHeightM: r.wall_height_m,
			surfaceAreaM2: r.surface_area_m2,
			completionYear: r.completion_year,
			dataset: r.dataset,
			source: r.source,
			loadedAt: r.loaded_at.toISOString()
		})),
		p,
		radiusM,
		limit
	);
}

/** Which register datasets are loaded, and how many dams each (for the panel's "no register loaded" state). */
export async function damRegisterDatasets(db: Db): Promise<{ dataset: string; count: number }[]> {
	const { rows } = await db.query<{ dataset: string; count: number }>(
		'SELECT dataset, count(*)::integer AS count FROM dam_register_reference GROUP BY dataset ORDER BY dataset'
	);
	return rows;
}

export interface DamOnMap {
	id: string;
	name: string;
	geometryType: Geometry['type'];
	/** Where the register is searched from: a polygon's centroid, or the point. */
	point: Position;
	/** A polygon's geodesic area, m²; null for a point. */
	areaM2: number | null;
}

/**
 * The dam on the map linked to a node: a polygon first (it has an area to
 * propose), then the earliest placed, so the answer is stable when a unit
 * has several.
 */
export async function damOnMap(db: Db, projectId: string, nodeId: string): Promise<DamOnMap | null> {
	const { rows } = await db.query<{ id: string; name: string; geometry: Geometry; area_m2: number | null }>(
		`SELECT id, name, geometry, area_m2 FROM map_feature
		 WHERE project_id = $1 AND node_id = $2 AND kind = 'dam'
		 ORDER BY area_m2 IS NULL, created_at, id
		 LIMIT 1`,
		[projectId, nodeId]
	);
	const f = rows[0];
	if (!f) return null;
	return { id: f.id, name: f.name, geometryType: f.geometry.type, point: centerOf(f.geometry), areaM2: f.area_m2 };
}

/** How a dam's name reads in a reason or a notice. */
export const damLabel = (f: { name: string }) => (f.name ? `“${f.name}”` : 'the dam on the map');
