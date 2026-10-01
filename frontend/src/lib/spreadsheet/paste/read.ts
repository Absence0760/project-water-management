// Reading a block of cells pasted from a spreadsheet, a CSV file or a PDF:
// the separator, the cells and the numbers in them. Shared by the Reserve
// rule tables' paste (components/settings/ewrRules.ts parseGrid) and the
// node table's and planted-areas grid's paste (./grid.ts, issue #285).

export type PasteSeparator = 'tab' | 'semicolon' | 'comma' | 'space' | 'none';

export interface PastedBlock {
	/** One array of cells per non-blank line, each cell trimmed. */
	cells: string[][];
	separator: PasteSeparator;
	/**
	 * A comma between digits is a decimal comma (1,207 = 1.207), the way a South
	 * African locale shows numbers: true in a tab-, semicolon- or space-separated
	 * paste, false in a CSV, where the comma separates the cells.
	 */
	decimalComma: boolean;
}

export interface ReadOptions {
	/**
	 * Fall back to splitting on runs of spaces (a table copied from a PDF), and
	 * read a comma as a separator only when the lines look like a CSV of numbers.
	 * Lines are trimmed whole, so a leading tab is dropped. Without it (a grid
	 * with names in it) a comma anywhere means a CSV, a block with no separator
	 * is one cell a line, and a leading tab keeps its blank cell, so a value
	 * stays in its column.
	 */
	spaces?: boolean;
}

/** Cells of one CSV row: commas separate, double quotes group a cell ("Smith, J"), "" is a quote inside one. */
export function splitCsvRow(line: string): string[] {
	const cells: string[] = [];
	let cur = '';
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!;
		if (ch === '"') {
			if (quoted && line[i + 1] === '"') {
				cur += '"';
				i++;
			} else quoted = !quoted;
		} else if (ch === ',' && !quoted) {
			cells.push(cur);
			cur = '';
		} else cur += ch;
	}
	cells.push(cur);
	return cells;
}

/** Split pasted text into cells, picking the separator: tabs, else semicolons, else commas, else spaces (with `spaces`). */
export function readPastedBlock(text: string, opts: ReadOptions = {}): PastedBlock {
	const lines = text
		.replace(/^\ufeff/, '')
		.replace(/\r/g, '')
		.split('\n')
		.map((l) => (opts.spaces ? l.trim() : l.replace(/^ +| +$/g, '')))
		.filter((l) => l.trim().length);
	const separator: PasteSeparator = lines.some((l) => l.includes('\t'))
		? 'tab'
		: lines.some((l) => l.includes(';'))
			? 'semicolon'
			: (opts.spaces ? lines.some((l) => /\d,\d/.test(l) && l.split(',').length > 2) : lines.some((l) => l.includes(',')))
				? 'comma'
				: opts.spaces
					? 'space'
					: 'none';
	const split = (l: string): string[] =>
		separator === 'tab' ? l.split('\t') : separator === 'semicolon' ? l.split(';') : separator === 'comma' ? splitCsvRow(l) : separator === 'space' ? l.split(/\s+/) : [l];
	return { cells: lines.map((l) => split(l).map((c) => c.trim())), separator, decimalComma: separator !== 'comma' };
}

/**
 * Reads the numbers in a pasted block: spaces (plain, no-break, thin) are
 * dropped (300 000 = 300000). With `comma` 'decimal' (or true) one comma
 * between digits is a decimal point; with 'grouping' commas between groups of
 * three digits are thousands separators (1,500,000.5); with false a comma
 * makes the cell not a number. A blank cell or anything else is NaN.
 * `sawComma` says whether a comma was read, for the note.
 */
export function numberReader(comma: boolean | CommaReading) {
	const mode = comma === true ? 'decimal' : comma;
	const r = {
		sawComma: false,
		read(cell: string): number {
			let v = squash(cell);
			if (mode === 'decimal' && /^-?\d+,\d+$/.test(v)) {
				v = v.replace(',', '.');
				r.sawComma = true;
			} else if (mode === 'grouping' && GROUPED.test(v)) {
				v = v.replace(/,/g, '');
				r.sawComma = true;
			}
			return v === '' ? NaN : Number(v);
		}
	};
	return r;
}

const squash = (cell: string) => cell.trim().replace(/[\s\u00a0\u2009\u202f]/g, '');
/** 1,500 / 1,500,000 / 1,234.5: thousands separators, as an English-locale spreadsheet copies them. */
const GROUPED = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;

/** How the commas between digits in a block of numbers read. */
export type CommaReading = 'decimal' | 'grouping';

/**
 * Decide once for a whole block what a comma between digits is, from the
 * cells that can only be one or the other: 12,5 or 0,75 is a decimal comma;
 * 1,500,000 or 1,234.5 has thousands separators. A block with only
 * three-digit groups (300,000) is ambiguous: 300 000 or 300? That stops the
 * paste with the cell, rather than guess (a spreadsheet copies numbers as it
 * shows them, and both locales are common here). Cells with a % sign are read
 * without it.
 */
export function blockCommas(cells: readonly string[]): CommaReading | { ambiguous: string } | { mixed: [string, string] } {
	let decimal: string | null = null;
	let grouping: string | null = null;
	let maybe: string | null = null;
	for (const c of cells) {
		const v = squash(c).replace(/%$/, '');
		if (!v.includes(',')) continue;
		if (/^-?\d+,\d+$/.test(v) && !(GROUPED.test(v) && !/^-?0,/.test(v))) decimal ??= c.trim();
		else if (GROUPED.test(v) && (/\./.test(v) || (v.match(/,/g)?.length ?? 0) > 1)) grouping ??= c.trim();
		else if (GROUPED.test(v)) maybe ??= c.trim();
	}
	if (decimal && grouping) return { mixed: [decimal, grouping] };
	if (grouping) return 'grouping';
	if (decimal) return 'decimal';
	return maybe ? { ambiguous: maybe } : 'decimal';
}

/** The note a paste shows when it read decimal commas. */
export const DECIMAL_COMMA_NOTE = 'Decimal commas were read as decimal points (1,207 = 1.207).';
/** The note a paste shows when it read thousands separators. */
export const GROUPING_COMMA_NOTE = 'Commas were read as thousands separators (1,500,000 = 1500000).';
