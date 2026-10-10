// A paste into rows of twelve water-year months (issue #477): the transfers'
// max rates and the monthly evaporation settings (A-pan, pan coefficient).
// The block is mapped by ./grid.ts mapPaste, as the crop-factor and Demands
// grids' are; this file says what a row's months are, checks each value
// against the row's range, and writes the grid back as a CSV. What a value
// means beyond its range (a rate in the picked unit, m³/s stored) is the
// caller's business: components/transfers/transfersPaste.ts and
// components/settings/monthlyPaste.ts.
import { WATER_YEAR_MONTHS } from '$lib/format/months';
import { fmtNum } from '$lib/format/number';
import { mapPaste, sameValue, toCsv, type GridColumn, type PasteAnchor, type PastePlan } from './grid';

export const LONG_MONTHS = ['October', 'November', 'December', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September'];
/** The month columns: "Oct" or "October", keyed by the water-year index. */
export const MONTH_COLS: readonly GridColumn[] = WATER_YEAR_MONTHS.map((m, i) => ({ key: String(i), labels: [m, LONG_MONTHS[i]!] }));

/** One row of twelve months, in the unit the page shows it in. */
export interface MonthlyRow {
	id: string;
	name: string;
	aliases?: readonly string[];
	/** The unit the values are in ("mm", "m³/s"; "" for a factor). */
	unit: string;
	/** Twelve values, water-year order (Oct first). */
	values: readonly number[];
	/** Default 0. */
	min?: number;
	max?: number;
}

export interface MonthlyPasteOptions {
	anchor?: PasteAnchor | null;
	/** Headings the first column goes by ("Transfer", "Parameter"). */
	nameHeadings?: string[];
	/** The CSV's other columns (From, To, Unit): left out quietly. */
	ignoreHeadings?: string[];
}

const withUnit = (v: number, unit: string) => `${fmtNum(v, 4, true)}${unit ? ` ${unit}` : ''}`;

/**
 * What pasting `text` would change: rows matched by name or alias (or by
 * position from the anchor), months by heading ("Oct", "October", "Oct
 * (mm)") or by position. A blank or a dash leaves a month as it is; a value
 * outside the row's range stops the paste with its row and month.
 */
export function planMonthlyPaste(text: string, rows: readonly MonthlyRow[], opts: MonthlyPasteOptions = {}): PastePlan | { error: string } {
	const mapped = mapPaste(text, rows, MONTH_COLS, { anchor: opts.anchor, nameHeadings: opts.nameHeadings, ignoreHeadings: opts.ignoreHeadings });
	if ('error' in mapped) return mapped;
	const plan: PastePlan = { changes: [], unchanged: 0, notes: [...mapped.notes] };
	for (const v of mapped.values) {
		const row = rows.find((r) => r.id === v.rowId)!;
		const m = Number(v.key);
		const month = WATER_YEAR_MONTHS[m]!;
		const min = row.min ?? 0;
		if (v.value < min) return { error: `${row.name}, ${month}: ${withUnit(v.value, row.unit)} is below ${withUnit(min, row.unit)}.` };
		if (row.max !== undefined && v.value > row.max) return { error: `${row.name}, ${month}: ${withUnit(v.value, row.unit)} is above ${withUnit(row.max, row.unit)}.` };
		const from = row.values[m] ?? 0;
		if (sameValue(from, v.value)) plan.unchanged++;
		else plan.changes.push({ rowId: row.id, rowName: row.name, key: v.key, column: month, unit: row.unit, from, to: v.value });
	}
	return plan;
}

/** Write a plan's months through `set` (the row's id, the water-year month index, the value in the row's unit). */
export function applyMonthlyPaste(plan: PastePlan, set: (rowId: string, month: number, value: number) => void): void {
	for (const c of plan.changes) set(c.rowId, Number(c.key), c.to);
}

/** A column of the CSV before the months, the paste leaves out (ignoreHeadings). */
export interface InfoColumn {
	heading: string;
	value: (row: MonthlyRow) => string | number | null;
}

/**
 * The rows as a CSV to fill in and paste back: the name, the info columns,
 * then Oct … Sep, each heading with `monthUnit` in brackets when every row
 * shares one ("Oct (m³/s)").
 */
export function monthlyRowsCsv(rows: readonly MonthlyRow[], nameHeading: string, info: readonly InfoColumn[] = [], monthUnit = ''): string {
	return toCsv([
		[nameHeading, ...info.map((i) => i.heading), ...WATER_YEAR_MONTHS.map((m) => (monthUnit ? `${m} (${monthUnit})` : m))],
		...rows.map((r) => [r.name, ...info.map((i) => i.value(r)), ...WATER_YEAR_MONTHS.map((_, k) => r.values[k] ?? 0)])
	]);
}
