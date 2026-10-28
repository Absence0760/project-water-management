// A land unit's rain under the §2.4h chain (a unit without a rainfall
// station, docs/model.md §2.4h), for the Data tab's Preview all data (issue
// #613 slice 2): each link of its chain over the run window, levelled as a
// run levels it, beside the rain used and the link each day came from.
// Computed when viewed, never stored. The rain used and the day codes are
// unitRainForcing's own (the run's `rain_unit`, to the bit); the links are
// the same products unitRainForcing makes from the same recipe, so a day's
// rain used equals the link its code names. Read-only: no run output changes.
import { monthOfEpochDay, toEpochDay } from '../calendar';
import { forecastTail } from '../forecastTail';
import { prepareRun, type PreparedRun } from '../prepare';
import type { DailySeries, ModelInput, UnitChirpsLevel, UnitRainRule } from '../project';
import { chirpsFactorOn } from '../rain';
import { checkedUnitGauge } from './unitGaugeChecks';
import { UNIT_RAIN_SOURCE, unitRainForcing, unitRainOn, type UnitRainRecipe } from './unitRain';
import { unitRainSeriesKey } from '../project';

/** Which link of the §2.4h chain gave a day's rain: own gauge, catchment gauge × MAP ratio, own CHIRPS (levelled), the catchment rain, a forecast, or none (dry). */
export type UnitRainDaySource = 'unitGauge' | 'gaugeMap' | 'unitChirps' | 'catchment' | 'forecast' | 'none';

export interface UnitAreaRain {
	/** The run window's first day; every line covers the window, one value a day. */
	startDate: string;
	nodeId: string;
	/** The unit's rule (§2.4h 1–4); a unit on its station is stationAreaRain's. */
	rule: Exclude<UnitRainRule, 'station'>;
	recipe: UnitRainRecipe;
	/** The unit's MAP the levels read, mm (null: none usable). */
	mapMm: number | null;
	/** The catchment gauge's MAP level rule 2's ratio divides by, mm; null without the ratio. */
	gaugeMapMm: number | null;
	/** The rain the run reads (its `rain_unit`), mm; 0 on a dry day. */
	rainMm: number[];
	source: UnitRainDaySource[];
	/** Rule 1's own gauge after the catchment's §2.4c/§2.4d checks and the unreliable periods (null: no reading); null without a gauge. */
	ownGauge: (number | null)[] | null;
	/** The catchment rain × the unit's MAP ratio (null: no reading); null when the ratio doesn't apply. */
	gaugeScaled: (number | null)[] | null;
	/** The unit's CHIRPS as stored (null: no reading); null when it has none. */
	chirpsRaw: (number | null)[] | null;
	/** That CHIRPS levelled as a run levels it (its MAP factor, the §2.4b factors, or the reference factors × k_unit); null when it has none or it is unusable. */
	chirpsLevelled: (number | null)[] | null;
	warnings: string[];
}

const reading = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function align(s: DailySeries | null | undefined, start: number, days: number): (number | null)[] {
	const out = new Array<number | null>(days).fill(null);
	if (!s) return out;
	const off = toEpochDay(s.startDate) - start;
	for (let i = Math.max(0, -off); i < Math.min(s.values.length, days - off); i++) {
		const v = s.values[i];
		out[i + off] = reading(v) ? v : null;
	}
	return out;
}

const CODE: Record<number, UnitRainDaySource> = {
	[UNIT_RAIN_SOURCE.unitGauge]: 'unitGauge',
	[UNIT_RAIN_SOURCE.gaugeMap]: 'gaugeMap',
	[UNIT_RAIN_SOURCE.unitChirps]: 'unitChirps',
	[UNIT_RAIN_SOURCE.catchment]: 'catchment',
	[UNIT_RAIN_SOURCE.forecast]: 'forecast'
};

/**
 * A land unit's rain under its §2.4h rule over the run window `input` gives,
 * with each link of its chain; null when per-unit rain is off, the node isn't
 * a land unit of the run, or the unit is on its rainfall station (§2.4i,
 * stationAreaRain's). `prep` is prepareRun(input), passed in when several
 * units are read from one input.
 */
export function unitAreaRain(input: ModelInput, nodeId: string, prep: PreparedRun = prepareRun(input)): UnitAreaRain | null {
	if (!unitRainOn(prep.settings)) return null;
	const warnings = [...prep.warnings];
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
			...(prep.stations ? { stations: prep.stations.context } : {}),
			stationInputs: input.stations ?? null
		},
		warnings,
		prep.settings.unitRain?.pinned ?? undefined
	);
	const u = built?.units.find((x) => x.nodeId === nodeId);
	if (!u || u.recipe.rule === 'station') return null;
	const r = u.recipe;
	const rule = r.rule as Exclude<UnitRainRule, 'station'>;
	const d0 = toEpochDay(prep.startDate);
	const days = prep.days;
	const series = (input.series ?? {}) as Record<string, DailySeries | undefined>;
	// The links as unitRainForcing reads them: the checked own gauge, the catchment rain × k2, the CHIRPS × its level.
	const ownGauge = r.hasGauge ? (checkedUnitGauge(prep.settings, input.series ?? {}, nodeId, d0, days)?.values ?? null) : null;
	const c = prep.aligned('rain_catchment_mm');
	const k2 = r.gaugeMapFactor;
	const gaugeScaled = k2 !== null ? c.map((v) => (v == null ? null : v * k2)) : null;
	const chirpsSeries = series[unitRainSeriesKey('rain_chirps_mm', nodeId)];
	const chirpsRaw = chirpsSeries ? align(chirpsSeries, d0, days) : null;
	const level: UnitChirpsLevel | null = r.chirps && r.chirps.source !== 'unusable' ? r.chirps : null;
	let chirpsLevelled: (number | null)[] | null = null;
	if (level && chirpsRaw) {
		const kFill = k2 ?? 1;
		const shapeOnly = level.source === 'bias' || (level.source === 'reference' && !level.kUnit);
		const levelOn = (t: number): number => {
			if (level.source === 'map') return level.factor;
			if (level.source === 'bias') return chirpsFactorOn(prep.chirpsCorrection, d0 + t) ?? 1;
			if (level.source === 'reference') return level.factors[monthOfEpochDay(d0 + t) - 1]! * (level.kUnit?.factor ?? 1);
			return 1;
		};
		chirpsLevelled = chirpsRaw.map((v, t) => (v == null ? null : v * (levelOn(t) * (shapeOnly ? kFill : 1))));
	}
	const mapMm = u.mapMm;
	// Rule 2's denominator as unitRainRecipes reads it: the catchment station's MAP × its ratio under a catchment station (§2.4i), else the gauge MAP set.
	const cs = prep.settings.rainStations?.catchment ? (prep.stations?.catchment ?? null) : null;
	const gaugeMapMm = k2 === null ? null : cs ? (cs.stationMapMm === null ? null : cs.stationMapMm * cs.ratio) : (prep.settings.unitRain?.gaugeMapMm ?? null);
	return {
		startDate: prep.startDate,
		nodeId,
		rule,
		recipe: structuredClone(r),
		mapMm,
		gaugeMapMm,
		rainMm: Array.from(u.rainMm),
		source: Array.from(u.source, (s) => CODE[s] ?? 'none'),
		ownGauge,
		gaugeScaled,
		chirpsRaw,
		chirpsLevelled,
		warnings
	};
}
