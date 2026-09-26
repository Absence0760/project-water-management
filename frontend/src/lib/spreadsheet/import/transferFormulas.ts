// The hand-written [Transfers] formulas the app's transfer rules replace
// (docs/model.md §2.6, packages/engine/src/network/README.md quirks 3 and 4).
//
// b023 moves transfer water with formulas the hydrologist writes per
// workbook: one "Draw from dam" formula per rule (what leaves the source dam)
// and one "InOut" formula per farm (the net volume entering or leaving it).
// The app replaces them with structured rules in which each rule's water
// leaves its source and enters its destination, so anything written
// differently (a conveyance loss, a draw from the spill column, a farm with
// no InOut column) would not be reproduced. The Python importer assumes the
// standard shape without looking; this lists every formula that differs.
//
// The formulas are read from zTransfers_FormulasAsTxt, the row where b023
// keeps a plain-text copy of its formula row, so the import stays on cached
// values (no formula is parsed from the sheet XML, none is evaluated). The
// copy is refreshed by the workbook's own maintenance; a stale copy is the
// workbook's to fix, and the message says which row was read.
import { type Cell, cellAddress, clean, columnIndex, columnLetter, isName, pyStrip } from './cells';
import type { Report } from './report';
import type { WorkbookTransfer } from './transfers';
import type { B023Workbook } from './workbook';

const TERM = String.raw`\$?([A-Z]{1,3})\$?(\d+)`;
const SUM_RE = new RegExp(String.raw`^=\s*[+-]?\s*${TERM}(?:\s*[+-]\s*${TERM})*\s*$`);
const TERMS_RE = new RegExp(String.raw`([+-]?)\s*${TERM}`, 'g');
const ZERO_RE = /^=\s*0\s*$/;
const DRAW_RE = /fGetTrfVolCapped\(\s*(?:'((?:[^']|'')+)'|([^'!(),\s]+))!\$?([A-Z]{1,3})\$?(\d+)/;
/** Column-relative, row-absolute references (O$14): a draw formula's own settings rows. */
const SETTING_RE = /(?<![A-Za-z$!])\$?([A-Z]{1,3})\$(\d+)/g;

function text(v: Cell): string {
	return typeof v === 'string' ? pyStrip(v) : '';
}

/** List the transfer formulas that don't fit the rule shape (unmapped items only; the project is unchanged). */
export function checkTransferFormulas(wb: B023Workbook, transfers: WorkbookTransfer[], report: Report): void {
	if (!transfers.length) return;
	if (!wb.has('zTransfers_FormulasAsTxt') || !wb.has('zTransfers_HeaderFarmsInOut')) {
		report.unmap({
			code: 'transfer-formulas-unchecked',
			message:
				'[Transfers] has no plain-text copy of its formula row (zTransfers_FormulasAsTxt) or no InOut header, so the hand-written transfer formulas ' +
				"couldn't be checked; the app moves each transfer's water out of its source dam and into its destination",
			sheet: 'Transfers'
		});
		return;
	}
	const txt = wb.ref('zTransfers_FormulasAsTxt');
	const sheet = txt.sheet;
	const formulaRow = wb.has('zTransfers_FormulaRow') ? wb.ref('zTransfers_FormulaRow').r1 : txt.r1 - 1;
	const from = wb.ref('zTransfers_HeaderFarmsFrom');
	const drawCols = new Set<number>();
	for (let c = from.c1 + 1; c <= from.c2; c++) if (isName(wb.cell(sheet, c, from.r1))) drawCols.add(c);
	const active = new Map(transfers.map((t) => [t.col, t]));
	const where = (c: number) => ({ sheet, cell: cellAddress(c, txt.r1) });
	const copyNote = `(the text copy of the formula row, row ${txt.r1})`;

	// InOut: one column per farm, net = + draws into it − draws out of it.
	const inout = wb.ref('zTransfers_HeaderFarmsInOut');
	const seen = new Set<string>();
	for (let c = inout.c1 + 1; c <= inout.c2; c++) {
		const head = wb.cell(sheet, c, inout.r1);
		if (!isName(head)) continue;
		const farm = clean(head);
		if (seen.has(farm)) {
			report.unmap({
				code: 'transfer-inout-duplicate',
				message: `[Transfers] ${farm} heads a second InOut column (${columnLetter(c)}); the workbook's farm sheet reads the first one only, and so does the app's rule`,
				...where(c),
				element: farm
			});
			continue;
		}
		seen.add(farm);
		const expected = new Map<number, number>();
		for (const t of transfers) {
			if (t.to === farm) expected.set(t.col, (expected.get(t.col) ?? 0) + 1);
			if (t.from === farm) expected.set(t.col, (expected.get(t.col) ?? 0) - 1);
		}
		const f = text(wb.cell(sheet, c, txt.r1));
		const want = expectedFormula(expected, formulaRow);
		const problem = inOutProblem(f, expected, drawCols, active, formulaRow);
		if (problem) {
			report.unmap({
				code: 'transfer-inout-formula',
				message: `[Transfers] the InOut formula for ${farm} is ${f ? `"${f}"` : 'blank'} ${copyNote}: ${problem}. The app moves each transfer's water out of its source and into its destination${want ? ` (here "${want}")` : ' (none for this farm)'}, so results can differ from the workbook`,
				...where(c),
				element: farm,
				text: f
			});
		}
	}
	const farms = new Set(transfers.flatMap((t) => [t.from, t.to]));
	for (const farm of farms) {
		if (seen.has(farm)) continue;
		const cols = transfers.filter((t) => t.from === farm || t.to === farm).map((t) => t.column);
		report.unmap({
			code: 'transfer-inout-missing',
			message: `[Transfers] ${farm} sends or receives transfer column${cols.length === 1 ? '' : 's'} ${cols.join(', ')} but has no InOut column, so the workbook never moved that water in or out of it; the app does`,
			sheet,
			element: farm
		});
	}

	// Draw from dam: fGetTrfVolCapped(<source farm>!Q<yesterday>, own column's settings …).
	// A constant-0 draw is a switched-off transfer, imported disabled with its own warning.
	for (const t of transfers) {
		if (!t.enabled) continue;
		const f = text(wb.cell(sheet, t.col, txt.r1));
		const problems = drawProblems(f, t, formulaRow);
		if (problems.length) {
			report.unmap({
				code: 'transfer-draw-formula',
				message: `[Transfers] the draw formula of column ${t.column} (${t.from} -> ${t.to}) is ${f ? `"${f}"` : 'blank'} ${copyNote}: ${problems.join('; ')}. The app draws from ${t.from}'s dam storage the day before, with column ${t.column}'s own settings`,
				...where(t.col),
				element: t.from,
				text: f
			});
		}
	}
}

function expectedFormula(expected: Map<number, number>, row: number): string {
	let s = '';
	for (const [c, k] of [...expected].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
		for (let i = 0; i < Math.abs(k); i++) s += `${k > 0 ? (s ? '+' : '') : '-'}${columnLetter(c)}${row}`;
	}
	return s ? `=${s}` : '';
}

/** Why an InOut formula doesn't fit, or null when it does. */
function inOutProblem(f: string, expected: Map<number, number>, drawCols: Set<number>, active: Map<number, WorkbookTransfer>, row: number): string | null {
	const needs = [...expected.values()].some((k) => k !== 0);
	if (!f) return needs ? 'it moves no water' : null;
	if (ZERO_RE.test(f)) return needs ? 'it is 0, so it moves no water' : null;
	if (!SUM_RE.test(f)) return 'it is not a plain sum and difference of draw columns (a factor, function or constant changes the volume)';
	const actual = new Map<number, number>();
	for (const m of f.matchAll(TERMS_RE)) {
		const c = columnIndex(m[2]!);
		if (Number(m[3]) !== row) return `it refers to row ${m[3]}, not the same day's draws (row ${row})`;
		if (!drawCols.has(c)) return `${m[2]}${m[3]} is not a draw-from-dam column`;
		// Columns that aren't imported (no destination, or no rate) draw nothing either way.
		if (active.has(c)) actual.set(c, (actual.get(c) ?? 0) + (m[1] === '-' ? -1 : 1));
	}
	for (const c of new Set([...expected.keys(), ...actual.keys()])) {
		const want = expected.get(c) ?? 0;
		const got = actual.get(c) ?? 0;
		if (want === got) continue;
		const t = active.get(c)!;
		if (want > 0 && got <= 0) return `it doesn't add column ${columnLetter(c)} (${t.from} -> ${t.to})`;
		if (want < 0 && got >= 0) return `it doesn't subtract column ${columnLetter(c)} (${t.from} -> ${t.to})`;
		return `it counts column ${columnLetter(c)} (${t.from} -> ${t.to}) ${Math.abs(got)} times with sign ${got < 0 ? '-' : '+'}, the rule once`;
	}
	return null;
}

/** Why a draw formula doesn't fit (empty when it does). */
function drawProblems(f: string, t: WorkbookTransfer, row: number): string[] {
	const m = f ? DRAW_RE.exec(f) : null;
	if (!m) return ["it isn't the standard fGetTrfVolCapped draw from a farm's dam"];
	const problems: string[] = [];
	const src = clean(m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]!);
	if (src !== t.from) problems.push(`it draws from ${src}'s sheet, not ${t.from}'s`);
	if (m[3] !== 'Q') problems.push(`it reads column ${m[3]}${m[3] === 'R' ? ' (spill)' : ''} of the farm sheet, not Q (dam storage)`);
	if (Number(m[4]) !== row - 1) problems.push(`it reads row ${m[4]} of the farm sheet, not the day before (row ${row - 1})`);
	const own = t.column;
	const rest = f.slice(0, m.index) + f.slice(m.index + m[0].length);
	const others = new Set<string>();
	for (const s of rest.matchAll(SETTING_RE)) if (s[1] !== own) others.add(`${s[1]}$${s[2]}`);
	if (others.size) problems.push(`it uses settings from other columns (${[...others].join(', ')})`);
	return problems;
}
