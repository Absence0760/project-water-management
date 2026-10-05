// The Crops grids' paste from a spreadsheet (issue #285): the planted areas,
// hectares per hydrological unit (rows) and crop (columns), and the crop
// factors, a crop's 12 water-year months (rows: crops; columns: Oct … Sep).
// The block is read by $lib/spreadsheet/paste (shared with the node table and
// the Reserve rule tables); this file turns hectares into the m² the model
// stores and checks each value is 0 or more.
import type { Crop, CropArea, NetworkNode } from '@water-management/engine';
import { WATER_YEAR_MONTHS } from '$lib/format/months';
import { mapPaste, sameValue, toCsv, type PasteAnchor, type PastePlan } from '$lib/spreadsheet/paste/grid';

const M2_PER_HA = 10_000;
/** Headings the grid's first column goes by. */
const NAME_HEADINGS = ['Farm', 'Hydrological unit', 'Name', 'Node'];

type Farm = Pick<NetworkNode, 'id' | 'name'>;
type Areas = readonly Pick<CropArea, 'nodeId' | 'cropId' | 'areaM2'>[];

const areaHa = (areas: Areas, nodeId: string, cropId: string) => (areas.find((a) => a.nodeId === nodeId && a.cropId === cropId)?.areaM2 ?? 0) / M2_PER_HA;

/**
 * What pasting `text` into the planted-areas grid would change: hectares,
 * rows matched by the hydrological unit's name (or by position from
 * `anchor`), columns by the crop's name (or by position). A blank or a dash
 * leaves an area as it is; 0 clears it; below 0 stops the paste.
 */
export function planAreaPaste(text: string, farms: readonly Farm[], crops: readonly Pick<Crop, 'id' | 'name'>[], areas: Areas, anchor?: PasteAnchor | null): PastePlan | { error: string } {
	const cols = crops.map((c) => ({ key: c.id, labels: [c.name || '(unnamed)'] }));
	const mapped = mapPaste(text, farms, cols, { anchor, nameHeadings: NAME_HEADINGS });
	if ('error' in mapped) return mapped;
	const plan: PastePlan = { changes: [], unchanged: 0, notes: [...mapped.notes] };
	for (const v of mapped.values) {
		const farm = farms.find((f) => f.id === v.rowId)!;
		const crop = crops.find((c) => c.id === v.key)!;
		if (v.value < 0) return { error: `${farm.name || '(unnamed)'}, ${crop.name || '(unnamed)'}: ${v.value} ha is below 0.` };
		const from = areaHa(areas, farm.id, crop.id);
		if (sameValue(from, v.value)) plan.unchanged++;
		else plan.changes.push({ rowId: farm.id, rowName: farm.name || '(unnamed)', key: crop.id, column: crop.name || '(unnamed)', unit: 'ha', from, to: v.value });
	}
	return plan;
}

/** Write a plan's changes through the editor's setter (0 removes the row, keeping the document sparse). */
export function applyAreaPaste(plan: PastePlan, set: (nodeId: string, cropId: string, areaM2: number) => void): void {
	for (const c of plan.changes) set(c.rowId, c.key, Math.round(c.to * M2_PER_HA * 1e6) / 1e6);
}

/** The planted-areas grid as a CSV, in hectares, to fill in and paste back: a row per hydrological unit, a column per crop. */
export function plantedAreasCsv(farms: readonly Farm[], crops: readonly Pick<Crop, 'id' | 'name'>[], areas: Areas): string {
	return toCsv([[NAME_HEADINGS[0]!, ...crops.map((c) => `${c.name || '(unnamed)'} (ha)`)], ...farms.map((f) => [f.name, ...crops.map((c) => areaHa(areas, f.id, c.id))])]);
}

// --- crop factors: a row per crop, a column per water-year month ---

/** Headings the crop-factor grid's first column goes by. */
const CROP_HEADINGS = ['Crop', 'Name'];
export const LONG_MONTHS = ['October', 'November', 'December', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September'];
/** The month columns: "Oct" or "October", keyed by the water-year index. */
export const MONTH_COLS = WATER_YEAR_MONTHS.map((m, i) => ({ key: String(i), labels: [m, LONG_MONTHS[i]!] }));

type FactorCrop = Pick<Crop, 'id' | 'name'> & { cropFactor: readonly number[] };

/**
 * What pasting `text` into the crop-factor grid would change: rows matched by
 * the crop's name (or by position from `anchor`), columns by the month ("Oct",
 * "October") or by position. A blank or a dash leaves a factor as it is; 0 is
 * a month the crop isn't irrigated; below 0 stops the paste.
 */
export function planFactorPaste(text: string, crops: readonly FactorCrop[], anchor?: PasteAnchor | null): PastePlan | { error: string } {
	const mapped = mapPaste(text, crops, MONTH_COLS, { anchor, nameHeadings: CROP_HEADINGS });
	if ('error' in mapped) return mapped;
	const plan: PastePlan = { changes: [], unchanged: 0, notes: [...mapped.notes] };
	for (const v of mapped.values) {
		const crop = crops.find((c) => c.id === v.rowId)!;
		const m = Number(v.key);
		const month = WATER_YEAR_MONTHS[m]!;
		if (v.value < 0) return { error: `${crop.name || '(unnamed)'}, ${month}: a crop factor of ${v.value} is below 0.` };
		const from = crop.cropFactor[m] ?? 0;
		if (sameValue(from, v.value)) plan.unchanged++;
		else plan.changes.push({ rowId: crop.id, rowName: crop.name || '(unnamed)', key: v.key, column: month, unit: '', from, to: v.value });
	}
	return plan;
}

/** Write a plan's factors through `set` (the crop's id, the water-year month index, the factor). */
export function applyFactorPaste(plan: PastePlan, set: (cropId: string, month: number, factor: number) => void): void {
	for (const c of plan.changes) set(c.rowId, Number(c.key), c.to);
}

/** The crop-factor grid as a CSV to fill in and paste back: a row per crop, a column per water-year month. */
export function cropFactorsCsv(crops: readonly FactorCrop[]): string {
	return toCsv([[CROP_HEADINGS[0]!, ...WATER_YEAR_MONTHS], ...crops.map((c) => [c.name, ...WATER_YEAR_MONTHS.map((_, i) => c.cropFactor[i] ?? 0)])]);
}
