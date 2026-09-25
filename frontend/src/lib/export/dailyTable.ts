// Parse a daily CSV export (docs/api.md § Export: a `date` column, then one
// number column per series or per farm) back into a table, for the in-page
// preview of a download (components/export/DailyTableDialog.svelte). The
// preview shows the very file the download saves, so it parses the export
// rather than rebuilding it from the run's series.

export interface DailyTable {
	/** The leading `# …` line a legacy-runoff run's exports carry (audit H1), without the `#`; null otherwise. */
	comment: string | null;
	/** Column headers after `date`. */
	headers: string[];
	/** One ISO date per row. */
	dates: string[];
	/** columns[c][r]: the value of header c on dates[r]; null for an empty cell. */
	columns: (number | null)[][];
}

/** One CSV record's cells (RFC 4180: quoted cells may hold commas and doubled quotes). */
export function csvCells(line: string): string[] {
	const out: string[] = [];
	let i = 0;
	for (;;) {
		let cell = '';
		if (line[i] === '"') {
			i++;
			for (;;) {
				const q = line.indexOf('"', i);
				if (q < 0) throw new Error('unterminated quoted cell');
				cell += line.slice(i, q);
				if (line[q + 1] === '"') {
					cell += '"';
					i = q + 2;
				} else {
					i = q + 1;
					break;
				}
			}
		} else {
			const c = line.indexOf(',', i);
			cell = line.slice(i, c < 0 ? line.length : c);
			i = c < 0 ? line.length : c;
		}
		out.push(cell);
		if (line[i] !== ',') return out;
		i++;
	}
}

/** Undo the export's CSV-injection guard (csv.ts textCell): a leading apostrophe before = + - @. */
const unguard = (s: string) => (/^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s);

export function parseDailyCsv(text: string): DailyTable {
	const lines = text.replace(/^﻿/, '').split(/\r?\n/);
	while (lines.length && lines[lines.length - 1] === '') lines.pop();
	let comment: string | null = null;
	if (lines[0]?.startsWith('#')) comment = lines.shift()!.replace(/^#\s*/, '');
	const head = lines.shift();
	if (head === undefined) throw new Error('the file is empty');
	const [first, ...headers] = csvCells(head).map(unguard);
	if (first !== 'date') throw new Error('not a daily table: the first column is not `date`');
	const dates: string[] = [];
	const columns: (number | null)[][] = headers.map(() => []);
	for (const line of lines) {
		const cells = line.split(','); // data rows are a date and plain numbers
		dates.push(cells[0]!);
		for (let c = 0; c < headers.length; c++) {
			const v = cells[c + 1];
			columns[c]!.push(v === undefined || v === '' ? null : Number(v));
		}
	}
	return { comment, headers, dates, columns };
}
