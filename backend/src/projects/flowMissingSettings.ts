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
		for (const a of [rs.catchment, ...Object.values(isObj(rs.units) ? rs.units : {})])
			if (isObj(a)) {
				add(a.stationId), add(a.correctAgainst);
				// A patching priority's stations (issue #612).
				if (Array.isArray(a.patch)) for (const p of a.patch) if (isObj(p)) add(p.stationId);
			}
		for (const key of ['sites', 'unreliable'] as const) if (isObj(rs[key])) for (const id of Object.keys(rs[key] as object)) out.add(id);
		// pinnedFactors' keys are `<station>|<area>` since engine 1.105.0 (a station id alone before).
		if (isObj(rs.pinnedFactors)) for (const k of Object.keys(rs.pinnedFactors)) out.add(k.split('|')[0]!);
	}
	if (isObj(settings.flowMissing)) for (const id of Object.keys(settings.flowMissing)) out.add(id);
	// Each fit record's own (engine ≥ 1.102.0): the series it was fitted to, and the kept checks it ran on. The outlet's, and
	// each calibration location's row's (issues #555, #659).
	for (const fr of fitRecordsOf(settings)) {
		if (typeof fr.flowSeriesId === 'string') out.add(fr.flowSeriesId);
		collectKept(fr.checksKept, out);
	}
	collectKept(settings.checksKept, out);
}

/** The settings' fit records: the top level's, then each calibration location row's. */
function fitRecordsOf(settings: Record<string, unknown>): Record<string, unknown>[] {
	const rows = Array.isArray(settings.calibrationZones) ? settings.calibrationZones : [];
	return [settings.fitRecord, ...rows.map((z: unknown) => (isObj(z) ? z.fitRecord : null))].filter(isObj);
}

function collectKept(list: unknown, out: Set<string>): void {
	if (!Array.isArray(list)) return;
	for (const item of list) {
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
	const kept = (list: unknown[]) =>
		list.map((item) => {
			const ref = typeof item === 'string' ? parseCheckItemId(item) : null;
			const to = ref ? ids.get(ref.seriesId) : undefined;
			return ref && to ? `${ref.check}:${to}:${ref.start}:${ref.end}` : item;
		});
	if (Array.isArray(out.checksKept)) out.checksKept = kept(out.checksKept);
	// The fit record names its series too (engine ≥ 1.102.0), so a copy's fit stays current with the copy's ids; so does each
	// calibration location row's (issues #555, #659).
	const remapFit = (r: Record<string, unknown>): Record<string, unknown> => {
		const fr: Record<string, unknown> = { ...r };
		if (typeof fr.flowSeriesId === 'string' && ids.has(fr.flowSeriesId)) fr.flowSeriesId = ids.get(fr.flowSeriesId);
		if (Array.isArray(fr.checksKept)) fr.checksKept = (kept(fr.checksKept) as string[]).sort();
		if (isObj(fr.flowMissing)) fr.flowMissing = Object.fromEntries(Object.entries(fr.flowMissing).map(([id, l]) => [ids.get(id) ?? id, l]));
		return fr;
	};
	if (isObj(out.fitRecord)) out.fitRecord = remapFit(out.fitRecord);
	if (Array.isArray(out.calibrationZones))
		out.calibrationZones = out.calibrationZones.map((z: unknown) => (isObj(z) && isObj(z.fitRecord) ? { ...z, fitRecord: remapFit(z.fitRecord) } : z));
	return out;
}
