// Irrigation demand — port of the b023 [Crop demand] / [Farm demand] /
// [Irrigation Demand] sheets. See docs/model.md § "Irrigation demand".
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
	return apanMm.map((e, i) => e * crop.cropFactor[i]!) as unknown as Monthly;
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
		for (let m = 0; m < 12; m++) out[m]! += (area * gross[m]!) / 1000;
	}
	return out.map((v, m) => v / days[m]!) as unknown as Monthly;
}

/**
 * Net daily demand after effective rainfall (b023 [Irrigation Demand]):
 * MAX(0, gross − cropped area × effectiveRainFraction / 1000 × rain mm).
 */
export function netDailyDemandM3(
	grossM3PerDay: number,
	croppedAreaM2: number,
	rainMm: number,
	effectiveRainFraction: number
): number {
	return Math.max(0, grossM3PerDay - (croppedAreaM2 * effectiveRainFraction * rainMm) / 1000);
}
