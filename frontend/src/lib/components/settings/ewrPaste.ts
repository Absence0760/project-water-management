// The EWR settings' pastes through the shared paste dialog (issue #521,
// model/GridPasteDialog.svelte): the daily EWR's 12 TAB flows and its two
// percentile tables (EwrDailySourceFields.svelte), and a Reserve rule table's
// EWR, low-flow and natural grids (EwrRuleTablesEditor.svelte). The block is
// read by the same parsers the inline paste boxes used (./ewrRules.ts
// parseGrid and applyPaste, ./ewrDailySource.ts parseMonthlyRow), so a paste
// gives the same values; this file turns the result into the dialog's preview
// (every value it changes, Now and Pasted) and the grid into a CSV to fill in.
import { EWR_PERCENTILE_POINTS, type EwrDailySource, type EwrRuleTable } from '@water-management/engine';
import { WATER_YEAR_MONTHS } from '$lib/format/months';
import { sameValue, toCsv, type PastePlan } from '$lib/spreadsheet/paste/grid';
import { parseMonthlyRow } from './ewrDailySource';
import { applyPaste, parseGrid, type GridKey, type ParsedGrid } from './ewrRules';

type Grid = readonly (readonly (number | null)[])[] | null | undefined;

/** The changes from `before` to `after`, month rows by value columns; `all` counts every cell (the columns changed meaning). */
function diff(before: Grid, after: readonly (readonly number[])[], columns: readonly string[], unit: string, all = false): PastePlan {
	const plan: PastePlan = { changes: [], unchanged: 0, notes: [] };
	after.forEach((row, r) =>
		row.forEach((to, c) => {
			const from = before?.[r]?.[c];
			const now = typeof from === 'number' && Number.isFinite(from) ? from : null;
			if (!all && sameValue(now, to)) plan.unchanged++;
			else plan.changes.push({ rowId: String(r), rowName: WATER_YEAR_MONTHS[r]!, key: String(c), column: columns[c]!, unit, from: now, to });
		})
	);
	return plan;
}

const rowsNote = (g: ParsedGrid) => (g.monthLabels ? 'Rows matched by month name.' : 'Rows read as Oct … Sep.');
const pointLabel = (p: number) => `${p} %`;

/** What a paste into a rule table's grid does: the preview, the table it leaves, and the line said after it. */
export function planRuleTablePaste(t: EwrRuleTable, which: GridKey, text: string, unit: string): { plan: PastePlan; table: EwrRuleTable; message: string } | { error: string } {
	const g = parseGrid(text);
	if ('error' in g) return g;
	const out = applyPaste(t, which, g);
	if ('error' in out) return out;
	const pointsChanged = out.points.join() !== t.points.join();
	const plan = diff(t[which], out[which]!, out.points.map(pointLabel), unit, pointsChanged);
	plan.notes.push(rowsNote(g), ...g.notes);
	if (pointsChanged) plan.notes.push(`The heading row's % points (${out.points.join(', ')}) replace the table's (${t.points.join(', ')}).`);
	const what = which === 'ewr' ? 'EWR' : which === 'lowFlow' ? 'low-flow' : 'natural flow';
	const message = [`Filled the ${what} values: 12 months × ${out.points.length} % points${g.monthLabels ? ' (rows matched by month name)' : ' (rows read as Oct … Sep)'}.`, ...g.notes].join(' ');
	return { plan, table: out, message };
}

/** A rule table's grid as a CSV to fill in and paste back: a heading row of % points, then a row per month. */
export function ruleTableCsv(t: EwrRuleTable, which: GridKey): string {
	const grid = t[which];
	return toCsv([['Month', ...t.points.map(pointLabel)], ...WATER_YEAR_MONTHS.map((m, r) => [m, ...t.points.map((_, c) => grid?.[r]?.[c] ?? null)])]);
}

const PCT_LABELS = EWR_PERCENTILE_POINTS.map((p) => pointLabel(Math.round(p * 100)));
export type DailyTable = 'tabM3s' | 'naturalPctM3s' | 'reservePctM3s';

/** What a paste into the daily EWR's TAB flows or a percentile table does: the preview, the patch and the line said after it. */
export function planDailyPaste(src: EwrDailySource, which: DailyTable, text: string): { plan: PastePlan; patch: Partial<EwrDailySource>; message: string } | { error: string } {
	if (which === 'tabM3s') {
		const row = parseMonthlyRow(text);
		if ('error' in row) return row;
		const plan = diff([src.tabM3s ?? []], [row.values], WATER_YEAR_MONTHS, 'm³/s');
		// One row: name the months as columns of the one TAB row.
		for (const c of plan.changes) c.rowName = 'TAB flow';
		return { plan, patch: { tabM3s: row.values }, message: 'Filled the 12 TAB flows.' };
	}
	const g = parseGrid(text);
	if ('error' in g) return g;
	if (g.rows[0]!.length !== EWR_PERCENTILE_POINTS.length) return { error: `The paste has ${g.rows[0]!.length} values a row; the table has ${EWR_PERCENTILE_POINTS.length}, one per point (10 % … 99 %).` };
	const plan = diff(src[which], g.rows, PCT_LABELS, 'm³/s');
	plan.notes.push(rowsNote(g), ...g.notes);
	const message = [`Filled the ${which === 'naturalPctM3s' ? 'natural flow' : 'total Reserve flow'} table${g.monthLabels ? ' (rows matched by month name)' : ' (rows read as Oct … Sep)'}.`, ...g.notes].join(' ');
	return { plan, patch: { [which]: g.rows.map((r) => [...r]) }, message };
}

/** The daily EWR's table as a CSV to fill in: the TAB flows as a row under the months, a percentile table as month rows under its points. */
export function dailyCsv(src: EwrDailySource, which: DailyTable): string {
	if (which === 'tabM3s') return toCsv([[...WATER_YEAR_MONTHS], WATER_YEAR_MONTHS.map((_, i) => src.tabM3s?.[i] ?? null)]);
	const grid = src[which];
	return toCsv([['Month', ...PCT_LABELS], ...WATER_YEAR_MONTHS.map((m, r) => [m, ...PCT_LABELS.map((_, c) => grid?.[r]?.[c] ?? null)])]);
}
