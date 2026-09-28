// Read the backend's summary CSV (…/export/summary.csv) back into cells, so
// the workbook's summary sheets are the CSV export itself, value for value.
// The CSV is RFC 4180 as backend/src/export/csv.ts writes it: a UTF-8 BOM,
// CRLF, fields with `,` `"` or a line break quoted, `"` doubled, numbers as
// `String(n)` (full precision), empty for missing, and text that a spreadsheet
// would run as a formula already prefixed with `'`.

/** One cell: text, a number, or empty. */
export type Cell = string | number | null;

/**
 * An unquoted field that is exactly how JavaScript prints a finite number is
 * a number (the backend writes numbers with `String(n)`, so this round-trips
 * every one exactly); anything else is text. `007`, `1e3` or `2001/02` stay
 * text because `String(Number(s))` differs from them.
 */
function typed(field: string): Cell {
	if (field === '') return null;
	const n = Number(field);
	return Number.isFinite(n) && String(n) === field ? n : field;
}

/**
 * Parse CSV text into rows of cells. A blank line is an empty row (the
 * summary separates its blocks with one). A quoted field is always text.
 */
export function parseCsv(text: string): Cell[][] {
	const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const rows: Cell[][] = [];
	let row: Cell[] = [];
	let i = 0;
	const endRow = () => {
		// A line with one empty unquoted field is a blank line: an empty row.
		rows.push(row.length === 1 && row[0] === null ? [] : row);
		row = [];
	};
	while (i < s.length) {
		let cell: Cell;
		if (s[i] === '"') {
			let v = '';
			i++;
			for (;;) {
				const q = s.indexOf('"', i);
				if (q < 0) throw new Error('CSV: unterminated quoted field');
				v += s.slice(i, q);
				if (s[q + 1] === '"') {
					v += '"';
					i = q + 2;
				} else {
					i = q + 1;
					break;
				}
			}
			cell = v;
		} else {
			let j = i;
			while (j < s.length && s[j] !== ',' && s[j] !== '\r' && s[j] !== '\n') j++;
			cell = typed(s.slice(i, j));
			i = j;
		}
		row.push(cell);
		if (s[i] === ',') {
			i++;
			if (i < s.length && s[i] !== '\r' && s[i] !== '\n') continue;
			// A trailing comma ends the line with one more empty field.
			row.push(null);
		}
		if (s[i] === '\r') i++;
		if (s[i] === '\n') i++;
		endRow();
	}
	return rows;
}
