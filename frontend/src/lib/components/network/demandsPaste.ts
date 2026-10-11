// Paste from a spreadsheet into the Demands grid, and its CSV (issue #285's
// pattern, docs/ui.md § Demands grid): a row per demand, a column per
// water-year month. Only a monthly demand object's and an other water user's
// months are stored values; a paste onto the crops or a per-unit object (made
// from other values) is left out and said so. Values are in the grid's display
// unit: `scale` is display units per m³/day (1 for m³/day), the one place a
// unit picker converts.
import { WATER_YEAR_MONTHS } from '$lib/format/months';
import { MONTH_COLS } from '$lib/components/crops/areaPaste';
import { mapPaste, sameValue, toCsv, type GridFormat, type GridRow, type PasteAnchor, type PastePlan } from '$lib/spreadsheet/paste/grid';
import type { DemandRow } from './demands';

/** Headings the first column goes by. */
const NAME_HEADINGS = ['Demand', 'Name'];
/** The CSV's other columns: read-only here, so a paste of the CSV leaves them out quietly. */
const INFO_HEADINGS = ['Unit', 'Kind', 'Water from', 'Supply order', 'Mean', 'Annual'];

/**
 * Each row's name in a paste and the CSV: the demand's own name where no other
 * row has it, else "Name (Unit)" ("Crops (Upper farm)"), so a block copied
 * from the client's own sheet matches by the names they use.
 */
export function pasteNames(rows: readonly DemandRow[]): Map<string, string> {
	const count = new Map<string, number>();
	for (const r of rows) count.set(r.name.toLowerCase(), (count.get(r.name.toLowerCase()) ?? 0) + 1);
	return new Map(rows.map((r) => [r.key, (count.get(r.name.toLowerCase()) ?? 0) > 1 && r.kind !== 'user' ? `${r.name} (${r.unit})` : r.name]));
}

/**
 * What pasting `text` would change: rows matched by name (pasteNames) or by
 * position from the anchor, months by heading ("Oct", "October", "Oct
 * (m³/day)") or by position. A value below 0 stops the paste; a value on a
 * row whose months are made from other values is left out, with a note.
 */
export function planDemandPaste(text: string, rows: readonly DemandRow[], anchor?: PasteAnchor | null, scale = 1, unit = 'm³/day'): PastePlan | { error: string } {
	const names = pasteNames(rows);
	const grid: GridRow[] = rows.map((r) => ({ id: r.key, name: names.get(r.key)! }));
	const mapped = mapPaste(text, grid, MONTH_COLS, { anchor, nameHeadings: NAME_HEADINGS, ignoreHeadings: INFO_HEADINGS });
	if ('error' in mapped) return mapped;
	const plan: PastePlan = { changes: [], unchanged: 0, notes: [...mapped.notes] };
	const computed = new Set<string>();
	for (const v of mapped.values) {
		const row = rows.find((r) => r.key === v.rowId)!;
		const m = Number(v.key);
		const name = names.get(row.key)!;
		if (v.value < 0) return { error: `${name}, ${WATER_YEAR_MONTHS[m]}: a demand of ${v.value} ${unit} is below 0.` };
		if (!row.editable) {
			computed.add(name);
			continue;
		}
		const from = row.monthlyM3Day[m]! * scale;
		if (sameValue(from, v.value)) plan.unchanged++;
		else plan.changes.push({ rowId: row.key, rowName: name, key: v.key, column: WATER_YEAR_MONTHS[m]!, unit, from, to: v.value });
	}
	if (computed.size)
		plan.notes.push(
			`Left out ${computed.size === 1 ? 'a row' : 'rows'} whose months are made from other values (the crops' planted areas, a count × litres), set in ${computed.size === 1 ? 'its' : 'their'} own form: ${[...computed].join(', ')}.`
		);
	return plan;
}

/** Write a plan's months through `set` (the row's key, the water-year month index, m³/day). */
export function applyDemandPaste(plan: PastePlan, set: (rowKey: string, month: number, m3Day: number) => void, scale = 1): void {
	for (const c of plan.changes) set(c.rowId, Number(c.key), c.to / scale);
}

/** The Demands grid's Expected format (issue #477), in the unit the table shows. */
export function demandsFormat(unit = 'm³/day'): GridFormat {
	return {
		id: 'demands-grid',
		title: 'Demands by month',
		where: 'Network → Tables → Demands → Paste from a spreadsheet',
		rules: [
			`A heading row: ${NAME_HEADINGS[0]}, then the months Oct to Sep (or October to September), in any order; the CSV's other columns (Unit, Kind, Mean, Annual) are read past.`,
			'A row per demand, its name first; a name two rows share takes its unit in brackets, as the CSV writes it. A demand the table doesn’t have is left out: add it on its unit first.',
			`Values in ${unit}, the unit the table shows. Only a monthly demand object's and another water user's months take a paste. A blank or a dash leaves a month as it is.`
		],
		example: toCsv([
			[NAME_HEADINGS[0]!, ...WATER_YEAR_MONTHS],
			['Town supply', 120, 120, 130, 140, 140, 130, 110, 100, 95, 95, 100, 110]
		]),
		exampleName: 'demands-example.csv'
	};
}

/** The Demands grid as a CSV: every row as shown, months in the display unit, to fill in and paste back. */
export function demandsCsv(rows: readonly DemandRow[], scale = 1, unit = 'm³/day'): string {
	const names = pasteNames(rows);
	return toCsv([
		[NAME_HEADINGS[0]!, 'Unit', 'Kind', 'Water from', 'Supply order', ...WATER_YEAR_MONTHS.map((m) => `${m} (${unit})`), `Mean (${unit})`, 'Annual (Mm³/a)'],
		...rows.map((r) => [
			names.get(r.key)!,
			r.kind === 'user' ? '' : r.unit,
			r.what,
			r.from,
			r.order ?? '',
			...r.monthlyM3Day.map((v) => v * scale),
			r.meanM3Day * scale,
			r.annualMm3
		])
	]);
}
