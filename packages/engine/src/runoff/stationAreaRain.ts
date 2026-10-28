// An area's rain used under a rainfall station, from the code a run uses
// (issue #553, docs/model.md §2.4i), for the Data tab: the catchment's (the
// rain GR4J runs on under Fragmentation) or a land unit's (its `rain_unit`
// under per-unit rain), with each day's source. Computed when viewed, never
// stored, so it can't disagree with a run of the same input.
import { toEpochDay } from '../calendar';
import { cmpStr } from '../order';
import { prepareRun, type PreparedRun } from '../prepare';
import type { ModelInput, StationAreaForcing } from '../project';
import { forecastTail } from '../forecastTail';
import { alignReadings, STATION_DAY_SOURCE, stationContext, stationPatchUsability, type StationPatchUsability } from './stationForcing';
import { UNIT_RAIN_SOURCE, unitRainForcing, unitRainOn } from './unitRain';

/** Where a day's rain came from: the station (× the MAP ratio), a patch station (× its MAP ratio, engine ≥ 1.105.0), the area's corrected CHIRPS, the next fallback, or none (dry). */
export type StationRainDaySource = 'station' | 'patch' | 'chirps' | 'fallback' | 'none';

export interface StationAreaRain {
	startDate: string;
	/** The rain the run reads on each run day, mm (0 on a dry day): the catchment's `rain_used` or the unit's `rain_unit`. */
	rainMm: number[];
	source: StationRainDaySource[];
	/** On a `patch` day, the patch station that gave it (its id) and its place in the patching priority (1 = first); null on the others. */
	patchStationId: (string | null)[];
	patchPlace: (number | null)[];
	forcing: StationAreaForcing;
	warnings: string[];
}

/**
 * The rain used of the catchment (`nodeId` null) or of a land unit under its
 * station, over the run window `input` gives; null when that area has no
 * station in this input (no assignment, its station has no record, or, for a
 * unit, per-unit rain is off).
 */
export function stationAreaRain(input: ModelInput, nodeId: string | null): StationAreaRain | null {
	const prep = prepareRun(input);
	if (!prep.stations) return null;
	const warnings = [...prep.warnings];
	if (nodeId === null) {
		const forcing = prep.stations.catchment;
		if (!forcing) return null;
		const c = prep.aligned('rain_catchment_mm');
		const ch = prep.aligned('rain_chirps_mm');
		const f = prep.aligned('rain_forecast_mm');
		const d = prep.stations.catchmentDays ?? null;
		const rainMm: number[] = [];
		const source: StationRainDaySource[] = [];
		const patchIndex: number[] = [];
		for (let t = 0; t < prep.days; t++) {
			// runoffForcing's rain (the areal correction is off under a catchment station).
			rainMm.push(Math.max(0, c[t] ?? ch[t] ?? f[t] ?? 0));
			const patched = c[t] != null && d?.source[t] === STATION_DAY_SOURCE.patch;
			source.push(patched ? 'patch' : c[t] != null ? 'station' : ch[t] != null ? 'chirps' : f[t] != null ? 'fallback' : 'none');
			patchIndex.push(patched ? d!.patchIndex[t]! : -1);
		}
		return { startDate: prep.startDate, rainMm, source, ...patchDays(forcing, patchIndex), forcing: structuredClone(forcing), warnings };
	}
	if (!unitRainOn(prep.settings)) return null;
	const built = unitRainForcing(
		{
			settings: prep.settings,
			series: input.series ?? {},
			nodes: input.model.nodes,
			startDate: prep.startDate,
			days: prep.days,
			aligned: prep.aligned,
			chirpsCorrection: prep.chirpsCorrection,
			historyDays: forecastTail(prep).historyDays,
			...(input.forecastRainSource ? { forecastRainSource: input.forecastRainSource } : {}),
			stations: prep.stations.context,
			stationInputs: input.stations ?? null
		},
		warnings,
		prep.settings.unitRain?.pinned ?? undefined
	);
	const u = built?.units.find((x) => x.nodeId === nodeId);
	const forcing = built?.stations.find((x) => x.nodeId === nodeId);
	if (!u || !forcing) return null;
	const source = Array.from(u.source, (s): StationRainDaySource =>
		s === UNIT_RAIN_SOURCE.station ? 'station' : s === UNIT_RAIN_SOURCE.stationPatch ? 'patch' : s === UNIT_RAIN_SOURCE.stationChirps ? 'chirps' : s === s ? 'fallback' : 'none'
	);
	const patchIndex = Array.from(u.source, (s, t) => (s === UNIT_RAIN_SOURCE.stationPatch ? (u.patchIndex?.[t] ?? -1) : -1));
	return { startDate: prep.startDate, rainMm: Array.from(u.rainMm), source, ...patchDays(forcing, patchIndex), forcing: structuredClone(forcing), warnings };
}

/** Each day's patch station and its place in the priority, from the day's index into forcing.patches (−1: not a patch day). */
function patchDays(forcing: StationAreaForcing, index: readonly number[]): Pick<StationAreaRain, 'patchStationId' | 'patchPlace'> {
	const patches = forcing.patches ?? [];
	const patchStationId = index.map((i) => {
		const p = i >= 0 ? patches[i] : undefined;
		return p?.source === 'station' ? p.stationId : null;
	});
	return { patchStationId, patchPlace: index.map((i, t) => (patchStationId[t] !== null ? i + 1 : null)) };
}

/**
 * Whether each of the input's stations can patch a main station's gaps
 * (issue #612, stationPatchUsability) over the run window `input` gives, for
 * Settings → Flow generation → Per unit: station id → its usability. The
 * records are the run's checked ones; `scaleToMap` the assignment's.
 */
export function stationPatchChoices(input: ModelInput, a: { stationId: string; scaleToMap?: boolean }, prep: PreparedRun = prepareRun(input)): Record<string, StationPatchUsability> {
	const ctx = prep.stations?.context ?? stationContext({ settings: prep.settings, series: prep.series, stations: input.stations, nodes: input.model.nodes }, []);
	const start = toEpochDay(prep.startDate);
	const main = alignReadings(ctx.record(a.stationId)?.record, start, prep.days);
	const out: Record<string, StationPatchUsability> = {};
	for (const id of Object.keys(input.stations ?? {}).sort(cmpStr)) {
		const rec = ctx.record(id)?.record ?? null;
		out[id] = stationPatchUsability({
			main,
			patch: rec ? alignReadings(rec, start, prep.days) : null,
			isMain: id === a.stationId,
			scaleToMap: a.scaleToMap !== false,
			stationMapMm: ctx.map(id).mapMm,
			record: rec
		});
	}
	return out;
}
