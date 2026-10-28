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
// boundary feed, a unit's feed) covers it. The station's record checks
// (§2.4c/§2.4d) read it, else the CHIRPS of the unit it stands in
// (settings.rainStations.sites). The pairing that corrects an area's CHIRPS
// reads the area's own CHIRPS, not the station's (engine ≥ 1.105.0, issue
// #612).
//
// Only when settings.rainStations assigns a station to the catchment or a
// unit, so every other project's input is exactly as before.
import {
	type DailySeries,
	type RainStationInputs,
	type RainStationSettings,
	seriesOrigin,
	stationChirpsSeriesKey,
	stationSeriesKey,
	unitRainSeriesKey
} from '@water-management/engine';
import type { Db } from '../db/tx.js';
import type { ChirpsDailyProduct } from '../feeds/config.js';
import { DEFAULT_CELL_PRODUCT, referenceCellSeries, seriesChirpsProduct } from './referenceCell.js';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The stations an assignment names: its own, the one correcting its CHIRPS (default the same) and its patch stations (issue #612). */
const named = (a: unknown): { stationId: string; correctAgainst: string; patch: string[] } | null => {
	if (!isObj(a) || typeof a.stationId !== 'string') return null;
	const patch = Array.isArray(a.patch) ? a.patch.flatMap((p) => (isObj(p) && p.source === 'station' && typeof p.stationId === 'string' ? [p.stationId] : [])) : [];
	return { stationId: a.stationId, correctAgainst: typeof a.correctAgainst === 'string' ? a.correctAgainst : a.stationId, patch };
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
 * The CHIRPS product a station's cell is read in: the product of the CHIRPS
 * series the run reads that the station's pairing corrects (its factors then
 * apply to the same product they were fitted on), taken from `runSeries`,
 * the series loadLiveInput already chose (the first by name per site, issue
 * #561), never from whichever feed came first: the first land unit it
 * corrects, by node id, whose own CHIRPS the run reads is CHIRPS v3, else
 * the catchment's (`rain_chirps_mm`) when the catchment is corrected against
 * it and that is CHIRPS v3, else the unit feeds' default.
 */
export function productFor(stationId: string, rs: RainStationSettings, runSeries: Readonly<Record<string, DailySeries | undefined>>): ChirpsDailyProduct {
	const units = isObj(rs.units) ? Object.keys(rs.units).sort() : [];
	for (const u of units) {
		if (named(rs.units![u])?.correctAgainst !== stationId) continue;
		const product = seriesChirpsProduct(runSeries[unitRainSeriesKey('rain_chirps_mm', u)]);
		if (product) return product;
	}
	if (named(rs.catchment)?.correctAgainst === stationId) {
		const product = seriesChirpsProduct(runSeries.rain_chirps_mm);
		if (product) return product;
	}
	return DEFAULT_CELL_PRODUCT;
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
	runSeries: Readonly<Record<string, DailySeries | undefined>>,
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
	// The CHIRPS at each named station's own cell, only for a station some assignment reads (its own area, a correction or
	// a patch), for its record checks.
	const wanted = new Set<string>();
	for (const a of [rs.catchment, ...(isObj(rs.units) ? Object.values(rs.units) : [])].map(named)) {
		if (a) for (const id of [a.stationId, a.correctAgainst, ...a.patch]) wanted.add(id);
	}
	const placed = rows.filter((r) => wanted.has(r.id) && r.station_lat !== null && r.station_lon !== null);
	for (const r of placed) {
		const cell = await referenceCellSeries(db, { lat: r.station_lat!, lon: r.station_lon!, product: productFor(r.id, rs, runSeries) }, today);
		if (cell) series[stationChirpsSeriesKey(r.id)] = cell;
	}
	return { series, stations };
}
