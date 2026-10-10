// Paste from a spreadsheet into the irrigation systems (issue #477, the grids'
// pattern of issue #285; docs/ui.md § Irrigation systems): a row per system,
// its name first, and its efficiency in %. A name the table has updates that
// system's efficiency (every crop on it follows); a name it doesn't have adds
// a system of the scheme's own, which then needs its efficiency. The block is
// mapped by $lib/spreadsheet/paste/grid.ts.
import type { IrrigationSystemDef } from '@water-management/engine';
import { mapPaste, sameValue, toCsv, type GridFormat, type PasteAnchor, type PastePlan } from '$lib/spreadsheet/paste/grid';
import { sabiRange } from '$lib/model/systems';

/** Headings the first column goes by. */
const NAME_HEADINGS = ['System', 'Irrigation system', 'Name'];
/** The CSV's read-only columns: left out quietly. */
const INFO_HEADINGS = ['SABI range', 'Used by'];
const COLS = [{ key: 'efficiency', labels: ['Efficiency', 'Efficiency %', 'Application efficiency'] }];

type System = Pick<IrrigationSystemDef, 'id' | 'name' | 'efficiency' | 'preset'>;

/**
 * What pasting `text` would change: efficiencies (%, above 0 and at most
 * 100; 85% and 85 alike), rows by the system's name, or by position from the
 * anchor. A value of 1 or less reads as a fraction typed as one (0.85), which
 * the paste refuses rather than guess; a new system without an efficiency
 * stops it too.
 */
export function planSystemPaste(text: string, systems: readonly System[], anchor?: PasteAnchor | null): PastePlan | { error: string } {
	const rows = systems.map((s) => ({ id: s.id, name: s.name || '(unnamed)' }));
	const mapped = mapPaste(text, rows, COLS, { anchor, nameHeadings: NAME_HEADINGS, ignoreHeadings: INFO_HEADINGS, addRows: true });
	if ('error' in mapped) return mapped;
	const plan: PastePlan = { changes: [], unchanged: 0, notes: [...mapped.notes], added: mapped.added };
	for (const v of mapped.values) {
		const isNew = v.rowId.startsWith('new:');
		const name = isNew ? mapped.added.find((a) => a.id === v.rowId)!.name : rows.find((r) => r.id === v.rowId)!.name;
		if (v.value > 100) return { error: `${name}: an efficiency of ${v.value} % is above 100 %.` };
		if (v.value <= 0) return { error: `${name}: an efficiency of ${v.value} % isn't above 0.` };
		if (v.value <= 1) return { error: `${name}: is ${v.value} a fraction? Write the efficiency as a percentage (${Math.round(v.value * 1000) / 10}, not ${v.value}).` };
		const from = isNew ? null : Math.round(systems.find((s) => s.id === v.rowId)!.efficiency * 100 * 1e9) / 1e9;
		if (sameValue(from, v.value)) plan.unchanged++;
		else plan.changes.push({ rowId: v.rowId, rowName: isNew ? `${name} (new system)` : name, key: 'efficiency', column: 'Efficiency', unit: '%', from, to: v.value });
	}
	const bare = mapped.added.filter((a) => !mapped.values.some((v) => v.rowId === a.id));
	if (bare.length) return { error: `${bare.map((a) => a.name).join(', ')} ${bare.length === 1 ? 'is a new system' : 'are new systems'}: give ${bare.length === 1 ? 'its' : 'each'} efficiency (%).` };
	if (mapped.added.length)
		plan.notes.push(`Adds ${mapped.added.length === 1 ? 'a system' : `${mapped.added.length} systems`} the project doesn't have: ${mapped.added.map((a) => a.name).join(', ')}.`);
	return plan;
}

/**
 * Write a plan's efficiencies (as fractions) through `set`; a system the plan
 * adds is made by `add` first (its name; it returns the new row's id).
 */
export function applySystemPaste(plan: PastePlan, set: (systemId: string, efficiency: number) => void, add: (name: string) => string): void {
	const ids = new Map((plan.added ?? []).map((a) => [a.id, add(a.name)]));
	for (const c of plan.changes) set(c.rowId.startsWith('new:') ? ids.get(c.rowId)! : c.rowId, Math.round(c.to * 1e7) / 1e9);
}

/** The systems as a CSV to fill in and paste back: System, Efficiency (%), and SABI's range where a row started as one. */
export function systemsCsv(systems: readonly System[]): string {
	return toCsv([['System', 'Efficiency (%)', 'SABI range'], ...systems.map((s) => [s.name, s.efficiency * 100, sabiRange(s) ?? ''])]);
}

/** The Expected format of the systems' paste (issue #477). */
export const SYSTEMS_FORMAT: GridFormat = {
	id: 'irrigation-systems-grid',
	title: 'Irrigation systems',
	where: 'Crops & demand → Tables → Irrigation systems → Paste from a spreadsheet',
	rules: [
		'A heading row: System, Efficiency (%). A SABI range or Used by column may stay; the paste leaves it out.',
		'A row per system, its name first. A name the project has updates its efficiency, and every crop on it follows; a new name adds a system of the scheme’s own.',
		'Efficiency is the application efficiency in %, above 1 and at most 100 (85 or 85%, not 0.85).'
	],
	example: 'System,Efficiency (%)\r\nDrip,92\r\nCentre pivot / linear move,82.5\r\nScheme canal and furrow,62\r\n',
	exampleName: 'irrigation-systems-example.csv'
};
