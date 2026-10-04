// Irrigation demand — port of the b023 [Crop demand] / [Farm demand] /
// [Irrigation Demand] sheets. See src/network/README.md § "Irrigation demand".
//
// The workbook rounds crop mm to 2 dp, farm demand to 0.1 m³/day and net demand
// to whole m³; the engine keeps full precision (docs/engine-audit.md R1).
import { daysPerMonth, toEpochDay, type Monthly } from './calendar';
import { DEFAULT_IRRIGATION_SYSTEMS, RETURN_FLOW_SLACK, returnFlowFromLossReturn, upgradeLegacyModel, type DemandPart, type IrrigationSystemDef, type ModelInput, type NetworkNode } from './project';

export interface Crop {
	id: string;
	name: string;
	/** Crop factor per water-year month (Oct–Sep). */
	cropFactor: Monthly;
	/** The crop's own irrigation efficiency, 0 < e ≤ 1 (engine ≥ 0.43.0); absent = the farm's. */
	irrigationEfficiency?: number;
}

/** What farmIrrigationEfficiency reads of a crop: a CropDef or a Crop. */
export interface CropEfficiencyInput {
	id: string;
	cropFactor: ArrayLike<unknown>;
	irrigationEfficiency?: number | null;
}

/** A crop's own efficiency when it is one (0 < e ≤ 1); anything else falls back to the farm's. */
export function ownCropEfficiency(e: unknown): number | undefined {
	return typeof e === 'number' && e > 0 && e <= 1 ? e : undefined;
}

/**
 * A unit's efficiency from per-crop efficiencies and areas (engine ≥ 0.43.0,
 * issue #54): unitIrrigationEfficiency with one planting per crop, each at its
 * own efficiency (CropEfficiencyInput.irrigationEfficiency, else the farm's).
 * A convenience for callers holding per-crop values; the run resolves each
 * planting's system (plantingEfficiencyResolver) and blends those.
 */
export function farmIrrigationEfficiency(
	farmEfficiency: number,
	crops: readonly CropEfficiencyInput[],
	areaM2ByCropId: ReadonlyMap<string, number>,
	apanMm: ArrayLike<unknown>
): number {
	const plantings = [...crops]
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.map((c) => {
			const e = ownCropEfficiency(c.irrigationEfficiency);
			return { cropId: c.id, areaM2: areaM2ByCropId.get(c.id) ?? 0, ...(e !== undefined ? { efficiency: e } : {}) };
		});
	return unitIrrigationEfficiency(farmEfficiency, crops, plantings, apanMm);
}

/** A crop as a planting's efficiency is resolved from: its default system, and the legacy efficiency of engine < 1.72.0. */
export interface CropSystemInput {
	id: string;
	name?: string;
	irrigationSystemId?: string | null;
	irrigationEfficiency?: number | null;
}

/** A planting (a crop area) as its efficiency is resolved: its crop and its own system on this unit. */
export interface PlantingSystemInput {
	cropId: string;
	irrigationSystemId?: string | null;
}

/**
 * Resolves each planting's application efficiency (engine ≥ 1.72.0, docs/model.md
 * §2.3): its own system on the unit, else its crop's default system, from the
 * project's table (`systems`; absent = DEFAULT_IRRIGATION_SYSTEMS); with no
 * system named, the crop's legacy efficiency (engine 0.43.0–1.71.0); else
 * undefined, the unit's own. A system id the table doesn't have, or a row with
 * an efficiency outside (0, 1], is skipped for the next in that order, with a
 * warning (once each).
 */
export function plantingEfficiencyResolver(
	crops: readonly CropSystemInput[],
	systems: readonly IrrigationSystemDef[] | null | undefined,
	warnings?: string[]
): (planting: PlantingSystemInput) => number | undefined {
	const table = new Map((systems ?? DEFAULT_IRRIGATION_SYSTEMS).map((s) => [s.id, s]));
	const byCrop = new Map(crops.map((c) => [c.id, c]));
	const warned = new Set<string>();
	const warn = (key: string, msg: string) => {
		if (warnings && !warned.has(key)) {
			warned.add(key);
			warnings.push(msg);
		}
	};
	return (p) => {
		const crop = byCrop.get(p.cropId);
		// The planting's own system, then its crop's default: one the table lacks (or with a bad efficiency) is skipped for the next.
		for (const id of [p.irrigationSystemId, crop?.irrigationSystemId]) {
			if (id == null) continue;
			const s = table.get(id);
			const e = s ? ownCropEfficiency(s.efficiency) : undefined;
			if (e !== undefined) return e;
			if (!s) warn(`missing:${id}`, `crop "${crop?.name ?? p.cropId}": irrigation system ${id} is not in the project's table; skipping it`);
			else warn(`bad:${id}`, `irrigation system "${s.name}": efficiency ${String(s.efficiency)} is not in (0, 1]; skipping it`);
		}
		return ownCropEfficiency(crop?.irrigationEfficiency);
	};
}

/** One planting of a unit and the efficiency it resolved to (undefined = the unit's own). */
export interface PlantingEfficiency {
	cropId: string;
	areaM2: number;
	efficiency?: number;
}

/**
 * A unit's irrigation efficiency from its plantings' (engine ≥ 1.72.0; per crop
 * from 0.43.0): the harmonic mean of each planting's efficiency (the unit's own
 * where it has none), weighted by its annual gross requirement,
 * w = area × Σ_m MAX(0, cropFactor[m]) × MAX(0, A-pan[m]) (area × Σ cropFactor
 * with no A-pan), so the abstraction D = F ÷ e is the sum of each planting's
 * requirement ÷ its own efficiency. A unit none of whose plantings resolved
 * an efficiency returns `farmEfficiency` untouched (bit-identical runs).
 * Plantings are summed in the order given: crop id, then area (order invariance).
 */
export function unitIrrigationEfficiency(
	farmEfficiency: number,
	crops: readonly { id: string; cropFactor: ArrayLike<unknown> }[],
	plantings: readonly PlantingEfficiency[],
	apanMm: ArrayLike<unknown>
): number {
	const grown = plantings.filter((p) => p.areaM2 > 0);
	if (!grown.some((p) => p.efficiency !== undefined)) return farmEfficiency;
	const byId = new Map(crops.map((c) => [c.id, c]));
	const num = (v: unknown) => {
		const x = Number(v);
		return Number.isFinite(x) && x > 0 ? x : 0;
	};
	let w = 0, wOverE = 0, k = 0, kOverE = 0;
	for (const p of grown) {
		const c = byId.get(p.cropId);
		if (!c) continue;
		const e = p.efficiency ?? farmEfficiency;
		let byApan = 0, byFactor = 0;
		for (let m = 0; m < 12; m++) {
			const f = num(c.cropFactor[m]);
			byApan += f * num(apanMm[m]);
			byFactor += f;
		}
		w += p.areaM2 * byApan;
		wOverE += (p.areaM2 * byApan) / e;
		k += p.areaM2 * byFactor;
		kOverE += (p.areaM2 * byFactor) / e;
	}
	if (w > 0) return w / wOverE;
	if (k > 0) return k / kOverE;
	return farmEfficiency;
}

/** A unit's plantings in the order the run sums them (crop id, then area), crops the model knows only, each with its resolved efficiency. */
export function unitPlantings(
	nodeId: string,
	crops: readonly CropSystemInput[],
	cropAreas: readonly (PlantingSystemInput & { nodeId: string; areaM2: number })[],
	resolve: (planting: PlantingSystemInput) => number | undefined
): PlantingEfficiency[] {
	const known = new Set(crops.map((c) => c.id));
	return cropAreas
		.filter((a) => a.nodeId === nodeId && known.has(a.cropId))
		.sort((a, b) => (a.cropId < b.cropId ? -1 : a.cropId > b.cropId ? 1 : a.areaM2 - b.areaM2))
		.map((a) => {
			const e = resolve(a);
			return { cropId: a.cropId, areaM2: a.areaM2, ...(e !== undefined ? { efficiency: e } : {}) };
		});
}

/**
 * unitIrrigationEfficiency straight from a model document: the unit's
 * plantings (crops the model knows), their systems from `systems` (the
 * model's table; absent = the defaults) and the A-pan. For readers of a saved
 * run (verify, the farm projection, the day trace) that need the efficiency
 * runModel used. `farmEfficiency` should already be the one the run used (a
 * value outside (0, 1] runs as 1).
 */
export function modelFarmEfficiency(
	farmEfficiency: number,
	nodeId: string,
	crops: readonly (CropSystemInput & { cropFactor: ArrayLike<unknown> })[],
	cropAreas: readonly (PlantingSystemInput & { nodeId: string; areaM2: number })[],
	apanMm: ArrayLike<unknown>,
	systems?: readonly IrrigationSystemDef[] | null
): number {
	const plantings = unitPlantings(nodeId, crops, cropAreas, plantingEfficiencyResolver(crops, systems));
	return unitIrrigationEfficiency(farmEfficiency, crops, plantings, apanMm);
}

/**
 * A stored model upgraded as the run reads it (project.ts upgradeLegacyModel),
 * with an engine 0.16.0–1.70.0 unit's β (a share of the losses) turned into
 * r = β(1 − e) at the efficiency that engine ran it at: its plantings' blend
 * (each crop's own efficiency since 0.43.0) under the run's A-pan, not the
 * unit's own value alone, which upgradeLegacyModel has to use without the
 * A-pan. So a re-run, verifyRun and the farm audit of a ≤ 1.70.0 run take the
 * return flow it actually ran with.
 */
export function upgradeLegacyInput(model: ModelInput['model'], apanMm: unknown): ModelInput['model'] {
	const up = upgradeLegacyModel(model);
	const beta = new Map<string, number>();
	for (const raw of (Array.isArray(model.nodes) ? model.nodes : []) as unknown as Record<string, unknown>[]) {
		if (raw && typeof raw.lossReturnFraction === 'number' && raw.returnFlowFraction === undefined && raw.irrigationEfficiency !== undefined) beta.set(raw.id as string, raw.lossReturnFraction);
	}
	if (!beta.size) return up;
	const apan = Array.isArray(apanMm) ? apanMm.map((v) => (Number.isFinite(Number(v)) ? Math.max(Number(v), 0) : 0)) : [];
	return {
		...up,
		nodes: up.nodes.map((n) => {
			const b = beta.get(n.id);
			if (b === undefined) return n;
			const own = n.irrigationEfficiency > 0 && n.irrigationEfficiency <= 1 ? n.irrigationEfficiency : 1;
			return { ...n, returnFlowFraction: returnFlowFromLossReturn(b, modelFarmEfficiency(own, n.id, up.crops, up.cropAreas, apan, up.irrigationSystems)) };
		})
	};
}

/**
 * Gross crop water requirement in mm for each water-year month:
 * WR90 A-pan evaporation × crop factor.
 */
export function grossCropMm(apanMm: Monthly, crop: Crop): Monthly {
	return apanMm.map((e, i) => e * (crop.cropFactor[i] ?? 0)) as unknown as Monthly;
}

/**
 * Gross farm demand in m³/day for each water-year month:
 * Σ(crop area m² × gross mm) / 1000 / days in month.
 */
export function grossFarmDemandM3PerDay(
	apanMm: Monthly,
	crops: readonly Crop[],
	areaM2ByCropId: ReadonlyMap<string, number>,
	februaryDays = 28.25
): Monthly {
	const days = daysPerMonth(februaryDays);
	const out = new Array<number>(12).fill(0);
	for (const crop of crops) {
		const area = areaM2ByCropId.get(crop.id) ?? 0;
		if (area === 0) continue;
		const gross = grossCropMm(apanMm, crop);
		for (let m = 0; m < 12; m++) out[m]! += area * gross[m]!;
	}
	return out.map((v, m) => v / 1000 / days[m]!) as unknown as Monthly;
}

/**
 * Σ crop area (m²) × crop factor, per water-year month: a farm's gross
 * demand on a day is this × the day's A-pan (mm) ÷ 1000 m³. Used on the days
 * a daily A-pan series covers (engine ≥ 0.38.0, issue #45); the monthly path
 * stays grossFarmDemandM3PerDay.
 */
export function cropFactorAreaM2(crops: readonly Crop[], areaM2ByCropId: ReadonlyMap<string, number>): number[] {
	const out = new Array<number>(12).fill(0);
	for (const crop of crops) {
		const area = areaM2ByCropId.get(crop.id) ?? 0;
		if (area === 0) continue;
		for (let m = 0; m < 12; m++) out[m]! += area * (crop.cropFactor[m] ?? 0);
	}
	return out;
}

/**
 * Net daily demand after effective rainfall (b023 [Irrigation Demand]):
 * MAX(0, gross − cropped area × effectiveRainFraction / 1000 × rain mm).
 * The run uses farmDailyDemand, which carries rain over; this is its
 * store-less case (effectiveRainStoreMm = 0), kept as the workbook formula
 * but for rain within float noise of the gross, which covers it (coveredByRain).
 */
export function netDailyDemandM3(
	grossM3PerDay: number,
	croppedAreaM2: number,
	rainMm: number,
	effectiveRainFraction: number
): number {
	const need = Math.max(0, grossM3PerDay);
	const pe = rainOffsetM3(croppedAreaM2, rainMm, effectiveRainFraction);
	return coveredByRain(need, pe) ? 0 : need - pe;
}

/**
 * Does the rain available today (the store plus the day's effective rain)
 * cover the day's gross need? Yes when it falls short by no more than 10⁻¹²
 * of the need (engine ≥ 1.57.0): the store's running sum carries float noise,
 * and a sum that came an ulp short left a crop requirement of 10⁻¹⁴ m³ beside
 * a 35 m³ need, which as a demand switched on a dam-filling borehole (verify
 * random seed 1343, docs/model.md §2.3).
 */
export const coveredByRain = (need: number, available: number): boolean => need - available <= RAIN_COVER_NOISE * need;

/** The relative shortfall of effective rain below which it covers the need (coveredByRain). */
export const RAIN_COVER_NOISE = 1e-12;

/** Effective rain on the cropped area (m³/day): Pe, what the soil-water store takes in each day. */
export function rainOffsetM3(croppedAreaM2: number, rainMm: number, effectiveRainFraction: number): number {
	// Same operand order as the workbook: (area × fraction/1000) × rain.
	return croppedAreaM2 * (effectiveRainFraction / 1000) * rainMm;
}

/** A farm's daily demand after effective rain and the soil-water store (farmDailyDemand). */
export interface FarmDailyDemand {
	/** Net irrigation demand (m³/day). */
	net: Float64Array;
	/** Effective rain used against the day's demand, from the day's rain or the store (m³/day). */
	used: Float64Array;
	/** Soil-water store at the end of the day (mm over the cropped area). */
	storeMm: Float64Array;
	/** The store W (m³) at the start of day `warm.captureAt`, when asked (engine ≥ 1.1.0, ./warmstart). */
	storeAtM3?: number;
}

/**
 * Net daily demand with effective rain carried over through a soil-water
 * store: a one-bucket form of the FAO-56 root-zone balance ([Allen et al.
 * 1998] ch. 8; docs/engine-audit.md N3, engine ≥ 0.14.0). Each day, in order:
 *
 *   1. Pe = cropped area × fraction ÷ 1000 × rain (rainOffsetM3; rain at or
 *      below the threshold is already 0 in `rainMm`);
 *   2. available = W[t−1] + Pe, not capped yet, so a big rain still covers
 *      that day's demand first, even when the store is small;
 *   3. used = MIN(available, gross), net = gross − used; available short of
 *      the gross by no more than 10⁻¹² of it counts as covering it (used =
 *      gross, net = 0, coveredByRain, engine ≥ 1.57.0);
 *   4. W[t] = MIN(Smax, MAX(0, available − used)): what is left, up to the store's
 *      size. The excess drains or runs off, and the catchment runoff model
 *      already counts that water.
 *
 * The store is kept in m³ over the cropped area (Smax = area × storeMaxMm ÷
 * 1000), so storeMaxMm = 0 gives W = 0 every day and a net demand bit for bit
 * equal to the old MAX(0, gross − Pe) (netDailyDemandM3). W starts empty.
 * `effectiveRainFraction` is one number, or one per day (the day's month's
 * value of settings.effectiveRainFractionMonthly, engine ≥ 0.43.0).
 * `warm` (engine ≥ 1.1.0, ./warmstart): start from a store of `initialM3`
 * instead of empty, and report the store at the start of day `captureAt`.
 */
export function farmDailyDemand(
	grossM3PerDay: ArrayLike<number>,
	croppedAreaM2: number,
	rainMm: ArrayLike<number>,
	effectiveRainFraction: number | ArrayLike<number>,
	storeMaxMm: number,
	warm: { initialM3?: number; captureAt?: number } = {}
): FarmDailyDemand {
	const days = grossM3PerDay.length;
	const out: FarmDailyDemand = { net: new Float64Array(days), used: new Float64Array(days), storeMm: new Float64Array(days) };
	const maxM3 = (croppedAreaM2 * storeMaxMm) / 1000;
	// One fraction for every day, or one per day (a monthly fraction, engine ≥ 0.43.0, issue #54).
	const perDay = typeof effectiveRainFraction === 'number' ? null : effectiveRainFraction;
	const one = typeof effectiveRainFraction === 'number' ? effectiveRainFraction : 0;
	let w = warm.initialM3 ?? 0;
	for (let t = 0; t < days; t++) {
		if (t === warm.captureAt) out.storeAtM3 = w;
		// A negative gross (bad crop factors) needs no water, as MAX(0, …) had it.
		const need = Math.max(0, grossM3PerDay[t]!);
		const available = w + rainOffsetM3(croppedAreaM2, rainMm[t]!, perDay ? perDay[t]! : one);
		// Rain within float noise of the need covers it: no noise-level requirement (engine ≥ 1.57.0).
		const used = coveredByRain(need, available) ? need : available;
		out.used[t] = used;
		out.net[t] = need - used;
		w = Math.min(maxM3, Math.max(0, available - used));
		out.storeMm[t] = croppedAreaM2 > 0 ? (w * 1000) / croppedAreaM2 : 0;
	}
	if (warm.captureAt === days) out.storeAtM3 = w;
	return out;
}

/**
 * A node's demand factor per water-year month (engine ≥ 0.41.0, issue #53
 * R1, set by the demand.scale scenario op), or null when it has none (1 in
 * every month). A value that isn't a finite number ≥ 0, or a missing month,
 * runs as 1 with a warning; a gauge has no demand, so its factor is ignored.
 */
export function demandFactorOf(n: NetworkNode, warnings: string[]): Float64Array | null {
	const f = n.demandFactor;
	if (f === null || f === undefined || n.kind === 'gauge') return null;
	const out = new Float64Array(12).fill(1);
	if (!Array.isArray(f) || f.length !== 12) warnings.push(`${n.kind} "${n.name}": demand factor should have 12 monthly values, has ${Array.isArray(f) ? f.length : 0}; missing months are 1`);
	if (!Array.isArray(f)) return out;
	let bad = false;
	for (let m = 0; m < 12; m++) {
		const v = f[m];
		if (v === undefined) continue;
		if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[m] = v;
		else bad = true;
	}
	if (bad) warnings.push(`${n.kind} "${n.name}": a demand factor that isn't a number ≥ 0 runs as 1`);
	return out;
}

/**
 * A unit's demand factor for one part of its demand per water-year month
 * (engine ≥ 1.45.0, issue #123, set by demand.scale with `part`), or null
 * when it has none for that part (1 in every month). A bad value runs as 1
 * with a warning, as demandFactorOf's. A farm's only.
 */
export function partDemandFactorOf(n: NetworkNode, part: DemandPart, warnings: string[]): Float64Array | null {
	const all = n.partDemandFactor;
	if (!all || typeof all !== 'object' || n.kind !== 'farm' || !Object.hasOwn(all, part)) return null;
	const f = (all as Record<string, unknown>)[part];
	if (f === null || f === undefined) return null;
	const out = new Float64Array(12).fill(1);
	if (!Array.isArray(f) || f.length !== 12) warnings.push(`unit "${n.name}": the ${part} demand factor should have 12 monthly values; missing months are 1`);
	if (!Array.isArray(f)) return out;
	let bad = false;
	for (let m = 0; m < 12; m++) {
		const v = f[m];
		if (v === undefined) continue;
		if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[m] = v;
		else bad = true;
	}
	if (bad) warnings.push(`unit "${n.name}": a ${part} demand factor that isn't a number ≥ 0 runs as 1`);
	return out;
}

/**
 * The demand factor on one part of a unit's demand (engine ≥ 1.45.0): the
 * unit's own × the part's, month by month; null when neither is set.
 */
export function unitPartFactor(n: NetworkNode, part: DemandPart, warnings: string[]): Float64Array | null {
	const a = demandFactorOf(n, warnings);
	const b = partDemandFactorOf(n, part, warnings);
	if (!a || !b) return a ?? b;
	return a.map((v, m) => v * b[m]!);
}

/**
 * The run day (0-based) from which demand factors apply
 * (settings.demandFactorFrom, engine ≥ 0.44.0, issue #53 R5): 0 when it is
 * null / absent (every day), else its day in the run, clamped to 0 when it
 * is before the run (every day) and to `days` when after it (no day).
 * `from` is already checked to be an ISO date (prepare.ts).
 */
export function demandFactorStart(from: string | null | undefined, start: number, days: number): number {
	if (from === null || from === undefined) return 0;
	return Math.min(Math.max(toEpochDay(from) - start, 0), days);
}

/**
 * Units whose return flow is more than their losses (engine ≥ 1.71.0): r above
 * 1 − e, e being the efficiency a run gives the unit (its plantings' systems
 * blended, else its own; unitIrrigationEfficiency at `apanMm`). The API refuses
 * a model with one and the editor lists it; a run caps r at 1 − e. Only farms
 * irrigate; a value outside (0, 1] runs as 1.
 */
export function returnFlowProblems(
	model: {
		nodes: readonly { id: string; name: string; kind: string; irrigationEfficiency: number; returnFlowFraction: number }[];
		crops: readonly (CropSystemInput & { cropFactor: ArrayLike<unknown> })[];
		cropAreas: readonly (PlantingSystemInput & { nodeId: string; areaM2: number })[];
		irrigationSystems?: readonly IrrigationSystemDef[] | null;
	},
	apanMm: ArrayLike<unknown>
): { nodeId: string; returnFlow: number; efficiency: number }[] {
	const resolve = plantingEfficiencyResolver(model.crops, model.irrigationSystems);
	const out: { nodeId: string; returnFlow: number; efficiency: number }[] = [];
	for (const n of model.nodes) {
		if (n.kind !== 'farm') continue;
		const own = n.irrigationEfficiency > 0 && n.irrigationEfficiency <= 1 ? n.irrigationEfficiency : 1;
		const e = unitIrrigationEfficiency(own, model.crops, unitPlantings(n.id, model.crops, model.cropAreas, resolve), apanMm);
		if (n.returnFlowFraction > 1 - e + RETURN_FLOW_SLACK) out.push({ nodeId: n.id, returnFlow: n.returnFlowFraction, efficiency: e });
	}
	return out;
}
