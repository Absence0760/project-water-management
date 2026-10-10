// The CHIRPS cell a reference gauge is compared with (engine ≥ 1.80.0,
// issue #500, docs/model.md §2.4h *Reference gauge*): the single 0.05° cell
// holding the centre of the reference unit's parcel, read from the shared
// CHIRPS cell cache (208_chirps_cell_cache.sql) as a one-cell feed would write
// it. A run's input carries it as `rain_chirps_cell_mm@<unit id>` (engine
// referenceCellSeriesKey); it is not a stored series, so the run's input
// snapshot (run_input_series, series_id null) is what keeps it.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { type DailySeries, referenceCellSeriesKey, type UnitRainSettings } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { centerOf } from '../geo/geojson.js';
import { chcCell, seriesFromCache } from '../feeds/cellCache.js';
import { cacheOrigin, readCellCache } from '../feeds/cellCacheStore.js';
import { CHIRPS_PRODUCT_FIRST_DAY, chirpsProduct, type ChirpsDailyProduct, type FeedConfig } from '../feeds/config.js';
import type { Geometry } from '../geo/geojson.js';

/** The product a unit feed reads unless told otherwise (feeds/fromUnits.ts DEFAULT_UNIT_PRODUCT, not imported: that module carries the routes). */
const DEFAULT_PRODUCT: ChirpsDailyProduct = 'rnl';

/** Where the reference cell is: the reference unit's centre (lon, lat) and the product its own feed reads. */
export interface ReferenceCell {
	unitId: string;
	lat: number;
	lon: number;
	product: ChirpsDailyProduct;
}

/**
 * The reference cell of a project's settings.unitRain, or null: per-unit rain
 * off, no reference, or a reference unit with no single parcel on the map
 * (the engine then warns that it has no cell series and fits nothing).
 */
export async function referenceCell(db: Db, projectId: string, unitRain: UnitRainSettings | null | undefined): Promise<ReferenceCell | null> {
	const ref = unitRain?.mode === 'perUnit' ? unitRain.reference : null;
	if (!ref || typeof ref.unitId !== 'string') return null;
	// The unit's polygon as the unit feeds pick it (fromUnits.ts unitParcel): the parcel its area came from, else its only parcel.
	const { rows } = await db.query<{ geometry: Geometry }>(
		`SELECT f.geometry FROM node n JOIN map_feature f ON f.project_id = n.project_id AND f.node_id = n.id AND f.kind = 'farm_parcel'
		 WHERE n.project_id = $1 AND n.id::text = $2 AND n.kind = 'farm' AND n.area_km2 > 0
		   AND (f.id = n.area_feature_id OR (SELECT count(*) FROM map_feature g WHERE g.project_id = n.project_id AND g.node_id = n.id AND g.kind = 'farm_parcel') = 1)
		 ORDER BY (f.id = n.area_feature_id) DESC NULLS LAST LIMIT 1`,
		[projectId, ref.unitId]
	);
	if (!rows[0]) return null;
	const [lon, lat] = centerOf(rows[0].geometry);
	// The product of the unit's own CHIRPS feed (the cells it caches), else the unit feeds' default.
	const { rows: feeds } = await db.query<{ config: FeedConfig }>(
		`SELECT config FROM data_feed WHERE project_id = $1 AND source = 'chirps' AND config->'unit'->>'nodeId' = $2 ORDER BY created_at, id LIMIT 1`,
		[projectId, ref.unitId]
	);
	return { unitId: ref.unitId, lat: lat!, lon: lon!, product: feeds[0] ? chirpsProduct(feeds[0].config) : DEFAULT_PRODUCT };
}

/**
 * The reference cell's daily CHIRPS from the cache, from the product's first
 * day to today (leading and trailing days the cache lacks left out); null
 * when the cache holds none of it, or the cell has no data (the sea).
 */
export async function referenceCellSeries(db: Db, cell: ReferenceCell, today = new Date().toISOString().slice(0, 10)): Promise<DailySeries | null> {
	let grid;
	try {
		grid = chcCell(cell.lat, cell.lon);
	} catch {
		return null;
	}
	const window = { start: CHIRPS_PRODUCT_FIRST_DAY[cell.product], end: today };
	const view = await readCellCache(db, cacheOrigin(), cell.product, [grid], window);
	if (!view.size) return null;
	let days;
	try {
		days = seriesFromCache([{ lat: cell.lat, lon: cell.lon, weight: 1 }], view, window);
	} catch {
		// A sea cell (no data): nothing to compare a gauge with.
		return null;
	}
	const first = days.values.findIndex((v) => v !== null);
	if (first < 0) return null;
	return { startDate: fromEpochDay(toEpochDay(days.startDate) + first), values: days.values.slice(first) };
}

/** The input series key and values of a project's reference cell, or null. */
export async function referenceCellInput(db: Db, projectId: string, unitRain: UnitRainSettings | null | undefined): Promise<{ key: string; series: DailySeries } | null> {
	const cell = await referenceCell(db, projectId, unitRain);
	if (!cell) return null;
	const series = await referenceCellSeries(db, cell);
	return series ? { key: referenceCellSeriesKey(cell.unitId), series } : null;
}
