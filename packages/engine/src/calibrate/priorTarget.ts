// What the regional GR4J prior is built for (issue #622, docs/model.md
// §2.10m, "The target"): the catchment, or under calibration zones (issue
// #555, §2.10n) one zone's land units, with what the project itself says of
// it: the area, and the climate its run reads (mean annual rain and the
// aridity index P / PE). Pure: the backend adds the position and the soil
// grid's PAWC, which need the map.
//
// A zone's prior is its own (stepwise.ts): its area is its units' sum. Its
// climate stays the catchment's, since the run reads one catchment rain and PE
// series (per-unit rain differs by unit, but the donors' MAP is HydroATLAS's
// over the whole basin, so the catchment's is the like-for-like figure).
import { prepareRun } from '../prepare';
import type { ModelInput } from '../project';
import { resolveCatchmentAreaKm2 } from '../runoff/area';
import { hasPotentialEvaporation } from '../runoff/pet';
import { hasDailyApanValue } from '../evaporation/apanDaily';
import { hasDailyEt0Value } from '../evaporation/et0Daily';
import { runoffForcing } from '../runoff/simulate';
import { runRain } from '../reference/wr2012';
import type { PriorTargetRef } from './prior';
import { zoneFitPlan } from './stepwise';

/** Fewest days of rain (and PE) the climate attributes are taken over: a year. */
export const PRIOR_CLIMATE_MIN_DAYS = 365;

export interface PriorTargetInfo extends PriorTargetRef {
	/** The target's area, km² (the zone's land units', or the catchment's as the run takes it); null when 0. */
	areaKm2: number | null;
	/** Mean annual rain over the days the run has rain, mm; null with under PRIOR_CLIMATE_MIN_DAYS of them. */
	mapMm: number | null;
	/** mapMm ÷ the mean annual GR4J PE (HydroATLAS's P/PET, higher is wetter); null without either. */
	aridity: number | null;
	/** Days of rain the climate was taken over. */
	rainDays: number;
}

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
	const rain = runRain(run.aligned, true, run.days) ?? [];
	let sum = 0;
	let n = 0;
	for (const v of rain) {
		if (v === null || !Number.isFinite(v)) continue;
		sum += v;
		n++;
	}
	const mapMm = n >= PRIOR_CLIMATE_MIN_DAYS ? (sum / n) * 365.25 : null;
	let aridity: number | null = null;
	if (mapMm !== null && hasPotentialEvaporation(run.settings, hasDailyApanValue(run.aligned('evap_apan_mm')), hasDailyEt0Value(run.aligned('evap_et0_mm')))) {
		const { petMm } = runoffForcing(run.settings, run);
		// PE over the same days the rain was taken on.
		let pe = 0;
		for (let t = 0; t < rain.length; t++) if (rain[t] !== null && Number.isFinite(rain[t]!)) pe += petMm[t]!;
		const annualPe = (pe / n) * 365.25;
		aridity = annualPe > 0 ? mapMm / annualPe : null;
	}
	return { zoneNodeId, units, areaKm2: areaKm2 > 0 ? areaKm2 : null, mapMm, aridity, rainDays: n };
}
