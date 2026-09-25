// [Transfers] "Draw from dam" columns → transfer rules (extract_project.py
// read_transfers). One column per rule: the source farm heads it, and the
// rows above hold its destination, months, max rate and minimum storage.
import { type Cell, cellAddress, clean, columnLetter, isName, num, pyRepr } from './cells';
import { InvalidWorkbookError } from './errors';
import { monthList, substringExtraMonths } from './months';
import type { Report } from './report';
import type { B023Workbook } from './workbook';

export interface WorkbookTransfer {
	from: string;
	to: string;
	months: number[];
	maxRateM3s: number;
	minStoragePct: number;
	/** The column's letter (part of the rule's id) and 1-based index. */
	column: string;
	col: number;
}

type ConfigKey = 'cap' | 'min' | 'to' | 'months' | 'rate' | 'daily';

const LABELS: [ConfigKey, string][] = [
	['cap', 'dam capacity'],
	['min', 'min capacity'],
	['to', 'transfer to'],
	['months', 'transfer months'],
	['rate', 'max transfer'],
	['daily', 'transfer capacity max']
];

/** read_transfers(): the rules to import, in column order. */
export function readTransfers(wb: B023Workbook, report: Report): WorkbookTransfer[] {
	const { sheet, c1, r1: hr, c2 } = wb.ref('zTransfers_HeaderFarmsFrom');
	// The first column of the From block holds the row labels; a later matching row wins.
	const labels = new Map<ConfigKey, number>();
	for (let r = 1; r <= hr - 1; r++) {
		const lab = clean(wb.cell(sheet, c1, r)).toLowerCase();
		for (const [key, pat] of LABELS) if (lab.startsWith(pat)) labels.set(key, r);
	}
	const missing = (['to', 'months', 'rate', 'min'] as const).filter((k) => !labels.has(k)).sort();
	if (missing.length) throw new InvalidWorkbookError(`[Transfers] config rows not found: ${pyRepr(missing)}`, sheet);
	const at = (key: ConfigKey, c: number): Cell => (labels.has(key) ? wb.cell(sheet, c, labels.get(key)!) : null);

	const out: WorkbookTransfer[] = [];
	for (let c = c1 + 1; c <= c2; c++) {
		const head = wb.cell(sheet, c, hr);
		if (!isName(head)) continue;
		const from = clean(head);
		const to = clean(at('to', c));
		const rate = num(at('rate', c));
		const column = columnLetter(c);
		if (!isName(to) || rate <= 0) {
			// Skipped, as in the Python, which says nothing: list it so the user knows the column wasn't imported.
			if (!isName(to) && rate > 0) {
				report.unmap({
					code: 'transfer-no-destination',
					message: `[Transfers] column ${column} draws up to ${num(at('rate', c))} m³/s from ${from}'s dam but names no farm to transfer to; not imported`,
					sheet,
					cell: cellAddress(c, labels.get('to')!),
					element: from
				});
			} else if (isName(to)) {
				report.unmap({
					code: 'transfer-zero-rate',
					message: `[Transfers] column ${column} (${from} -> ${to}) has no max transfer rate (${at('rate', c) === null ? 'blank' : pyRepr(at('rate', c))}); not imported`,
					sheet,
					cell: cellAddress(c, labels.get('rate')!),
					element: from
				});
			}
			continue;
		}
		const monthsRaw = at('months', c);
		const extra = substringExtraMonths(monthsRaw);
		if (extra.length) {
			const message =
				`transfer ${from} -> ${to}: the workbook's substring match also runs it in months ${pyRepr(extra)}, ` +
				`which ${pyRepr(monthsRaw)} doesn't list; the app uses the listed months only (audit M1)`;
			const where = { sheet, cell: cellAddress(c, labels.get('months')!), element: from };
			report.note('transfer-months-substring', message, where);
			report.unmap({ code: 'transfer-months-substring', message, ...where, text: clean(monthsRaw) });
		}
		out.push({
			from,
			to,
			months: monthList(monthsRaw),
			maxRateM3s: rate,
			minStoragePct: report.num(at('min', c), { sheet, col: c, row: labels.get('min')!, what: 'Min capacity (%)', element: from }),
			column,
			col: c
		});
	}
	return out;
}
