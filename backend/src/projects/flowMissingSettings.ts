// settings.flowMissing and settings.checksKept against the project (engine ≥
// 1.102.0, issue #611, docs/model.md §2.10h, docs/api.md § Projects).
//
// The shape is settings.ts's zod (FlowMissing, ChecksKept). Here: the names
// against the database (checkFlowMissing, by PATCH /projects/:id when the save
// sends flowMissing): every record a flow record of this project, by its
// series id, read under the caller's RLS. As checkRainStations does, only the
// ids the stored setting doesn't already name are checked, so a record deleted
// since doesn't block a save of something else; the run then matches nothing.
//
// And the series ids every setting names (settingSeriesIds), so a copy or an
// export/import that gives the series fresh ids can make the settings follow
// them (remapSettingSeriesIds): the rainfall stations' (remapRainStations),
// each flow record's missing periods, and the kept data checks' item ids.
import { FLOW_RECORD_KINDS, parseCheckItemId } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { remapRainStations } from './rainStationSettings.js';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);


/**
 * Refuse (400) a flowMissing save that names a series that isn't a flow
 * record of this project. Null or {} passes. Only the ids `stored` doesn't
 * already name are checked (see the header).
 */
export async function checkFlowMissing(db: Db, projectId: string, flowMissing: unknown, stored?: unknown): Promise<void> {
	if (!isObj(flowMissing)) return;
	const ids = new Set(Object.keys(flowMissing));
	if (isObj(stored)) for (const id of Object.keys(stored)) ids.delete(id);
	if (!ids.size) return;
	const { rows } = await db.query<{ id: string }>(`SELECT id FROM time_series WHERE project_id = $1 AND id = ANY($2::uuid[]) AND kind = ANY($3::text[])`, [
		projectId,
		[...ids],
		[...FLOW_RECORD_KINDS]
	]);
	const found = new Set(rows.map((r) => r.id));
	if ([...ids].some((id) => !found.has(id))) throw new ApiError(400, 'flow missing periods: one names a series that is not a flow record of this project (a gauge, logger or reference flow series)');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every series id stored settings name (a uuid; anything else is no series): the rainfall stations', each flow record with missing periods, each kept data check's series. */
export function settingSeriesIds(settings: unknown): Set<string> {
	const out = new Set<string>();
	if (!isObj(settings)) return out;
	collect(settings, out);
	for (const id of out) if (!UUID.test(id)) out.delete(id);
	return out;
}

function collect(settings: Record<string, unknown>, out: Set<string>): void {
	const rs = settings.rainStations;
	if (isObj(rs)) {
		const add = (id: unknown) => typeof id === 'string' && out.add(id);
		for (const a of [rs.catchment, ...Object.values(isObj(rs.units) ? rs.units : {})]) if (isObj(a)) add(a.stationId), add(a.correctAgainst);
		for (const key of ['sites', 'unreliable', 'pinnedFactors'] as const) if (isObj(rs[key])) for (const id of Object.keys(rs[key] as object)) out.add(id);
	}
	if (isObj(settings.flowMissing)) for (const id of Object.keys(settings.flowMissing)) out.add(id);
	if (Array.isArray(settings.checksKept)) for (const item of settings.checksKept) {
		const ref = typeof item === 'string' ? parseCheckItemId(item) : null;
		if (ref) out.add(ref.seriesId);
	}
}

/**
 * Stored settings with every series id they name following `ids` (old →
 * new): settings.rainStations, settings.flowMissing's records and the series
 * in settings.checksKept's item ids. An id not in the map is left as it was
 * (the run then matches nothing, and a station warns).
 */
export function remapSettingSeriesIds(settings: Record<string, unknown>, ids: ReadonlyMap<string, string>): Record<string, unknown> {
	if (!ids.size) return settings;
	const out = { ...settings };
	if (isObj(out.rainStations)) out.rainStations = remapRainStations(out.rainStations, new Map(), ids);
	if (isObj(out.flowMissing)) out.flowMissing = Object.fromEntries(Object.entries(out.flowMissing).map(([id, list]) => [ids.get(id) ?? id, list]));
	if (Array.isArray(out.checksKept)) {
		out.checksKept = out.checksKept.map((item) => {
			const ref = typeof item === 'string' ? parseCheckItemId(item) : null;
			const to = ref ? ids.get(ref.seriesId) : undefined;
			return ref && to ? `${ref.check}:${to}:${ref.start}:${ref.end}` : item;
		});
	}
	return out;
}
