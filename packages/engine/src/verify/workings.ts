// A farm's working parameters resolved the way runModel resolves them: the
// open-water evaporation depth per day, the dam's area–storage relation and
// seepage, and the irrigation efficiency. The self-checks (./checks.ts
// checkWorkings) and the Excel audit workbook (./audit.ts) both read a farm
// through these, so the numbers the workbook's formulas start from are the
// ones the checks hold the run to.
import { monthOfEpochDay, toEpochDay } from '../calendar';
import { datedDemandFactorOf, demandFactorOf, demandFactorStart, modelFarmEfficiency, unitPartFactor } from '../demand';
import { seepageReturnOf } from '../network/dam';
import { abstractionStartDay } from '../network/development';
import { ON_RIVER_DAM_SINCE, onRiverDam } from '../network/supply';
import { compareEngineVersions } from '../liability/errata';
import { DAM_AREA_EXPONENT, DEFAULT_FEBRUARY_DAYS, DEFAULT_LAKE_EVAP_FACTOR, estimatedDamAreaForEngine, type DemandPart, type ModelInput, type NetworkNode } from '../project';

/**
 * Open-water evaporation depth (mm) on each run day (audit N2): the lake
 * factor (the month's, when all twelve monthly factors are numbers ≥ 0) ×
 * the day's A-pan from `evap_apan_mm` where it has a number ≥ 0 (engine ≥
 * 0.38.0), else × the month's A-pan ÷ days in the month.
 */
export function lakeEvaporationMmDay(input: { settings: ModelInput['settings']; series?: ModelInput['series'] }, startDate: string, days: number): Float64Array {
	const st = input.settings ?? {};
	const lakeK = typeof st.lakeEvapFactor === 'number' && Number.isFinite(st.lakeEvapFactor) && st.lakeEvapFactor >= 0 ? st.lakeEvapFactor : DEFAULT_LAKE_EVAP_FACTOR;
	const lakeM = st.lakeEvapFactorMonthly;
	const lakeMonthly = Array.isArray(lakeM) && lakeM.length === 12 && lakeM.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0) ? lakeM : null;
	// As mergeSettings holds them (engine ≥ 1.69.0): February 28–29 days, a negative A-pan month is 0.
	const feb = typeof st.februaryDays === 'number' && st.februaryDays >= 28 && st.februaryDays <= 29 ? st.februaryDays : DEFAULT_FEBRUARY_DAYS;
	// The default A-pan is 0 in every month.
	const apan = Array.isArray(st.apanMm) ? st.apanMm.map((v) => (Number.isFinite(Number(v)) ? Math.max(Number(v), 0) : 0)) : new Array<number>(12).fill(0);
	const monthLen = [31, 30, 31, 31, feb, 31, 30, 31, 30, 31, 31, 30];
	const day0 = toEpochDay(startDate);
	const apanSeries = input.series?.evap_apan_mm;
	const apanOffset = apanSeries ? day0 - toEpochDay(apanSeries.startDate) : 0;
	return Float64Array.from({ length: days }, (_, t) => {
		const wy = (monthOfEpochDay(day0 + t) + 2) % 12;
		const k = lakeMonthly ? lakeMonthly[wy]! : lakeK;
		const a = apanSeries && t + apanOffset >= 0 ? apanSeries.values[t + apanOffset] : undefined;
		if (typeof a === 'number' && Number.isFinite(a) && a >= 0) return k * a;
		return (k * (apan[wy] ?? 0)) / monthLen[wy]!;
	});
}

/**
 * The factor on a farm's crop water requirement F each run day, as runModel
 * applies it after the soil-water store: the demand.scale factor for the
 * day's month (engine ≥ 0.41.0) from settings.demandFactorFrom on (engine ≥
 * 0.44.0; an invalid date: every day), × a full allocation's factor
 * `allocation` (engine ≥ 1.18.0, the run's allocation_demand_factor series);
 * 0 before the unit's abstraction date (engine ≥ 1.30.0, abstractionFrom).
 * `scaled` is false when none applies (every day 1). With `part` (engine ≥
 * 1.45.0) the part's own factor multiplies the unit's: `crops` for F, a demand
 * object's category for that object.
 */
export function dailyDemandFactor(
	settings: ModelInput['settings'],
	n: NetworkNode,
	day0: number,
	days: number,
	allocation: ArrayLike<number | null> | undefined,
	part?: DemandPart
): { perDay: Float64Array; scaled: boolean } {
	const factor = part ? unitPartFactor(n, part, []) : demandFactorOf(n, []);
	const dff = settings?.demandFactorFrom;
	const from = typeof dff === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dff) && !Number.isNaN(Date.parse(`${dff}T00:00:00Z`)) ? demandFactorStart(dff, day0, days) : 0;
	const abstractFrom = abstractionStartDay(n, day0, days, []);
	// × the dated factors on their days (engine ≥ 1.82.0, demand.scale with from/to): the whole demand's, and `part`'s.
	const dated = datedDemandFactorOf(n, part, day0, days, []);
	const perDay = Float64Array.from({ length: days }, (_, t) =>
		t < abstractFrom ? 0 : (factor && t >= from ? factor[(monthOfEpochDay(day0 + t) + 2) % 12]! : 1) * (dated && t >= from ? dated[t]! : 1) * (allocation ? Number(allocation[t]) : 1)
	);
	return { perDay, scaled: !!factor || !!dated || !!allocation || abstractFrom > 0 };
}

/** A farm dam's power-law area and its seepage, as runModel resolves them. */
export interface DamWorkings {
	/** Full-supply area A_full (m²): as entered, or capacity ÷ 3 m; 0 without a dam. */
	areaFull: number;
	/** Area exponent b: as entered when in (0, 3], else 0.7. */
	b: number;
	/** Seepage per day, a share of Q[t−1] in 0–1. */
	seep: number;
	/** Share of the seepage returning below the dam, 0–1 (1 without a dam: nothing to split). */
	seepReturn: number;
}

/** `engineVersion`: the run's, so an unknown area is the estimate that engine used (absent = this engine's). */
export function damWorkings(n: NetworkNode, engineVersion?: string): DamWorkings {
	return {
		areaFull: n.damCapacityM3 > 0 ? (n.damAreaFullM2 ?? estimatedDamAreaForEngine(n.damCapacityM3, engineVersion)) : 0,
		b: n.damAreaExponent > 0 && n.damAreaExponent <= 3 ? n.damAreaExponent : DAM_AREA_EXPONENT,
		seep: Math.min(Math.max(Number.isFinite(n.damSeepagePerDay) ? n.damSeepagePerDay : 0, 0), 1),
		seepReturn: n.damCapacityM3 > 0 ? seepageReturnOf(n) : 1
	};
}

/**
 * The irrigation efficiency runModel used for farm `n` (run.ts irrigation):
 * its own, 1 when that is outside (0, 1], combined with its crops' own
 * efficiencies (engine ≥ 0.43.0), or each planting's system (engine ≥ 1.72.0,
 * ../demand.ts unitIrrigationEfficiency).
 */
export function runEfficiency(input: Pick<ModelInput, 'settings' | 'model'>, n: NetworkNode): number {
	const e = n.irrigationEfficiency > 0 && n.irrigationEfficiency <= 1 ? n.irrigationEfficiency : 1;
	const apan = input.settings?.apanMm;
	return modelFarmEfficiency(e, n.id, input.model.crops, input.model.cropAreas, Array.isArray(apan) ? apan.map((v) => (Number.isFinite(Number(v)) ? Math.max(Number(v), 0) : 0)) : [], input.model.irrigationSystems);
}

/**
 * Whether the run that saved `engineVersion` took River to dam as 0 for farm
 * `n` because its dam is on the river (onRiverDam, engine ≥ 1.68.0). A run
 * with no recorded version is taken as the current engine's.
 */
export function onRiverDamForRun(n: NetworkNode, engineVersion?: string): boolean {
	if (!onRiverDam(n)) return false;
	if (!engineVersion || !/^\d+\.\d+\.\d+$/.test(engineVersion)) return true;
	return compareEngineVersions(engineVersion, ON_RIVER_DAM_SINCE) >= 0;
}
