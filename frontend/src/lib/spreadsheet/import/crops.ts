// [Crop demand] (crop factors, A-pan evaporation, effective rainfall) and
// [Farm demand] (crop areas per farm, and the gross demand checked against
// them): extract_project.py read_crops, read_crop_areas and gross_demand_note.
import type { DemandObject } from '@water-management/engine';
import { clean, isName, num, pyRepr } from './cells';
import { InvalidWorkbookError } from './errors';
import type { Report } from './report';
import type { B023Workbook } from './workbook';

export const MONTHS_WY = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];

export interface CropTable {
	crops: { name: string; cropFactor: number[] }[];
	/** A-pan evaporation, mm per water-year month. */
	apan: number[];
	effectiveRainFraction: number;
}

/** read_crops(). */
export function readCrops(wb: B023Workbook, report: Report): CropTable {
	const { sheet, rows, names } = wb.tableRows('zCropDemand_CropNameLst');
	const { c1: fc1, r1: hr, c2: fc2 } = wb.ref('zCropDemand_FactorsTbl');
	const header = wb.block(sheet, fc1, hr, fc2 + 14, hr)[0]!.map(clean);
	const oct = header.indexOf('Oct');
	if (oct < 0) throw new InvalidWorkbookError("[Crop demand] factor header has no 'Oct' column", sheet);
	const c0 = fc1 + oct;
	const months = Array.from({ length: 12 }, (_, i) => header[oct + i]);
	if (months.some((m, i) => m !== MONTHS_WY[i])) {
		// Python indexes past the header's end with an IndexError; either way the import stops.
		throw new InvalidWorkbookError(`[Crop demand] factor months are not Oct..Sep: ${pyRepr(header)}`, sheet);
	}
	const crops = rows.map((r, i) => ({
		name: names[i]!,
		cropFactor: Array.from({ length: 12 }, (_, m) =>
			report.num(wb.cell(sheet, c0 + m, r), { sheet, col: c0 + m, row: r, what: `${MONTHS_WY[m]} crop factor`, element: names[i]! })
		)
	}));
	// A-pan row: the last row above the factor table whose label mentions A-pan.
	const labelCol = wb.ref('zCropDemand_CropNameLst').c1;
	let apan: number[] | null = null;
	for (let r = Math.max(1, hr - 20); r <= hr - 1; r++) {
		const label = wb.block(sheet, labelCol, r, c0 - 1, r)[0]!.map(clean).join(' ');
		if (label.toLowerCase().includes('a-pan')) {
			apan = Array.from({ length: 12 }, (_, m) => report.num(wb.cell(sheet, c0 + m, r), { sheet, col: c0 + m, row: r, what: `${MONTHS_WY[m]} A-pan evaporation` }));
		}
	}
	if (apan === null) throw new InvalidWorkbookError("[Crop demand] has no 'A-pan' evaporation row", sheet);
	const erf = wb.ref('rCropDemand_EffectiveRainfall');
	return {
		crops,
		apan,
		effectiveRainFraction: report.num(wb.cell(erf.sheet, erf.c1, erf.r1), { sheet: erf.sheet, col: erf.c1, row: erf.r1, what: 'Effective rainfall' }, 0.65)
	};
}

/** read_crop_areas(): m² per crop per farm, by farm name then crop name (Python dict order and overwrite rules). */
export function readCropAreas(wb: B023Workbook, report: Report): Map<string, Map<string, number>> {
	const { sheet, rows, names } = wb.tableRows('zFarmDemand_FarmNameLst');
	const { c1: cc1, r1: hr, c2: cc2 } = wb.ref('zFarmDemand_CropNameLst');
	const cropCols: [number, string][] = [];
	for (let c = cc1; c <= cc2; c++) {
		const v = wb.cell(sheet, c, hr);
		if (isName(v)) cropCols.push([c, clean(v)]);
	}
	const areas = new Map<string, Map<string, number>>();
	rows.forEach((r, i) => {
		const farm = names[i]!;
		const perCrop = new Map<string, number>();
		for (const [c, crop] of cropCols) perCrop.set(crop, report.num(wb.cell(sheet, c, r), { sheet, col: c, row: r, what: `${crop} area`, element: farm }));
		areas.set(farm, perCrop);
	});
	return areas;
}

/** read_crop_areas()'s gross part: the sheet's gross demand (m³/day per month) by farm, and its days per month (null without zFarmDemand_GrossMthDays). */
export function readFarmGross(wb: B023Workbook): { gross: Map<string, number[]>; days: number[] | null } {
	const { sheet, rows, names } = wb.tableRows('zFarmDemand_FarmNameLst');
	const { c1: gc1, c2: gc2 } = wb.ref('zFarmDemand_GrossMth');
	const gross = new Map<string, number[]>();
	rows.forEach((r, i) => gross.set(names[i]!, wb.block(sheet, gc1, r, gc2, r)[0]!.map((v) => num(v))));
	const days = wb.has('zFarmDemand_GrossMthDays') ? wb.named('zFarmDemand_GrossMthDays')[0]!.map((v) => num(v)) : null;
	return { gross, days };
}

// A month's gross demand doesn't follow from the crop areas when it differs
// from Σ area × factor × A-pan / 1000 / days by more than both of these: the
// sheet rounds to 0.1 m³/day and each crop's gross mm to 0.01.
const GROSS_DEMAND_TOLERANCE_M3_DAY = 1.0;
const GROSS_DEMAND_TOLERANCE_REL = 0.01;

/** crop_formula(): [Farm demand]'s crop formula per month, Σ area × factor × A-pan / 1000 / days (m³/day). */
function cropFormula(perCrop: Map<string, number>, factors: Map<string, number[]>, apan: number[], days: number[]): number[] {
	return Array.from({ length: 12 }, (_, m) => {
		let sum = 0;
		for (const [crop, a] of perCrop) {
			const f = factors.get(crop);
			if (f) sum += (a * f[m]! * apan[m]!) / 1000 / days[m]!;
		}
		return sum;
	});
}

/** gross_demand_off(): the months whose gross demand differs from the crop formula by more than the sheet's rounding. */
function grossDemandOff(gross: number[], formula: number[]): number[] {
	const out: number[] = [];
	for (let m = 0; m < 12; m++) {
		if (Math.abs(gross[m]! - formula[m]!) > Math.max(GROSS_DEMAND_TOLERANCE_M3_DAY, GROSS_DEMAND_TOLERANCE_REL * Math.max(Math.abs(gross[m]!), Math.abs(formula[m]!)))) out.push(m);
	}
	return out;
}

/**
 * non_crop_demand(): what a farm's gross demand has above its crop formula,
 * per month (m³/day), or null. Only the months off by more than the sheet's
 * rounding count, and only where the workbook is higher: a town's potable
 * demand typed over the formula (issue #54, 2b). Where the workbook is lower
 * (a formula that skips a crop) the crop areas win, as before.
 */
export function nonCropDemand(perCrop: Map<string, number>, gross: number[], factors: Map<string, number[]>, apan: number[], days: number[]): number[] | null {
	const formula = cropFormula(perCrop, factors, apan, days);
	const off = new Set(grossDemandOff(gross, formula));
	const surplus = Array.from({ length: 12 }, (_, m) => (off.has(m) && gross[m]! > formula[m]! ? gross[m]! - formula[m]! : 0));
	return surplus.some((v) => v > 0) ? surplus : null;
}

export const NON_CROP_DEMAND_NAME = 'Non-crop demand';

/**
 * non_crop_demand_object(): the demand object for a farm's non-crop demand
 * (engine 1.7.0, docs/model.md §2.7f), supplied with its crops and returning
 * the farm's irrigation return flow %, so what it takes and gives back is the
 * workbook's. A farm with no crops is a town or scheme (municipal).
 */
export function nonCropDemandObject(uid: (key: string) => string, farm: string, nodeId: string, monthly: number[], cropped: boolean, returnPct: number): DemandObject {
	return {
		id: uid(`demand-object:${farm}`),
		nodeId,
		name: NON_CROP_DEMAND_NAME,
		category: cropped ? 'other' : 'municipal',
		sizing: 'monthly',
		monthlyM3Day: monthly,
		count: null,
		litresPerUnitDay: null,
		lossPct: 0,
		monthlyFactor: null,
		returnPct: Math.min(Math.max(returnPct, 0), 1),
		priority: 'shared',
		destination: 'internal',
		enabled: true,
		// The workbook's typed-over demand is neither a meter record, an AADD nor a norm by rule (engine 1.56.0).
		source: 'other',
		note: 'b023 [Farm demand]: the gross demand above what the crop areas give (typed over the crop formula)'
	};
}

/**
 * gross_demand_note(): a WARNING when a farm's gross demand doesn't follow
 * from its crop areas: a non-crop demand typed over the formula, or a
 * formula whose crop index is blank so it skips that crop (issue #54), saying what the import did: the part above the
 * crop areas becomes a demand object (nonCropDemand), the crop areas win below.
 */
export function grossDemandNote(
	farm: string,
	perCrop: Map<string, number>,
	gross: number[],
	factors: Map<string, number[]>,
	apan: number[],
	days: number[]
): string | null {
	const formula = cropFormula(perCrop, factors, apan, days);
	const off = grossDemandOff(gross, formula);
	if (off.length === 0) return null;
	const mean = (xs: number[]) => Math.floor(xs.reduce((a, b) => a + b, 0) / 12 + 0.5);
	const surplus = nonCropDemand(perCrop, gross, factors, apan, days);
	const below = off.filter((m) => gross[m]! < formula[m]!).length;
	const head =
		`WARNING: [Farm demand] ${farm}: the gross demand in ${off.length} of 12 months doesn't follow from its crop areas ` +
		`(a value typed over the formula, or a formula that skips a crop): the workbook has ${mean(gross)} ` +
		`m³/day on average, the crop areas give ${mean(formula)}. `;
	if (surplus === null) return head + 'The app computes demand from the crop areas, so it models the second figure (issue #54, 2b)';
	let text =
		head +
		`The part above the crop areas, ${mean(surplus)} m³/day on average, is imported as the demand object ` +
		`"${NON_CROP_DEMAND_NAME}" (supplied with the crops, returning the farm's return flow %), so the modelled demand ` +
		"follows the workbook's; confirm its category, priority and return share (issue #54, 2b)";
	if (below) text += `. In ${below} month(s) the crop areas give more than the workbook, and the app models the crop areas there`;
	return text;
}
