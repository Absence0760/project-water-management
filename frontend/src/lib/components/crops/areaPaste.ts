// The Crops grids' paste from a spreadsheet (issue #285): the planted areas,
// hectares per hydrological unit (rows) and crop (columns), and the crop
// factors, a crop's 12 water-year months (rows: crops; columns: Oct … Sep).
// The block is read by $lib/spreadsheet/paste (shared with the node table and
// the Reserve rule tables); this file turns hectares into the m² the model
// stores and checks each value is 0 or more.
import type { Crop, CropArea, NetworkNode } from '@water-management/engine';
import { WATER_YEAR_MONTHS } from '$lib/format/months';
import { mapPaste, sameValue, toCsv, type GridFormat, type PasteAnchor, type PastePlan } from '$lib/spreadsheet/paste/grid';
import { MONTH_COLS } from '$lib/spreadsheet/paste/monthlyRows';

export { LONG_MONTHS, MONTH_COLS } from '$lib/spreadsheet/paste/monthlyRows';

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
const CROP_HEADINGS = ['Crop', 'Name', 'Crop type'];
/** Columns a crop list from elsewhere may carry beside the months: left out quietly. */
const CROP_INFO_HEADINGS = ['Irrigation system', 'Annual'];

type FactorCrop = Pick<Crop, 'id' | 'name'> & { cropFactor: readonly number[] };

/**
 * What pasting `text` into the crop-factor grid would change: rows matched by
 * the crop's name (or by position from `anchor`), columns by the month ("Oct",
 * "October") or by position. A blank or a dash leaves a factor as it is; 0 is
 * a month the crop isn't irrigated; below 0 stops the paste. With `addCrops`
 * (the Crop factors grid, issue #477), a name the project doesn't have is a
 * new crop with the pasted factors (its blank months 0), so a list of crop
 * types comes in from a spreadsheet; without it (one crop's sheet) the name
 * is left out.
 */
export function planFactorPaste(text: string, crops: readonly FactorCrop[], anchor?: PasteAnchor | null, opts: { addCrops?: boolean } = {}): PastePlan | { error: string } {
	const mapped = mapPaste(text, crops, MONTH_COLS, { anchor, nameHeadings: CROP_HEADINGS, ignoreHeadings: CROP_INFO_HEADINGS, addRows: opts.addCrops });
	if ('error' in mapped) return mapped;
	const plan: PastePlan = { changes: [], unchanged: 0, notes: [...mapped.notes], added: mapped.added };
	for (const v of mapped.values) {
		const isNew = v.rowId.startsWith('new:');
		const name = (isNew ? mapped.added.find((a) => a.id === v.rowId)!.name : crops.find((c) => c.id === v.rowId)!.name) || '(unnamed)';
		const m = Number(v.key);
		const month = WATER_YEAR_MONTHS[m]!;
		if (v.value < 0) return { error: `${name}, ${month}: a crop factor of ${v.value} is below 0.` };
		const from = isNew ? null : (crops.find((c) => c.id === v.rowId)!.cropFactor[m] ?? 0);
		if (sameValue(from, v.value)) plan.unchanged++;
		else plan.changes.push({ rowId: v.rowId, rowName: isNew ? `${name} (new crop)` : name, key: v.key, column: month, unit: '', from, to: v.value });
	}
	if (mapped.added.length)
		plan.notes.push(
			`Adds ${mapped.added.length === 1 ? 'a crop' : `${mapped.added.length} crops`} the project doesn't have: ${mapped.added.map((a) => a.name).join(', ')}. ${mapped.added.length === 1 ? 'It starts' : 'Each starts'} on drip irrigation, as + Add crop does; a blank month is 0.`
		);
	return plan;
}

/**
 * Write a plan's factors through `set` (the crop's id, the water-year month
 * index, the factor). A crop the plan adds is made by `add` first (its name;
 * it returns the new crop's id), so even one with every month blank is added.
 */
export function applyFactorPaste(plan: PastePlan, set: (cropId: string, month: number, factor: number) => void, add?: (name: string) => string): void {
	const ids = new Map((plan.added ?? []).map((a) => [a.id, add ? add(a.name) : null]));
	for (const c of plan.changes) {
		const id = c.rowId.startsWith('new:') ? ids.get(c.rowId) : c.rowId;
		if (id) set(id, Number(c.key), c.to);
	}
}

/** The crop-factor grid as a CSV to fill in and paste back: a row per crop, a column per water-year month. */
export function cropFactorsCsv(crops: readonly FactorCrop[]): string {
	return toCsv([[CROP_HEADINGS[0]!, ...WATER_YEAR_MONTHS], ...crops.map((c) => [c.name, ...WATER_YEAR_MONTHS.map((_, i) => c.cropFactor[i] ?? 0)])]);
}

/** The Planted areas grid's Expected format (issue #477). */
export const PLANTED_AREAS_FORMAT: GridFormat = {
	id: 'planted-areas-grid',
	title: 'Planted areas, a column per crop',
	where: 'Crops & demand → Tables → Planted areas → Paste from a spreadsheet',
	rules: [
		'A heading row: Farm (or Hydrological unit), then a column per crop, named as the project names it (an "(ha)" after the name is fine).',
		'A row per hydrological unit, its name first. A unit or crop the project doesn’t have is left out: add it first.',
		'Areas in hectares. 0 clears an area; a blank or a dash leaves it as it is.'
	],
	example: 'Farm,Citrus (ha),Maize (ha)\r\nUpper farm,30,12.5\r\nLower farm,0,40\r\n',
	exampleName: 'planted-areas-example.csv'
};

/** The Crop factors grid's Expected format (issue #477): crop types and their monthly factors. */
export const CROP_FACTORS_FORMAT: GridFormat = {
	id: 'crop-factors-grid',
	title: 'Crop factors',
	where: 'Crops & demand → Tables → Crop factors → Paste from a spreadsheet',
	rules: [
		'A heading row: Crop, then the months Oct to Sep (or October to September), in any order.',
		'A row per crop, its name first. A name the project doesn’t have adds that crop, on drip irrigation; a known name updates its factors.',
		'Each month’s crop factor multiplies A-pan (not an FAO Kc): 0 is a month the crop isn’t irrigated. A blank or a dash leaves a month as it is (0 for a new crop).'
	],
	example: 'Crop,Oct,Nov,Dec,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep\r\nCitrus,0.6,0.6,0.65,0.65,0.65,0.6,0.55,0.5,0.5,0.5,0.55,0.6\r\nMaize,0,0.4,0.8,1.05,1.05,0.7,0.3,0,0,0,0,0\r\n',
	exampleName: 'crop-factors-example.csv'
};
