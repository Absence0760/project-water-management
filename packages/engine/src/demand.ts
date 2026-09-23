// Irrigation demand — port of the b023 [Crop demand] / [Farm demand] /
// [Irrigation Demand] sheets. See src/network/README.md § "Irrigation demand".
//
// Each helper takes an optional rounding precision. Left out, the maths is
// exact; runModel passes the workbook's precisions (WBT_PRECISION) so results
// match the spreadsheet cell for cell.
import { daysPerMonth, type Monthly } from './calendar';
import { excelRound } from './network/round';

export interface Crop {
	id: string;
	name: string;
	/** Crop factor per water-year month (Oct–Sep). */
	cropFactor: Monthly;
}

const maybeRound = (v: number, digits: number | undefined) =>
	digits === undefined ? v : excelRound(v, digits);

/**
 * Gross crop water requirement in mm for each water-year month:
 * WR90 A-pan evaporation × crop factor (b023 rounds to 2 decimals).
 */
export function grossCropMm(apanMm: Monthly, crop: Crop, precision?: number): Monthly {
	return apanMm.map((e, i) => maybeRound(e * (crop.cropFactor[i] ?? 0), precision)) as unknown as Monthly;
}

export interface FarmDemandPrecision {
	/** Rounding of the per-crop gross mm (b023: 2). */
	cropMm?: number;
	/** Rounding of the farm's m³/day figure (b023: 1). */
	farmM3Day?: number;
}

/**
 * Gross farm demand in m³/day for each water-year month:
 * Σ(crop area m² × gross mm) / 1000 / days in month.
 */
export function grossFarmDemandM3PerDay(
	apanMm: Monthly,
	crops: readonly Crop[],
	areaM2ByCropId: ReadonlyMap<string, number>,
	februaryDays = 28.25,
	precision: FarmDemandPrecision = {}
): Monthly {
	const days = daysPerMonth(februaryDays);
	const out = new Array<number>(12).fill(0);
	for (const crop of crops) {
		const area = areaM2ByCropId.get(crop.id) ?? 0;
		if (area === 0) continue;
		const gross = grossCropMm(apanMm, crop, precision.cropMm);
		for (let m = 0; m < 12; m++) out[m]! += area * gross[m]!;
	}
	return out.map((v, m) => maybeRound(v / 1000 / days[m]!, precision.farmM3Day)) as unknown as Monthly;
}

/**
 * Net daily demand after effective rainfall (b023 [Irrigation Demand]):
 * MAX(0, gross − cropped area × effectiveRainFraction / 1000 × rain mm),
 * rounded to whole m³ in the workbook.
 */
export function netDailyDemandM3(
	grossM3PerDay: number,
	croppedAreaM2: number,
	rainMm: number,
	effectiveRainFraction: number,
	precision?: number
): number {
	// Same operand order as the workbook: (area × fraction/1000) × rain.
	const rainOffset = croppedAreaM2 * (effectiveRainFraction / 1000) * rainMm;
	return maybeRound(Math.max(0, grossM3PerDay - rainOffset), precision);
}
