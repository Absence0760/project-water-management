// A rainfall station's details on a series (issue #553, 239_rain_stations.sql):
// a station is a catchment rain series (`rain_catchment_mm`, no site) with its
// own MAP (mm) and where that came from, and optionally its coordinates. One
// rule for every path that writes them: PATCH …/series/:seriesId, an upload
// that creates the series (PUT …/series, POST …/series/merge; series/routes.ts)
// and a project document's import (projects/import.ts). The checks are the
// engine's (rainStationError), the database CHECKs the same again.
import { rainStationError, type RainStationMeta } from '@water-management/engine';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { recordAudit } from '../history/record.js';
import { ApiError } from '../http/errors.js';
import { SERIES_META as META, stationSql, type SeriesMetaRow } from './merge.js';

/** The one kind a station is. */
export const STATION_KIND = 'rain_catchment_mm';

/** Why a series of `kind` at `siteNodeId` can't carry station details, or null when it can. */
export function stationProblem(kind: string, siteNodeId: string | null): string | null {
	if (kind !== STATION_KIND) return 'only a catchment rainfall series (rain_catchment_mm) is a rainfall station';
	if (siteNodeId !== null) return 'a rainfall station is the project’s, not one unit’s: clear the series’ unit first';
	return null;
}

/** Nothing recorded: the series is no station. */
const isEmpty = (s: RainStationMeta) => s.mapMm === null && s.mapSource === null && s.lat === null && s.lon === null;

/**
 * `station` in a request: `{ mapMm, mapSource, lat, lon }` (each null = not
 * recorded; a missing field is null), or null to clear. absent = not said.
 * All four null reads as null. The MAP source is trimmed.
 */
export const StationField = z
	.object({
		mapMm: z.number().nullable().optional(),
		mapSource: z
			.string()
			.nullable()
			.optional()
			.transform((v) => (typeof v === 'string' ? v.trim() || null : (v ?? null))),
		lat: z.number().nullable().optional(),
		lon: z.number().nullable().optional()
	})
	.strict()
	.transform((s): RainStationMeta => ({ mapMm: s.mapMm ?? null, mapSource: s.mapSource ?? null, lat: s.lat ?? null, lon: s.lon ?? null }))
	.superRefine((s, ctx) => {
		const err = s.mapMm === null && s.mapSource !== null ? 'a MAP source needs its MAP' : rainStationError(s);
		if (err) ctx.addIssue({ code: 'custom', message: err });
	})
	.transform((s) => (isEmpty(s) ? null : s))
	.nullable()
	.optional();

/** A station as the audit line says it. */
export function stationLabel(s: RainStationMeta | null): string {
	if (!s) return 'not a station';
	const parts = [s.mapMm !== null ? `MAP ${s.mapMm} mm${s.mapSource ? ` (${s.mapSource})` : ''}` : 'no MAP'];
	if (s.lat !== null && s.lon !== null) parts.push(`at ${s.lat}, ${s.lon}`);
	return parts.join(' ');
}

const same = (a: RainStationMeta | null, b: RainStationMeta | null) =>
	a === b || (!!a && !!b && a.mapMm === b.mapMm && a.mapSource === b.mapSource && a.lat === b.lat && a.lon === b.lon);

/**
 * Record (or clear, null) a series' station details. 404 for no such series;
 * 400 for a series that can't be a station (stationProblem) unless it is
 * clearing. Logged as series.labelled with `station: { from, to }` when it
 * changes; returns the meta as it now stands.
 */
export async function setStation(db: Db, projectId: string, seriesId: string, station: RainStationMeta | null): Promise<SeriesMetaRow> {
	const { rows: cur } = await db.query<{ kind: string; name: string; siteNodeId: string | null; station: RainStationMeta | null }>(
		`SELECT kind, name, site_node_id AS "siteNodeId", ${stationSql('time_series')} AS station
		 FROM time_series WHERE project_id = $1 AND id = $2 FOR UPDATE`,
		[projectId, seriesId]
	);
	const was = cur[0];
	if (!was) throw new ApiError(404, 'not found');
	if (station !== null) {
		const problem = stationProblem(was.kind, was.siteNodeId);
		if (problem) throw new ApiError(400, `station: ${problem}`);
	}
	const { rows } = await db.query<SeriesMetaRow>(
		`UPDATE time_series SET station_map_mm = $3, station_map_source = $4, station_lat = $5, station_lon = $6
		 WHERE project_id = $1 AND id = $2 RETURNING ${META}`,
		[projectId, seriesId, station?.mapMm ?? null, station?.mapSource ?? null, station?.lat ?? null, station?.lon ?? null]
	);
	if (!same(was.station, station)) {
		await recordAudit(db, projectId, 'series.labelled', {
			seriesId,
			kind: was.kind,
			name: was.name,
			station: { from: stationLabel(was.station), to: stationLabel(station) }
		});
	}
	return rows[0]!;
}
