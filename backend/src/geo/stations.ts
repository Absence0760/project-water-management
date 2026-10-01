// The nearest gauging stations to a point, proposed as a catchment's
// observed-flow source (issue #326 Part B, "B-gauge"; docs/maps.md §
// Gauging stations). This only *proposes*: the modeller picks a station in
// Settings → Data feeds, which fills the DWS feed's station field; they still
// attach the feed themselves. Nothing is written here.
//
// The stations come from gauge_station_reference (153), which the operator
// loads (`pnpm import:gauge-stations`). The repo ships an invented dataset
// (region Z, `dataset: 'synthetic'`); a proposal from it says so.
import type { Db } from '../db/tx.js';
import { centerOf, type Geometry, type Position } from './geojson.js';

/** The label the committed fixture loads under; a proposal from it is marked synthetic. */
export const SYNTHETIC_STATIONS = 'synthetic';
/** The default and largest search radius, km. */
export const STATIONS_WITHIN_KM = 50;
export const STATIONS_WITHIN_MAX_KM = 200;
/** The most stations one proposal lists. */
export const STATIONS_LIMIT = 10;
/** A DWS river gauge (an H code): the only kind the DWS feed reads (feeds/config.ts DWS_RIVER_GAUGE). */
export const RIVER_GAUGE = /^[A-Z]\d[H]\d{3}$/;

/** The mean Earth radius (IUGG), km. */
const EARTH_KM = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;

/** The great-circle distance between two lon/lat points, km (haversine, on a sphere: within 0.5 % of the ellipsoid, plenty for "nearest"). */
export function haversineKm(a: Position, b: Position): number {
	const dLat = rad(b[1] - a[1]);
	const dLon = rad(b[0] - a[0]);
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
	return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A lon/lat box that holds every point within `km` of `p` (the index's first pass; generous near the poles). */
export function boxAround(p: Position, km: number): { minLon: number; maxLon: number; minLat: number; maxLat: number } {
	const dLat = km / 110.574;
	const cos = Math.cos(rad(Math.min(89, Math.abs(p[1]) + dLat)));
	const dLon = Math.min(180, km / (111.32 * Math.max(cos, 1e-6)));
	return { minLon: p[0] - dLon, maxLon: p[0] + dLon, minLat: p[1] - dLat, maxLat: p[1] + dLat };
}

/** Whole years a record spans (to one decimal), or null when a date is missing. An open record (no end) runs to `today`. */
export function recordYears(start: string | null, end: string | null, today: string): number | null {
	if (!start) return null;
	const days = (Date.parse(end ?? today) - Date.parse(start)) / 86_400_000;
	return Number.isFinite(days) && days >= 0 ? Math.round((days / 365.25) * 10) / 10 : null;
}

export interface StationCandidate {
	code: string;
	name: string;
	river: string;
	lon: number;
	lat: number;
	catchmentKm2: number | null;
	recordStart: string | null;
	recordEnd: string | null;
	dataset: string;
	source: string;
}

export interface StationProposal extends StationCandidate {
	distanceKm: number;
	recordYears: number | null;
	/** True for the repo's invented dataset: never a real station. */
	synthetic: boolean;
}

/**
 * The river gauges within `withinKm` of `point`, nearest first (ties by
 * code, so the order is stable), at most `limit`. Reservoirs and other
 * station types are left out: the DWS feed reads river gauges only.
 */
export function rankStations(point: Position, candidates: readonly StationCandidate[], withinKm: number, today: string, limit = STATIONS_LIMIT): StationProposal[] {
	return candidates
		.filter((s) => RIVER_GAUGE.test(s.code))
		.map((s) => ({
			...s,
			distanceKm: Math.round(haversineKm(point, [s.lon, s.lat]) * 100) / 100,
			recordYears: recordYears(s.recordStart, s.recordEnd, today),
			synthetic: s.dataset === SYNTHETIC_STATIONS
		}))
		.filter((s) => s.distanceKm <= withinKm)
		.sort((a, b) => a.distanceKm - b.distanceKm || a.code.localeCompare(b.code))
		.slice(0, limit);
}

interface Row {
	code: string;
	name: string;
	river: string;
	lon: number;
	lat: number;
	catchment_km2: number | null;
	record_start: string | null;
	record_end: string | null;
	dataset: string;
	source: string;
}

/** The nearest river gauges to `point` in the loaded dataset(s). */
export async function nearestStations(db: Db, point: Position, withinKm: number): Promise<StationProposal[]> {
	const b = boxAround(point, withinKm);
	const { rows } = await db.query<Row>(
		`SELECT code, name, river, lon, lat, catchment_km2, record_start::text AS record_start, record_end::text AS record_end, dataset, source
		 FROM gauge_station_reference
		 WHERE lat BETWEEN $1 AND $2 AND lon BETWEEN $3 AND $4`,
		[b.minLat, b.maxLat, b.minLon, b.maxLon]
	);
	const today = new Date().toISOString().slice(0, 10);
	return rankStations(
		point,
		rows.map((r) => ({
			code: r.code,
			name: r.name,
			river: r.river,
			lon: r.lon,
			lat: r.lat,
			catchmentKm2: r.catchment_km2,
			recordStart: r.record_start,
			recordEnd: r.record_end,
			dataset: r.dataset,
			source: r.source
		})),
		withinKm,
		today
	);
}

/** Which station datasets are loaded, and how many stations each (the panel's "none loaded" state). */
export async function stationDatasets(db: Db): Promise<{ dataset: string; count: number }[]> {
	const { rows } = await db.query<{ dataset: string; count: number }>(
		'SELECT dataset, count(*)::integer AS count FROM gauge_station_reference GROUP BY dataset ORDER BY dataset'
	);
	return rows;
}

export type OutletFrom = 'outlet_gauge' | 'boundary_centre';

/**
 * Where the catchment's outlet is on the map, by this rule: the point of the
 * map gauge linked to the model's outflow gauge (the node that drains into
 * nothing), else the centre (area centroid) of the catchment boundary, else
 * nothing. The map has no elevations, so "the boundary's lowest point" can't
 * be told; the centre is a stand-in, and the panel says which was used.
 * Reads through the caller's RLS (a viewer sees both).
 */
export async function outletPoint(db: Db, projectId: string): Promise<{ point: Position; from: OutletFrom; name: string } | null> {
	const { rows: gauge } = await db.query<{ geometry: Geometry; name: string }>(
		`SELECT f.geometry, f.name FROM map_feature f JOIN node n ON n.id = f.node_id AND n.project_id = f.project_id
		 WHERE f.project_id = $1 AND f.kind = 'gauge' AND n.kind = 'gauge' AND n.downstream_node_id IS NULL
		 ORDER BY f.created_at, f.id LIMIT 1`,
		[projectId]
	);
	if (gauge[0]) return { point: centerOf(gauge[0].geometry), from: 'outlet_gauge', name: gauge[0].name };
	const { rows: boundary } = await db.query<{ geometry: Geometry; name: string }>(
		`SELECT geometry, name FROM map_feature WHERE project_id = $1 AND kind = 'catchment_boundary' LIMIT 1`,
		[projectId]
	);
	if (boundary[0]) return { point: centerOf(boundary[0].geometry), from: 'boundary_centre', name: boundary[0].name };
	return null;
}
