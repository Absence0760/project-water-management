// Irrigation demand — port of the b023 [Crop demand] / [Farm demand] /
// [Irrigation Demand] sheets. See src/network/README.md § "Irrigation demand".
//
// The workbook rounds crop mm to 2 dp, farm demand to 0.1 m³/day and net demand
// to whole m³; the engine keeps full precision (docs/engine-audit.md R1).
import { daysPerMonth, toEpochDay, type Monthly } from './calendar';
import type { NetworkNode } from './project';

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
 * A farm's irrigation efficiency from its crops' (engine ≥ 0.43.0, issue #54,
 * docs/model.md §2.3). Each crop uses its own efficiency e_c when it has one,
 * else the farm's e_f, and the farm's efficiency is their harmonic mean
 * weighted by each crop's annual gross requirement:
 *
 *   w_c = area_c × Σ_m MAX(0, cropFactor_c[m]) × MAX(0, A-pan[m])
 *   e   = Σ w_c ÷ Σ (w_c ÷ e_c)
 *
 * so the abstraction D = F ÷ e is Σ F_c ÷ e_c when each crop's share F_c of
 * the requirement F is its share of the gross, and the application losses
 * (1 − e)·G are each crop's losses summed. One number per farm, not per
 * month: the network step keeps one efficiency per farm (model.md §2.3 says
 * what that leaves out). With no A-pan anywhere the weights are area ×
 * Σ crop factor. A farm none of whose cropped crops carries its own
 * efficiency returns e_f untouched, so absent fields give bit-identical runs.
 *
 * Crops are summed in id order, as buildDemand sums them (order invariance).
 */
export function farmIrrigationEfficiency(
	farmEfficiency: number,
	crops: readonly CropEfficiencyInput[],
	areaM2ByCropId: ReadonlyMap<string, number>,
	apanMm: ArrayLike<unknown>
): number {
	const grown = crops.filter((c) => (areaM2ByCropId.get(c.id) ?? 0) > 0);
	if (!grown.some((c) => ownCropEfficiency(c.irrigationEfficiency) !== undefined)) return farmEfficiency;
	grown.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const num = (v: unknown) => {
		const x = Number(v);
		return Number.isFinite(x) && x > 0 ? x : 0;
	};
	let w = 0, wOverE = 0, k = 0, kOverE = 0;
	for (const c of grown) {
		const area = areaM2ByCropId.get(c.id)!;
		const e = ownCropEfficiency(c.irrigationEfficiency) ?? farmEfficiency;
		let byApan = 0, byFactor = 0;
		for (let m = 0; m < 12; m++) {
			const f = num(c.cropFactor[m]);
			byApan += f * num(apanMm[m]);
			byFactor += f;
		}
		w += area * byApan;
		wOverE += (area * byApan) / e;
		k += area * byFactor;
		kOverE += (area * byFactor) / e;
	}
	if (w > 0) return w / wOverE;
	if (k > 0) return k / kOverE;
	return farmEfficiency;
}

/**
 * farmIrrigationEfficiency straight from a model document: the farm's crop
 * areas (crops the model knows, summed per crop) and its A-pan. For readers
 * of a saved run (verify/checks.ts, views/farmProjection.ts) that need the
 * efficiency runModel used. `farmEfficiency` should already be the one the
 * run used (a value outside (0, 1] runs as 1).
 */
export function modelFarmEfficiency(
	farmEfficiency: number,
	nodeId: string,
	crops: readonly CropEfficiencyInput[],
	cropAreas: readonly { nodeId: string; cropId: string; areaM2: number }[],
	apanMm: ArrayLike<unknown>
): number {
	if (!crops.some((c) => ownCropEfficiency(c.irrigationEfficiency) !== undefined)) return farmEfficiency;
	const known = new Set(crops.map((c) => c.id));
	const areas = new Map<string, number>();
	const rows = cropAreas.filter((a) => a.nodeId === nodeId && known.has(a.cropId));
	// The same order buildDemand sums them in: crop id, then area.
	rows.sort((a, b) => (a.cropId < b.cropId ? -1 : a.cropId > b.cropId ? 1 : a.areaM2 - b.areaM2));
	for (const a of rows) areas.set(a.cropId, (areas.get(a.cropId) ?? 0) + a.areaM2);
	return farmIrrigationEfficiency(farmEfficiency, crops, areas, apanMm);
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
 * store-less case (effectiveRainStoreMm = 0), kept as the workbook formula.
 */
export function netDailyDemandM3(
	grossM3PerDay: number,
	croppedAreaM2: number,
	rainMm: number,
	effectiveRainFraction: number
): number {
	return Math.max(0, grossM3PerDay - rainOffsetM3(croppedAreaM2, rainMm, effectiveRainFraction));
}

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
 *   3. used = MIN(available, gross), net = gross − used;
 *   4. W[t] = MIN(Smax, available − used): what is left, up to the store's
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
		const used = Math.min(available, need);
		out.used[t] = used;
		out.net[t] = need - used;
		w = Math.min(maxM3, available - used);
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
