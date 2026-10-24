// An area's rain used under a rainfall station, from the code a run uses
// (issue #553, docs/model.md §2.4i), for the Data tab: the catchment's (the
// rain GR4J runs on under Fragmentation) or a land unit's (its `rain_unit`
// under per-unit rain), with each day's source. Computed when viewed, never
// stored, so it can't disagree with a run of the same input.
import { prepareRun } from '../prepare';
import type { ModelInput, StationAreaForcing } from '../project';
import { forecastTail } from '../forecastTail';
import { STATION_DAY_SOURCE } from './stationForcing';
import { UNIT_RAIN_SOURCE, unitRainForcing, unitRainOn } from './unitRain';

/** Where a day's rain came from: the station (× the MAP ratio), the area's corrected CHIRPS, the next fallback, or none (dry). */
export type StationRainDaySource = 'station' | 'chirps' | 'fallback' | 'none';

export interface StationAreaRain {
	startDate: string;
	/** The rain the run reads on each run day, mm (0 on a dry day): the catchment's `rain_used` or the unit's `rain_unit`. */
	rainMm: number[];
	source: StationRainDaySource[];
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
		const rainMm: number[] = [];
		const source: StationRainDaySource[] = [];
		for (let t = 0; t < prep.days; t++) {
			// runoffForcing's rain (the areal correction is off under a catchment station).
			rainMm.push(Math.max(0, c[t] ?? ch[t] ?? f[t] ?? 0));
			source.push(c[t] != null ? 'station' : ch[t] != null ? 'chirps' : f[t] != null ? 'fallback' : 'none');
		}
		return { startDate: prep.startDate, rainMm, source, forcing: structuredClone(forcing), warnings };
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
		s === UNIT_RAIN_SOURCE.station ? 'station' : s === UNIT_RAIN_SOURCE.stationChirps ? 'chirps' : s === s ? 'fallback' : 'none'
	);
	return { startDate: prep.startDate, rainMm: Array.from(u.rainMm), source, forcing: structuredClone(forcing), warnings };
}
