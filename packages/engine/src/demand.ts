// Irrigation demand — port of the b023 [Crop demand] / [Farm demand] /
// [Irrigation Demand] sheets. See src/network/README.md § "Irrigation demand".
//
// The workbook rounds crop mm to 2 dp, farm demand to 0.1 m³/day and net demand
// to whole m³; the engine keeps full precision (docs/engine-audit.md R1).
import { daysPerMonth, type Monthly } from './calendar';

export interface Crop {
	id: string;
	name: string;
	/** Crop factor per water-year month (Oct–Sep). */
	cropFactor: Monthly;
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
 */
export function farmDailyDemand(
	grossM3PerDay: ArrayLike<number>,
	croppedAreaM2: number,
	rainMm: ArrayLike<number>,
	effectiveRainFraction: number,
	storeMaxMm: number
): FarmDailyDemand {
	const days = grossM3PerDay.length;
	const out: FarmDailyDemand = { net: new Float64Array(days), used: new Float64Array(days), storeMm: new Float64Array(days) };
	const maxM3 = (croppedAreaM2 * storeMaxMm) / 1000;
	let w = 0;
	for (let t = 0; t < days; t++) {
		// A negative gross (bad crop factors) needs no water, as MAX(0, …) had it.
		const need = Math.max(0, grossM3PerDay[t]!);
		const available = w + rainOffsetM3(croppedAreaM2, rainMm[t]!, effectiveRainFraction);
		const used = Math.min(available, need);
		out.used[t] = used;
		out.net[t] = need - used;
		w = Math.min(maxM3, available - used);
		out.storeMm[t] = croppedAreaM2 > 0 ? (w * 1000) / croppedAreaM2 : 0;
	}
	return out;
}
