// Spread the summary CSV's blocks over the workbook's sheets. The CSV
// (backend/src/export/run-tables.ts summaryCsvLines) is one long sheet of
// blocks separated by a blank line, each starting with its title. A title
// listed here moves the blocks from there on to its sheet; any other block
// (a sub-table, or a block the backend adds later) stays on the sheet of the
// block before it. So every row of the CSV lands on exactly one sheet, in
// order, and a renamed or new block is never dropped, at worst shown next to
// its neighbour.
import type { Cell } from './csv';

export const SUMMARY_SHEETS = ['Summary', 'Curtailment', 'Reserve compliance', 'Annual volumes', 'Data checks', 'Warnings'] as const;
export type SummarySheet = (typeof SUMMARY_SHEETS)[number];

/** Block titles (first cell) that start a sheet, as run-tables.ts writes them. */
const STARTS: [title: string | RegExp, sheet: SummarySheet][] = [
	['Self-checks', 'Summary'],
	['Farm summary', 'Summary'],
	['Catchment', 'Summary'],
	['Curtailment targets', 'Curtailment'],
	[/^Land-cover streamflow reductions/, 'Curtailment'],
	[/^Other water users/, 'Curtailment'],
	['EWR sites (reporting window)', 'Curtailment'],
	[/^Reserve compliance by month/, 'Reserve compliance'],
	[/^Water balance by water year/, 'Annual volumes'],
	// Assurance of supply (engine ≥ 0.32.0, backend export/supply-assurance.ts).
	[/^Assurance of supply/, 'Curtailment'],
	[/^Stress classes by month/, 'Curtailment'],
	[/^Water account by water year/, 'Annual volumes'],
	['CHIRPS bias correction', 'Data checks'],
	['Catchment rain treated as missing', 'Data checks'],
	['Multi-day rain accumulations', 'Data checks'],
	[/^Double-mass check/, 'Data checks'],
	['Plausibility checks', 'Data checks'],
	[/^Calibration \(/, 'Summary'],
	// The Runs tab's FDC Q10–Q95 table (issue #45, backend export/fdc.ts).
	[/^Flow-duration percentiles/, 'Summary'],
	[/^WR2012 check/, 'Summary'],
	[/^Farm daily columns/, 'Summary'],
	['Warnings', 'Warnings']
];

function sheetFor(title: Cell): SummarySheet | null {
	if (typeof title !== 'string') return null;
	for (const [t, sheet] of STARTS) if (typeof t === 'string' ? t === title : t.test(title)) return sheet;
	return null;
}

/**
 * The CSV's rows per sheet, blocks still separated by an empty row. A sheet
 * with no rows is absent (the CSV has no Warnings block when there are none).
 */
export function splitSummary(rows: readonly Cell[][]): Map<SummarySheet, Cell[][]> {
	const out = new Map<SummarySheet, Cell[][]>();
	let current: SummarySheet = 'Summary';
	let i = 0;
	while (i < rows.length) {
		if (!rows[i]!.length) {
			i++;
			continue;
		}
		let j = i;
		while (j < rows.length && rows[j]!.length) j++;
		const block = rows.slice(i, j);
		current = sheetFor(block[0]![0] ?? null) ?? current;
		const sheet = out.get(current) ?? [];
		if (sheet.length) sheet.push([]);
		sheet.push(...block);
		out.set(current, sheet);
		i = j;
	}
	return out;
}
