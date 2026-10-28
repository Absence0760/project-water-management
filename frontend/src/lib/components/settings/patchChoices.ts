// Whether each rainfall station can patch a unit's main station (issue #612, docs/ui.md § Model settings): the
// engine's stationPatchChoices over the input a run would read (GET /projects/:id/model-input), for the Per unit
// table's patching pull-downs. The stored input holds the stations' records only once the saved setting assigns one,
// and the form is often ahead of it, so any station the input lacks is read from its series (GET …/series/:id) and
// added as a run would add it (its record, name and MAP; without its CHIRPS cell, so its checks compare it with the
// catchment's CHIRPS). Loaded on demand (FlowGenerationUnits imports it when a unit has a station), so the engine's
// run preparation stays out of the Settings chunk. One input and one preparation per Settings visit and set of
// stations: `forgetPatchChoices` drops them when the table mounts again.
import { prepareRun, stationPatchChoices, stationSeriesKey, type ModelInput, type PreparedRun, type RainStationInputs, type SeriesMeta } from '@water-management/engine';
import { api } from '#lib/api/index.js';
import type { PatchUsability } from './flowGeneration';

type Fetchers = {
	modelInput: (projectId: string) => Promise<ModelInput>;
	series: (projectId: string, seriesId: string) => Promise<Pick<SeriesMeta, 'name' | 'startDate' | 'station'> & { values: (number | null)[] }>;
};
const API: Fetchers = { modelInput: (id) => api.runs.modelInput(id), series: (id, sid) => api.series.get(id, sid) };

const held = new Map<string, Promise<{ input: ModelInput; prep: PreparedRun }>>();

/** Drop a project's held inputs (the table mounted again: the series or the model may have changed since). */
export function forgetPatchChoices(projectId: string): void {
	for (const k of [...held.keys()]) if (k.startsWith(`${projectId}|`)) held.delete(k);
}

/** The model input with every station of `stationIds` in it: those it lacks read from their series. */
async function withStations(projectId: string, stationIds: readonly string[], f: Fetchers): Promise<ModelInput> {
	const input = await f.modelInput(projectId);
	const missing = stationIds.filter((id) => !input.stations?.[id] || !input.series?.[stationSeriesKey(id) as keyof ModelInput['series']]);
	if (!missing.length) return input;
	const read = await Promise.all(missing.map((id) => f.series(projectId, id).then((s) => [id, s] as const)));
	const series = { ...(input.series ?? {}) } as Record<string, unknown>;
	const stations: RainStationInputs = { ...(input.stations ?? {}) };
	for (const [id, s] of read) {
		series[stationSeriesKey(id)] = { startDate: s.startDate, values: s.values };
		stations[id] = { name: s.name, mapMm: s.station?.mapMm ?? null, mapSource: s.station?.mapSource ?? null, lat: s.station?.lat ?? null, lon: s.station?.lon ?? null };
	}
	return { ...input, series: series as ModelInput['series'], stations };
}

/** Station id → its usability as a patch station of `mainId` (scaling as `scaleToMap`), over the stored input's run window. */
export async function patchChoices(projectId: string, mainId: string, scaleToMap: boolean, stationIds: readonly string[], f: Fetchers = API): Promise<Record<string, PatchUsability>> {
	const key = `${projectId}|${[...stationIds].sort().join(',')}`;
	let p = held.get(key);
	if (!p) {
		p = withStations(projectId, stationIds, f).then((input) => ({ input, prep: prepareRun(input) }));
		held.set(key, p);
		p.catch(() => held.get(key) === p && held.delete(key));
	}
	const { input, prep } = await p;
	return stationPatchChoices(input, { stationId: mainId, scaleToMap }, prep);
}
