// settings.rainStations (issue #553, engine ≥ 1.91.0, docs/model.md §2.4i,
// docs/api.md § Projects): which rainfall station forces the catchment and
// each land unit, which station corrects each one's CHIRPS, the catchment's
// own MAP, where a station without coordinates reads its CHIRPS (the unit it
// stands in), and each station's unreliable periods. A station is named by
// its series id (a catchment rain series, `rain_catchment_mm` with no site,
// 239_rain_stations.sql), a unit by its node id.
//
// Two checks, as settings.unitRain and the calibration site have: the shape
// here (zod, on every save that sends it; pinnedFactors refused, the engine's
// own like unitRain's pinned factors), and the names against the database
// (checkRainStations, by PATCH /projects/:id when the save sends
// rainStations): every station a station of this project, every unit a land
// unit of it (a farm with an area). A stored setting that later loses a
// station or unit doesn't block other saves: the run warns about it (engine).
// Replaced whole on a patch (settings.ts REPLACED_WHOLE), so a unit left out
// is unassigned.
import { mapMmError, MAP_MM_MAX, MAP_MM_MIN, PE_SOURCE_MAX, isIsoDate, type RainStationSettings } from '@water-management/engine';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Most land units, stations or unreliable periods per station one setting may name. */
export const RAIN_STATION_UNITS_MAX = 500;
export const RAIN_STATIONS_MAX = 200;
export const RAIN_STATION_PERIODS_MAX = 200;

const stationId = z.string().uuid('a rainfall station is named by its series id');
const unitId = z.string().uuid('a land unit is named by its node id');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = z.string().superRefine((s, ctx) => {
	if (!ISO_DAY.test(s)) ctx.addIssue({ code: 'custom', message: 'a date is YYYY-MM-DD' });
	else if (!isIsoDate(s)) ctx.addIssue({ code: 'custom', message: 'not a calendar date' });
});
/** A record keyed by ids (zod's own key error says only "Invalid key in record"). */
const byId = <T extends z.ZodTypeAny>(value: T, what: 'station' | 'unit', max: number, noun: string) =>
	z.record(z.string(), value).superRefine((r, ctx) => {
		const keys = Object.keys(r);
		if (keys.some((k) => !UUID.test(k))) ctx.addIssue({ code: 'custom', message: what === 'station' ? 'a rainfall station is named by its series id' : 'a land unit is named by its node id' });
		if (keys.length > max) ctx.addIssue({ code: 'custom', message: `at most ${max} ${noun}` });
	});

/** One area's station (engine RainStationAssignment). */
const Assignment = z
	.object({
		stationId,
		scaleToMap: z.boolean().optional(),
		correctAgainst: stationId.nullable().optional()
	})
	.strict();

/**
 * The setting as a save sends it, or null to switch stations off (the rain
 * as before). pinnedFactors is the engine's own (a seasonal outlook member's,
 * a resumed run's) and never stored: a save that carries it is refused.
 */
export const RainStations = z
	.object({
		catchment: Assignment.nullable().optional(),
		units: byId(Assignment, 'unit', RAIN_STATION_UNITS_MAX, 'land units').nullable().optional(),
		catchmentMapMm: z.number().finite().min(MAP_MM_MIN).max(MAP_MM_MAX).nullable().optional(),
		catchmentMapSource: z.string().trim().max(PE_SOURCE_MAX).nullable().optional(),
		sites: byId(z.object({ unitId }).strict(), 'station', RAIN_STATIONS_MAX, 'stations').nullable().optional(),
		unreliable: byId(
			z.array(z.tuple([day, day])).max(RAIN_STATION_PERIODS_MAX, `at most ${RAIN_STATION_PERIODS_MAX} unreliable periods a station`),
			'station',
			RAIN_STATIONS_MAX,
			'stations'
		)
			.nullable()
			.optional(),
		pinnedFactors: z.unknown().optional()
	})
	.strict()
	.superRefine((v, ctx) => {
		if (v.pinnedFactors !== undefined) {
			ctx.addIssue({ code: 'custom', path: ['pinnedFactors'], message: 'rainfall stations: pinned factors are the engine’s own (a seasonal outlook member’s), never saved; leave them out' });
		}
		// The catchment's MAP as the engine reads it (mapMmError): a number in range with its source, or none. A blank source is none.
		const source = typeof v.catchmentMapSource === 'string' && v.catchmentMapSource ? v.catchmentMapSource : null;
		const map = v.catchmentMapMm ?? null;
		const err = map === null && source !== null ? 'a MAP source needs its MAP' : mapMmError(map, source);
		if (err) ctx.addIssue({ code: 'custom', path: ['catchmentMapMm'], message: `rainfall stations: the catchment’s ${err}` });
		for (const [id, periods] of Object.entries(v.unreliable ?? {})) {
			for (const [from, to] of periods) {
				// Only two real dates are compared (a malformed one has its own issue above).
				if (isIsoDate(from) && isIsoDate(to) && ISO_DAY.test(from) && ISO_DAY.test(to) && from > to) ctx.addIssue({ code: 'custom', path: ['unreliable', id], message: `rainfall stations: an unreliable period runs from ${from} to ${to}, which ends before it starts` });
			}
		}
	})
	.transform(({ pinnedFactors: _pinned, ...v }) => ({
		...v,
		...(v.catchmentMapSource !== undefined ? { catchmentMapSource: v.catchmentMapSource || null } : {})
	}));

/** Every station id and land unit id a setting names, with where it names it. */
function namesOf(rs: RainStationSettings): { stations: Map<string, string>; units: Map<string, string> } {
	const stations = new Map<string, string>();
	const units = new Map<string, string>();
	const station = (id: string | null | undefined, where: string) => {
		if (typeof id === 'string' && !stations.has(id)) stations.set(id, where);
	};
	if (rs.catchment) {
		station(rs.catchment.stationId, 'the catchment’s station');
		station(rs.catchment.correctAgainst, 'the station correcting the catchment’s CHIRPS');
	}
	for (const [unit, a] of Object.entries(rs.units ?? {})) {
		if (!units.has(unit)) units.set(unit, 'a unit given a station');
		station(a.stationId, 'a unit’s station');
		station(a.correctAgainst, 'the station correcting a unit’s CHIRPS');
	}
	for (const [id, site] of Object.entries(rs.sites ?? {})) {
		station(id, 'a station’s site');
		if (!units.has(site.unitId)) units.set(site.unitId, 'the unit a station stands in');
	}
	for (const id of Object.keys(rs.unreliable ?? {})) station(id, 'a station’s unreliable periods');
	return { stations, units };
}

/**
 * Refuse (400) a rainStations save whose stations aren't rainfall stations of
 * this project, or whose units aren't its land units, saying which and where.
 * Read under the caller's RLS (an editor's save). Null (stations off) passes.
 * Only the names `stored` (the setting as saved now) doesn't already name are
 * checked: the Settings form sends the whole setting on every save, so a
 * station deleted since (restorable under its id) or a unit removed from the
 * model must not block a save of some other field; the run warns about it.
 */
export async function checkRainStations(db: Db, projectId: string, rainStations: unknown, stored?: unknown): Promise<void> {
	if (!isObj(rainStations)) return;
	const { stations, units } = namesOf(rainStations as RainStationSettings);
	if (isObj(stored)) {
		const kept = namesOf(stored as RainStationSettings);
		for (const id of kept.stations.keys()) stations.delete(id);
		for (const id of kept.units.keys()) units.delete(id);
	}
	if (stations.size) {
		const { rows } = await db.query<{ id: string }>(
			`SELECT id FROM time_series WHERE project_id = $1 AND id = ANY($2::uuid[]) AND kind = 'rain_catchment_mm' AND site_node_id IS NULL`,
			[projectId, [...stations.keys()]]
		);
		const found = new Set(rows.map((r) => r.id));
		const missing = [...stations].find(([id]) => !found.has(id));
		if (missing) throw new ApiError(400, `rainfall stations: ${missing[1]} is not a rainfall station of this project (a catchment rainfall series with no unit)`);
	}
	if (units.size) {
		const { rows } = await db.query<{ id: string }>(`SELECT id::text FROM node WHERE project_id = $1 AND id = ANY($2::uuid[]) AND kind = 'farm' AND area_km2 > 0`, [
			projectId,
			[...units.keys()]
		]);
		const found = new Set(rows.map((r) => r.id));
		const missing = [...units].find(([id]) => !found.has(id));
		if (missing) throw new ApiError(400, `rainfall stations: ${missing[1]} is not a land unit of this project (a farm with an area)`);
	}
}

/**
 * settings.rainStations with its node ids following a copy's or an import's
 * fresh ones (settings.ts remapSettingNodeIds): the units' keys and each
 * site's unit. With `stationIds`, its station ids follow too (a copy's new
 * series). An id not in a map is left as it was (the run then warns).
 */
export function remapRainStations(raw: unknown, nodeIds: ReadonlyMap<string, string>, stationIds?: ReadonlyMap<string, string>): unknown {
	if (!isObj(raw)) return raw;
	const n = (id: string) => nodeIds.get(id) ?? id;
	const s = (id: unknown) => (typeof id === 'string' ? (stationIds?.get(id) ?? id) : id);
	const assignment = (a: unknown) =>
		isObj(a) ? { ...a, stationId: s(a.stationId), ...(typeof a.correctAgainst === 'string' ? { correctAgainst: s(a.correctAgainst) } : {}) } : a;
	const byStation = (rec: unknown, value: (v: unknown) => unknown = (v) => v) =>
		isObj(rec) ? Object.fromEntries(Object.entries(rec).map(([k, v]) => [s(k) as string, value(v)])) : rec;
	const out: Record<string, unknown> = { ...raw };
	if (raw.catchment !== undefined) out.catchment = assignment(raw.catchment);
	if (isObj(raw.units)) out.units = Object.fromEntries(Object.entries(raw.units).map(([k, v]) => [n(k), assignment(v)]));
	if (raw.sites !== undefined) out.sites = byStation(raw.sites, (v) => (isObj(v) && typeof v.unitId === 'string' ? { ...v, unitId: n(v.unitId) } : v));
	if (raw.unreliable !== undefined) out.unreliable = byStation(raw.unreliable);
	if (raw.pinnedFactors !== undefined) out.pinnedFactors = byStation(raw.pinnedFactors);
	return out;
}
