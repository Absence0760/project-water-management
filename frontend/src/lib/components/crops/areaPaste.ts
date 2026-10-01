// The planted-areas grid's paste from a spreadsheet (issue #285): hectares
// per hydrological unit (rows) and crop (columns). The block is read by
// $lib/spreadsheet/paste (shared with the node table and the Reserve rule
// tables); this file turns hectares into the m² the model stores.
import type { Crop, CropArea, NetworkNode } from '@water-management/engine';
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
