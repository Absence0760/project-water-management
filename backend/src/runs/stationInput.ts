// The rainfall stations a run reads (issue #553, engine ≥ 1.91.0,
// docs/model.md §2.4i, docs/data-model.md § Rainfall stations): every station
// of the project (a catchment rain series, `rain_catchment_mm` with no site,
// 239_rain_stations.sql) under `rain_station_mm#<series id>` (engine
// stationSeriesKey) with its name and details in ModelInput.stations, and the
// CHIRPS at each station's own 0.05° cell (`rain_chirps_station_mm#<id>`,
// stationChirpsSeriesKey) when the station has coordinates and the shared
// CHIRPS cell cache holds that cell (runs/referenceCell.ts reads it, as it
// does the reference gauge's cell). Nothing fetches a station's cell on its
// own: the cache holds it when a feed of any project (the catchment's
// boundary feed, a unit's feed) covers it. Without it the engine pairs the
// station against the CHIRPS of the unit it stands in (settings.rainStations
// .sites) and refuses the pairing when it has neither.
//
// Only when settings.rainStations assigns a station to the catchment or a
// unit, so every other project's input is exactly as before.
import {
	type DailySeries,
	type RainStationInputs,
	type RainStationSettings,
	seriesOrigin,
	stationChirpsSeriesKey,
	stationSeriesKey
} from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { chirpsProduct, type ChirpsDailyProduct, type FeedConfig } from '../feeds/config.js';
import { referenceCellSeries } from './referenceCell.js';

/** The product a unit feed reads unless told otherwise (as referenceCell.ts's DEFAULT_PRODUCT). */
const DEFAULT_PRODUCT: ChirpsDailyProduct = 'rnl';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The stations an assignment names: its own and the one correcting its CHIRPS (default the same). */
const named = (a: unknown): { stationId: string; correctAgainst: string } | null => {
	if (!isObj(a) || typeof a.stationId !== 'string') return null;
	return { stationId: a.stationId, correctAgainst: typeof a.correctAgainst === 'string' ? a.correctAgainst : a.stationId };
};

/**
 * True when settings.rainStations assigns a station to the catchment or to
 * any land unit: only then does a run read stations (engine ≥ 1.91.0).
 */
export function assignsStations(rainStations: unknown): rainStations is RainStationSettings {
	if (!isObj(rainStations)) return false;
	if (named(rainStations.catchment)) return true;
	return isObj(rainStations.units) && Object.values(rainStations.units).some((a) => named(a) !== null);
}

interface StationRow {
	id: string;
	name: string;
	start_date: string;
	values: (number | null)[];
	product: string | null;
	product_version: string | null;
	source: string | null;
	source_unit: string | null;
	source_unit_factor: number | null;
	station_map_mm: number | null;
	station_map_source: string | null;
	station_lat: number | null;
	station_lon: number | null;
}

/**
 * The CHIRPS product a station's cell is read in: the product of the feed
 * whose CHIRPS the station's pairing corrects (its factors then apply to the
 * same product they were fitted on): the first land unit it corrects, by node
 * id, that has its own feed, else the catchment's feed (one with no unit) when
 * the catchment is corrected against it, else the unit feeds' default.
 */
function productFor(stationId: string, rs: RainStationSettings, unitProduct: Map<string, ChirpsDailyProduct>, catchmentProduct: ChirpsDailyProduct | null): ChirpsDailyProduct {
	const units = isObj(rs.units) ? Object.keys(rs.units).sort() : [];
	for (const u of units) {
		const a = named(rs.units![u]);
		if (a?.correctAgainst === stationId && unitProduct.has(u)) return unitProduct.get(u)!;
	}
	if (named(rs.catchment)?.correctAgainst === stationId && catchmentProduct) return catchmentProduct;
	return DEFAULT_PRODUCT;
}

/**
 * The stations' input for a run under settings.rainStations, or null when it
 * assigns none (the input is then as before). `series`: each station's
 * record (stationSeriesKey) and, for a station an assignment names that has
 * coordinates and a cached cell, the CHIRPS at its cell
 * (stationChirpsSeriesKey). `stations`: every station's name, MAP and its
 * source, and place, and `isCatchmentGauge` on the one whose series is the
 * run's `rain_catchment_mm` (`catchmentGaugeId`). A setting that names a station since deleted finds
 * nothing here and the engine warns; the input is still built. Read under the
 * caller's RLS, like the rest of the input.
 */
export async function stationInputs(
	db: Db,
	projectId: string,
	rainStations: unknown,
	catchmentGaugeId: string | null,
	today?: string
): Promise<{ series: Record<string, DailySeries>; stations: RainStationInputs } | null> {
	if (!assignsStations(rainStations)) return null;
	const rs = rainStations;
	const { rows } = await db.query<StationRow>(
		`SELECT id, name, start_date, "values", product, product_version, source, source_unit, source_unit_factor,
			station_map_mm, station_map_source, station_lat, station_lon
		 FROM time_series WHERE project_id = $1 AND kind = 'rain_catchment_mm' AND site_node_id IS NULL
		 ORDER BY name COLLATE "C", id`,
		[projectId]
	);
	const series: Record<string, DailySeries> = {};
	const stations: RainStationInputs = {};
	for (const r of rows) {
		const provenance = r.product !== null && r.product_version !== null ? { product: r.product, version: r.product_version } : null;
		const origin = seriesOrigin({ source: r.source, sourceUnit: r.source_unit, sourceUnitFactor: r.source_unit_factor });
		series[stationSeriesKey(r.id)] = { startDate: r.start_date, values: r.values, provenance, origin };
		stations[r.id] = {
			name: r.name,
			mapMm: r.station_map_mm,
			mapSource: r.station_map_source,
			lat: r.station_lat,
			lon: r.station_lon,
			// The station whose series the run reads as `rain_catchment_mm` (loadLiveInput's first unsited one by name).
			...(r.id === catchmentGaugeId ? { isCatchmentGauge: true } : {})
		};
	}
	// The CHIRPS at each named station's own cell, only for a station some assignment reads (its own area or a correction).
	const wanted = new Set<string>();
	for (const a of [rs.catchment, ...(isObj(rs.units) ? Object.values(rs.units) : [])].map(named)) {
		if (a) wanted.add(a.stationId).add(a.correctAgainst);
	}
	const placed = rows.filter((r) => wanted.has(r.id) && r.station_lat !== null && r.station_lon !== null);
	if (placed.length) {
		const { rows: feeds } = await db.query<{ config: FeedConfig; unit: string | null }>(
			`SELECT config, config->'unit'->>'nodeId' AS unit FROM data_feed WHERE project_id = $1 AND source = 'chirps' ORDER BY created_at, id`,
			[projectId]
		);
		const unitProduct = new Map<string, ChirpsDailyProduct>();
		let catchmentProduct: ChirpsDailyProduct | null = null;
		for (const f of feeds) {
			if (f.unit === null) catchmentProduct ??= chirpsProduct(f.config);
			else if (!unitProduct.has(f.unit)) unitProduct.set(f.unit, chirpsProduct(f.config));
		}
		for (const r of placed) {
			const cell = await referenceCellSeries(db, { lat: r.station_lat!, lon: r.station_lon!, product: productFor(r.id, rs, unitProduct, catchmentProduct) }, today);
			if (cell) series[stationChirpsSeriesKey(r.id)] = cell;
		}
	}
	return { series, stations };
}
