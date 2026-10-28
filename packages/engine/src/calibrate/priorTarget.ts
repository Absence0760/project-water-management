// What the regional GR4J prior is built for (issue #622, docs/model.md
// §2.10m, "The target"): the catchment, or under calibration zones (issue
// #555, §2.10n) one zone's land units, with what the project itself says of
// it: the area, and the climate its runoff runs on (mean annual rain and the
// aridity index P / PE). Pure: the backend adds the position and the soil
// grid's PAWC, which need the map.
//
// The climate is the target's own, as the donors' HydroATLAS MAP is over the
// donor's own basin:
//  - rain: what GR4J reads (runoffForcing's catchment rain, or under Per unit
//    flow generation the area-weighted mean of the target's units' own rain,
//    unitRainForcing), on the days before any forecast tail;
//  - PE: GR4J's catchment PE (every unit runs on it) on the same days;
//  - each a mean of complete water years' totals (every day of the water year
//    with rain), so a part year never weighs one season twice.
// A catchment rain day with no reading (catchment, CHIRPS and forecast all
// missing) leaves its water year out.
import { toEpochDay, waterYearOf } from '../calendar';
import { forecastTail } from '../forecastTail';
import { prepareRun } from '../prepare';
import type { ModelInput } from '../project';
import { isLandUnit, resolveCatchmentAreaKm2 } from '../runoff/area';
import { hasPotentialEvaporation } from '../runoff/pet';
import { hasDailyApanValue } from '../evaporation/apanDaily';
import { hasDailyEt0Value } from '../evaporation/et0Daily';
import { runoffForcing } from '../runoff/simulate';
import { unitRainForcing } from '../runoff/unitRain';
import { runRain } from '../reference/wr2012';
import type { PriorTargetRef } from './prior';
import { zoneFitPlan } from './stepwise';

export interface PriorTargetInfo extends PriorTargetRef {
	/** The target's area, km² (the zone's land units', or the catchment's as the run takes it); null when 0. */
	areaKm2: number | null;
	/** Mean annual rain over the complete water years, mm; null with none. */
	mapMm: number | null;
	/** mapMm ÷ the mean annual GR4J PE over the same years (HydroATLAS's P/PET, higher is wetter); null without either. */
	aridity: number | null;
	/** Complete water years the climate was taken over. */
	years: number;
	/** Where the rain came from: the catchment's, or the target's units' own (Per unit flow generation). */
	rainFrom: 'catchment' | 'units';
}

/** Days in water year `wy` (1 October wy – 30 September wy + 1). */
const waterYearDays = (wy: number) => toEpochDay(`${wy + 1}-10-01`) - toEpochDay(`${wy}-10-01`);

/**
 * The prior's target for a fit of `zoneNodeId` (null = the calibration site's
 * own zone, or with no zone the catchment). Throws when the project has no
 * calibration zone at that gauge.
 */
export function priorTargetOf(input: ModelInput, zoneNodeId: string | null): PriorTargetInfo {
	const plan = zoneFitPlan(input);
	let units: string[] | null = null;
	let areaKm2: number;
	const run = prepareRun(input);
	if (plan) {
		const step = plan.find((s) => s.zoneNodeId === zoneNodeId);
		if (!step) throw new Error('the project has no calibration zone at that gauge');
		units = [...step.units].sort();
		const set = new Set(units);
		areaKm2 = input.model.nodes.filter((n) => set.has(n.id)).reduce((s, n) => s + (n.areaKm2 || 0), 0);
	} else {
		if (zoneNodeId !== null) throw new Error('the project has no calibration zone at that gauge');
		areaKm2 = resolveCatchmentAreaKm2(run.settings.calibration, input);
	}
	const { historyDays } = forecastTail(run);
	const days = Math.min(run.days, historyDays);
	const d0 = toEpochDay(run.startDate);
	const hasPe = hasPotentialEvaporation(run.settings, hasDailyApanValue(run.aligned('evap_apan_mm')), hasDailyEt0Value(run.aligned('evap_et0_mm')));
	const forcing = runoffForcing(run.settings, run);
	// The day's rain had a reading (catchment, CHIRPS or forecast), as the run's WR2012 check reads it.
	const read = runRain(run.aligned, true, run.days) ?? [];
	// Under Per unit flow generation, the target's units' own rain, area-weighted.
	const perUnit = unitRainForcing(
		{ settings: run.settings, series: input.series ?? {}, nodes: input.model.nodes, startDate: run.startDate, days: run.days, aligned: run.aligned, chirpsCorrection: run.chirpsCorrection, historyDays, forecastRainSource: input.forecastRainSource ?? null, stations: run.stations?.context ?? null, stationInputs: input.stations ?? null },
		[],
		run.settings.unitRain?.pinned ?? undefined
	);
	let rain: ArrayLike<number> = forcing.rainMm;
	let rainFrom: PriorTargetInfo['rainFrom'] = 'catchment';
	if (perUnit) {
		const want = units ? new Set(units) : new Set(input.model.nodes.filter(isLandUnit).map((n) => n.id));
		const mine = perUnit.units.filter((u) => want.has(u.nodeId));
		const total = mine.reduce((s, u) => s + u.areaKm2, 0);
		if (mine.length && total > 0) {
			const mean = new Float64Array(run.days);
			for (const u of mine) for (let t = 0; t < run.days; t++) mean[t] = mean[t]! + (u.rainMm[t]! * u.areaKm2) / total;
			rain = mean;
			rainFrom = 'units';
		}
	}
	// Each water year's totals, and whether every one of its days was read.
	const byYear = new Map<number, { n: number; rain: number; pe: number }>();
	for (let t = 0; t < days; t++) {
		const wy = waterYearOf(d0 + t);
		const y = byYear.get(wy) ?? { n: 0, rain: 0, pe: 0 };
		if (read[t] !== null && read[t] !== undefined && Number.isFinite(read[t]!)) {
			y.n++;
			y.rain += rain[t]!;
			y.pe += forcing.petMm[t]!;
		}
		byYear.set(wy, y);
	}
	const complete = [...byYear.entries()].filter(([wy, y]) => y.n === waterYearDays(wy));
	const years = complete.length;
	const mapMm = years ? complete.reduce((s, [, y]) => s + y.rain, 0) / years : null;
	const annualPe = years && hasPe ? complete.reduce((s, [, y]) => s + y.pe, 0) / years : null;
	const aridity = mapMm !== null && annualPe !== null && annualPe > 0 ? mapMm / annualPe : null;
	return { zoneNodeId, units, areaKm2: areaKm2 > 0 ? areaKm2 : null, mapMm, aridity, years, rainFrom };
}
