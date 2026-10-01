// A point → the quaternary catchment it lies in → the reference values the
// WR2012 check could use (issue #288 phase 2, WP-3.12; docs/maps.md §
// Quaternary lookup). This only *proposes*: the hydrologist accepts each
// value into Settings → WR2012 check, sees its source, and saves; nothing is
// written to the model here.
//
// The values come from quaternary_reference (152), which the operator loads
// from their own copy of the open DWS quaternary boundaries and the WR2012
// tables (`pnpm import:quaternaries`). The repo ships an invented dataset
// (region Z, `dataset: 'synthetic'`) for development and tests; a proposal
// from it says so.
import type { Db } from '../db/tx.js';
import { pointInGeometry, type Geometry, type Position } from './geojson.js';

export interface QuaternaryProposal {
	code: string;
	dataset: string;
	/** True for the repo's invented dataset: never real values. */
	synthetic: boolean;
	areaKm2: number | null;
	mapMm: number | null;
	marMm3: number | null;
	/** Oct … Sep, Mm³ per month. */
	monthlyMm3: number[] | null;
	periodStart: number | null;
	periodEnd: number | null;
	source: string;
	loadedAt: string;
}

interface Row {
	code: string;
	dataset: string;
	geometry: Geometry;
	area_km2: number | null;
	map_mm: number | null;
	mar_mm3: number | null;
	monthly_mm3: number[] | null;
	period_start: number | null;
	period_end: number | null;
	source: string;
	loaded_at: Date;
}

/** The label the committed fixture loads under; a proposal from it is marked synthetic. */
export const SYNTHETIC_DATASET = 'synthetic';

/**
 * The quaternary containing `point` (lon, lat), or null when none in the
 * loaded dataset does (or none is loaded). The bounding-box index narrows the
 * candidates; the polygon test decides. On a shared border (a point exactly
 * on it is in neither by ray casting) the first by code wins, so the answer
 * is stable.
 */
export async function quaternaryAt(db: Db, point: Position): Promise<QuaternaryProposal | null> {
	const { rows } = await db.query<Row>(
		`SELECT code, dataset, geometry, area_km2, map_mm, mar_mm3, monthly_mm3, period_start, period_end, source, loaded_at
		 FROM quaternary_reference
		 WHERE min_lon <= $1 AND max_lon >= $1 AND min_lat <= $2 AND max_lat >= $2
		 ORDER BY code`,
		[point[0], point[1]]
	);
	const hit = rows.find((r) => pointInGeometry(point, r.geometry));
	if (!hit) return null;
	return {
		code: hit.code,
		dataset: hit.dataset,
		synthetic: hit.dataset === SYNTHETIC_DATASET,
		areaKm2: hit.area_km2,
		mapMm: hit.map_mm,
		marMm3: hit.mar_mm3,
		monthlyMm3: hit.monthly_mm3,
		periodStart: hit.period_start,
		periodEnd: hit.period_end,
		source: hit.source,
		loadedAt: hit.loaded_at.toISOString()
	};
}

/** Whether any quaternary dataset is loaded, and which (for the panel's "no dataset loaded" state). */
export async function quaternaryDatasets(db: Db): Promise<{ dataset: string; count: number }[]> {
	const { rows } = await db.query<{ dataset: string; count: number }>(
		'SELECT dataset, count(*)::integer AS count FROM quaternary_reference GROUP BY dataset ORDER BY dataset'
	);
	return rows;
}
