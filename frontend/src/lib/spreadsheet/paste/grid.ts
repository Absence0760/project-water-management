// A block pasted from a spreadsheet into a model grid (the node table, the
// planted-areas grid; issue #285): which row and column each pasted value
// belongs to. The cells and numbers are read by ./read.ts, the same reader as
// the Reserve rule tables' paste. What a value means (a %, hectares) and
// whether it applies is the grid's business: components/network/nodePaste.ts
// and components/crops/areaPaste.ts.
import { defuse } from '$lib/spreadsheet/export/names';
import { blockCommas, DECIMAL_COMMA_NOTE, GROUPING_COMMA_NOTE, numberReader, readPastedBlock } from './read';

/** A row of the grid, matched by its name. */
export interface GridRow {
	id: string;
	name: string;
}

/** A value column of the grid, matched by any of its labels (a heading's unit in brackets is ignored). */
export interface GridColumn {
	key: string;
	/** The first is the column's name in messages. */
	labels: string[];
}

/** One pasted value, in the grid's display unit (a % as 0–100). */
export interface PastedValue {
	rowId: string;
	key: string;
	value: number;
}

export interface MappedPaste {
	values: PastedValue[];
	/** How the paste was read: rows matched by name, columns left out, decimal commas. */
	notes: string[];
}

/** Where a paste into the grid landed: the row and the value column of the focused cell. */
export interface PasteAnchor {
	row: number;
	col: number;
}

export interface MapOptions {
	/** The focused cell, for a block without names or headings: it starts there, as in a spreadsheet. */
	anchor?: PasteAnchor | null;
	/** Headings of the name column ("Name", "Farm"), so a heading row is recognised by its first cell too. */
	nameHeadings?: string[];
	/** Headings of columns the grid's own CSV has but a paste can't change (a Total, a Kind): left out without a note. */
	ignoreHeadings?: string[];
}

/**
 * A name or label as matched: lower-case, one space, a CSV export's formula
 * guard (a leading apostrophe) dropped, non-breaking hyphens made plain.
 * Brackets stay, so "Farm A (east)" and "Farm A (west)" are two names.
 */
export function normalName(s: string): string {
	return s
		.replace(/^'(?=[=+\-@])/, '')
		.replace(/[\u2010\u2011]/g, '-')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

/**
 * The keys a heading can match a column by: as written, then without a last
 * bracket (its unit), so "Dam capacity (m³)" finds Dam capacity and "Maize
 * (white) (ha)" finds the crop Maize (white).
 */
export function headingKeys(h: string): string[] {
	const k = normalName(h);
	const bare = k.replace(/\s*\([^()]*\)$/, '');
	return bare && bare !== k ? [k, bare] : [k];
}

/** A blank cell, or a dash for "not used", leaves the grid's value as it is. */
const isBlank = (c: string) => /^[\s–—-]*$/.test(c);

/**
 * Map pasted text onto a grid's rows and columns.
 *
 * - **Headings:** a first row where some cell names a column is a heading row;
 *   each value column then goes where its heading says, and a heading the grid
 *   doesn't have (a Total, say) is left out. Without one, the columns are the
 *   grid's own, in order, from the anchor's column (or the first).
 * - **Names:** when every row starts with a name (not a number), each row goes
 *   to the grid row of that name, ignoring case; a name the grid doesn't have
 *   is left out. Without names, the rows are the grid's own, in order, from
 *   the anchor's row (or the first).
 * - **Values:** a blank or a dash leaves the value as it is; a trailing % is
 *   allowed; anything else that isn't a number stops the paste with the row
 *   and column it is in.
 */
export function mapPaste(text: string, rows: readonly GridRow[], cols: readonly GridColumn[], opts: MapOptions = {}): MappedPaste | { error: string } {
	const block = readPastedBlock(text);
	if (!block.cells.length) return { error: 'Paste the block of cells first.' };
	// A comma between digits: decided once for the block (read.ts blockCommas), so 300,000 is never quietly 300.
	const commas = blockCommas(block.cells.flat());
	if (typeof commas !== 'string' && 'mixed' in commas)
		return { error: `The paste has both a decimal comma (${commas.mixed[0]}) and thousands separators (${commas.mixed[1]}): use one or the other.` };
	if (typeof commas !== 'string')
		return { error: `Is “${commas.ambiguous}” ${commas.ambiguous.replace(/,/g, ' ')} or ${Number(commas.ambiguous.replace(/[^\d,-]/g, '').replace(',', '.'))}? Remove the separator (${commas.ambiguous.replace(/,/g, '')}) or write the decimal with a point.` };
	const reader = numberReader(commas);
	const notes: string[] = [];

	// --- a heading row ---
	const colOf = new Map<string, GridColumn>();
	for (const c of cols) for (const l of c.labels) if (!colOf.has(normalName(l))) colOf.set(normalName(l), c);
	// A label two columns share (two crops of one name) can't place a value.
	const shared = new Set<string>();
	for (const c of cols) {
		const own = new Set(c.labels.map(normalName));
		for (const l of own) if (cols.some((o) => o !== c && o.labels.some((x) => normalName(x) === l))) shared.add(l);
	}
	const nameHeads = new Set((opts.nameHeadings ?? ['name']).map(normalName));
	const ignored = new Set((opts.ignoreHeadings ?? []).map(normalName));
	// The heading's column (null: none, or a name two columns share) and the key it matched by.
	const headingCol = (h: string): { col: GridColumn | null; key: string } => {
		const keys = headingKeys(h);
		const key = keys.find((k) => colOf.has(k)) ?? keys[0]!;
		return { col: shared.has(key) ? null : (colOf.get(key) ?? null), key };
	};
	const first = block.cells[0]!;
	const headed = first.some((c, i) => headingCol(c).col !== null || (i === 0 && headingKeys(c).some((k) => nameHeads.has(k))));
	const data = headed ? block.cells.slice(1) : block.cells;
	if (!data.length) return { error: 'There are no rows under the heading row.' };

	// --- names in the first column ---
	const named = data.every((r) => !isBlank(r[0] ?? '') && Number.isNaN(reader.read(r[0]!.replace(/%$/, ''))));
	const rowByName = new Map<string, GridRow[]>();
	for (const r of rows) {
		const k = normalName(r.name);
		if (k) rowByName.set(k, [...(rowByName.get(k) ?? []), r]);
	}
	const anchor = opts.anchor ?? { row: 0, col: 0 };
	const startCol = named ? 1 : 0;

	// Value column j (j ≥ startCol) → a grid column, or null (left out).
	let colAt: (j: number) => GridColumn | null;
	if (headed) {
		const left: string[] = [];
		const map = first.map((h, j) => {
			if (j < startCol) return null;
			const { col: c, key: k } = headingCol(h);
			if (!c && h.trim() && !(j === 0 && headingKeys(h).some((x) => nameHeads.has(x))) && !headingKeys(h).some((x) => ignored.has(x))) left.push(shared.has(k) ? `${h.trim()} (two columns have that name)` : h.trim());
			return c;
		});
		const seen = new Set<string>();
		for (const c of map) {
			if (!c) continue;
			if (seen.has(c.key)) return { error: `The heading row names ${c.labels[0]} twice.` };
			seen.add(c.key);
		}
		if (left.length) notes.push(`Left out ${left.length === 1 ? 'a column' : 'columns'} the table doesn't have: ${left.join(', ')}.`);
		colAt = (j) => map[j] ?? null;
	} else {
		const width = Math.max(...data.map((r) => r.length)) - startCol;
		const start = anchor.col;
		if (start + width > cols.length) {
			return {
				error: `The paste has ${width} value${width === 1 ? '' : 's'} a row, but the table has ${cols.length - start} column${cols.length - start === 1 ? '' : 's'} from ${cols[start]?.labels[0] ?? 'there'} on. Paste the heading row too, or paste into an earlier column.`
			};
		}
		colAt = (j) => (j >= startCol ? (cols[start + j - startCol] ?? null) : null);
	}

	// --- each row ---
	const values: PastedValue[] = [];
	const missing: string[] = [];
	const ambiguous: string[] = [];
	const used = new Set<string>();
	if (!named && anchor.row + data.length > rows.length) {
		const room = rows.length - anchor.row;
		return {
			error: `The paste has ${data.length} rows, but the table has ${room} row${room === 1 ? '' : 's'}${anchor.row ? ` from ${rows[anchor.row]?.name || 'there'} down` : ''}. Put the names in the first column to paste rows in any order.`
		};
	}
	for (const [i, cells] of data.entries()) {
		let row: GridRow;
		if (named) {
			const name = cells[0]!.trim();
			const hits = rowByName.get(normalName(name)) ?? [];
			if (hits.length === 0) {
				missing.push(name);
				continue;
			}
			if (hits.length > 1) {
				ambiguous.push(name);
				continue;
			}
			row = hits[0]!;
			if (used.has(row.id)) return { error: `${name} appears twice in the paste.` };
			used.add(row.id);
		} else row = rows[anchor.row + i]!;
		for (let j = startCol; j < cells.length; j++) {
			const col = colAt(j);
			const cell = cells[j]!;
			if (!col || isBlank(cell)) continue;
			const value = reader.read(cell.replace(/%$/, ''));
			if (!Number.isFinite(value)) return { error: `${row.name || `Row ${i + 1}`}, ${col.labels[0]}: “${cell}” isn't a number.` };
			values.push({ rowId: row.id, key: col.key, value });
		}
	}
	if (named && used.size === 0) return { error: `None of the names in the first column is a row of the table (${[...missing, ...ambiguous].slice(0, 3).join(', ')}${missing.length + ambiguous.length > 3 ? ' …' : ''}).` };
	if (named) notes.push(`Matched ${used.size} row${used.size === 1 ? '' : 's'} by name.`);
	if (missing.length) notes.push(`Left out ${missing.length === 1 ? 'a row' : 'rows'} the table doesn't have: ${missing.join(', ')}.`);
	if (ambiguous.length) notes.push(`Left out ${ambiguous.join(', ')}: two rows of the table have that name.`);
	if (reader.sawComma) notes.push(commas === 'grouping' ? GROUPING_COMMA_NOTE : DECIMAL_COMMA_NOTE);
	return { values, notes };
}

/**
 * A CSV cell. Text is quoted when it holds a comma, quote or line break, and
 * text a spreadsheet would read as a formula gets a leading apostrophe (docs/security.md
 * "CSV exports defuse spreadsheet formulas"; normalName drops it again). A number is
 * written plainly, without float noise (0.7 × 100 = 70); null is a blank.
 */
export function csvCell(v: string | number | null | undefined): string {
	if (typeof v === 'number') return Number.isFinite(v) ? String(Number(v.toPrecision(12))) : '';
	if (v === null || v === undefined) return '';
	const s = defuse(v);
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows of cells as CSV text, one line each. */
export const toCsv = (rows: readonly (readonly (string | number | null | undefined)[])[]): string => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

/** One cell a paste would change, in the grid's display unit. */
export interface PasteChange {
	rowId: string;
	rowName: string;
	key: string;
	column: string;
	unit: string;
	/** The value now (null: empty). */
	from: number | null;
	to: number;
}

/** What applying a paste would do, for the preview. */
export interface PastePlan {
	changes: PasteChange[];
	/** Pasted values equal to what the grid already holds. */
	unchanged: number;
	notes: string[];
}

/** Two display values are the same to the grid's precision (float noise from a % or ha conversion aside). */
export const sameValue = (a: number | null, b: number) => a !== null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** More than one cell (a tab, or a line break before the end): the grid takes it; one value is left to the input it was pasted into. */
export const isBlockPaste = (text: string) => /[\t\r\n]/.test(text.replace(/[\r\n]+$/, ''));

/**
 * A paste event on a grid's body: the block and the cell it landed in, or null
 * for a single value (the input takes it as usual). Cells carry the value
 * column's index as `data-paste-col` (a cell without one anchors at the first
 * column) and their row its index as `data-idx`.
 * Stops the browser putting the block into the input.
 */
export function gridPasteTarget(e: ClipboardEvent): { text: string; anchor: PasteAnchor | null } | null {
	const text = e.clipboardData?.getData('text/plain') ?? '';
	if (!isBlockPaste(text)) return null;
	e.preventDefault();
	const target = e.target instanceof Element ? e.target : null;
	const cell = target?.closest<HTMLElement>('[data-paste-col]');
	const row = target?.closest<HTMLElement>('tr[data-idx]');
	// A cell with no value column (a select, a "not used" cell) still anchors its row, from the first column.
	return { text, anchor: row ? { row: Number(row.dataset.idx), col: cell ? Number(cell.dataset.pasteCol) : 0 } : null };
}
