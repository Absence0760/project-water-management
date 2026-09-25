// [Crop demand] (crop factors, A-pan evaporation, effective rainfall) and
// [Farm demand] (crop areas per farm): extract_project.py read_crops and
// read_crop_areas.
import { clean, isName, pyRepr } from './cells';
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
