// Settings → Reserve rule tables (engine ≥ 0.21.0, docs/model.md §2.9c):
// pure helpers for EwrRulesSection.svelte. The paste parser reads a table
// copied from a spreadsheet or a PDF (the gazette's 12 months × % points).
import {
	blankEwrRuleTable,
	DEFAULT_ASSURANCE_POINTS,
	EWR_HIGH_FLOWS_MAX,
	ewrRuleListIssues,
	ewrRuleTableIssues,
	ewrRuleTableNotes,
	type EwrHighFlowEvent,
	type EwrRuleTable,
	type NetworkNode
} from '@water-management/engine';

/** An EWR site a table can be at: the outlet (id null) or a gauge. */
export interface SiteOption {
	id: string | null;
	label: string;
}

/**
 * The outlet first, then every other gauge in network order. A stored table
 * whose gauge is gone keeps an option so the form can say so and change it.
 */
export function siteOptions(nodes: readonly Pick<NetworkNode, 'id' | 'name' | 'kind' | 'downstreamNodeId' | 'sortOrder'>[], stored: readonly (string | null)[] = []): SiteOption[] {
	const outlet = nodes.find((n) => n.downstreamNodeId === null);
	const out: SiteOption[] = [{ id: null, label: outlet ? `Outlet (${outlet.name})` : 'Outlet' }];
	const gauges = nodes.filter((n) => n.kind === 'gauge' && n !== outlet).sort((a, b) => a.sortOrder - b.sortOrder);
	for (const g of gauges) out.push({ id: g.id, label: `Gauge: ${g.name}` });
	for (const id of stored) if (id !== null && !out.some((o) => o.id === id)) out.push({ id, label: 'A node no longer in the network' });
	return out;
}

/** A new table at the first site that has none (null when every site has one). */
export function newTable(options: readonly SiteOption[], tables: readonly Pick<EwrRuleTable, 'siteNodeId'>[]): EwrRuleTable | null {
	const free = options.find((o) => !tables.some((t) => t.siteNodeId === o.id));
	return free ? blankEwrRuleTable(free.id) : null;
}

/** Field → message for one table, from the engine's own checks (blank inputs are NaN or null there). */
export function tableErrors(t: EwrRuleTable): Record<string, string> {
	const out: Record<string, string> = {};
	for (const i of ewrRuleTableIssues(t)) out[i.field] ??= i.message;
	return out;
}

/**
 * The REC (ER9) as typed: spaces dropped and upper-cased ("b / c" → "B/C"),
 * empty → null (not given). ewrRuleTableIssues then checks its form.
 */
export function categoryFromText(text: string): string | null {
	const v = text.replace(/\s+/g, '').toUpperCase();
	return v || null;
}

/** Everything that blocks Save for the list, or null. */
export function rulesError(tables: readonly EwrRuleTable[]): string | null {
	const list = ewrRuleListIssues(tables);
	if (list) return list;
	const bad = tables.filter((t) => ewrRuleTableIssues(t).length).length;
	return bad ? `${bad} rule table${bad === 1 ? ' has' : 's have'} a problem to fix.` : null;
}

export { ewrRuleTableNotes as tableNotes };

/**
 * Change a table's % points, keeping each value under the point it was
 * entered at: a column whose point is gone is dropped, a new point gets a
 * blank column (NaN, so Save stays blocked until it is filled).
 */
export function setPoints(t: EwrRuleTable, points: number[]): EwrRuleTable {
	const move = (grid: number[][] | null) =>
		grid && grid.map((row) => points.map((p) => {
			const i = t.points.indexOf(p);
			return i >= 0 ? row[i]! : NaN;
		}));
	return { ...t, points, ewr: move(t.ewr)!, natural: move(t.natural), lowFlow: move(t.lowFlow ?? null) };
}

/** Every cell of a grid is a number ≥ 0 (a blank is null or NaN). */
export const naturalComplete = (grid: readonly (readonly (number | null)[])[]) => grid.every((row) => row.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0));

/** "10, 20, 30" or "10 20 30" or "10%;20%" → numbers; null when a part isn't a number. */
export function parsePoints(text: string): number[] | null {
	const parts = text.split(/[\s,;]+/).map((p) => p.replace(/%$/, '')).filter(Boolean);
	if (!parts.length) return null;
	const out = parts.map(Number);
	return out.every(Number.isFinite) ? out : null;
}

export interface ParsedGrid {
	/** The 12 rows in water-year order (Oct … Sep). */
	rows: number[][];
	/** % points read from a header row, or null when the paste had none. */
	points: number[] | null;
	/** Month labels were found in the first column (and the rows put in water-year order). */
	monthLabels: boolean;
	/** Notes on how the paste was read (range headers, decimal commas). */
	notes: string[];
}

const MONTHS: Record<string, number> = {
	jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};
/** Calendar month (1–12) → water-year row (Oct = 0). */
const wyRow = (m: number) => (m + 2) % 12;

/**
 * Read a 12-month rule table pasted from a spreadsheet (tab-separated), a CSV
 * or a PDF (spaces). Optionally with a header row of % points ("10", "10%",
 * "10 %" or ranges "0-10", read as their upper bound) and a first column of
 * month names in any order (Jan…Dec or Oct…Sep; full names too); without
 * month names the rows must be Oct … Sep. In a tab- or semicolon-separated
 * paste a comma between digits is a decimal comma (1,207 = 1.207), the way a
 * South African locale shows numbers; in a comma-separated paste it separates
 * cells. Returns an error message instead when the paste isn't a 12-row table.
 */
export function parseGrid(text: string): ParsedGrid | { error: string } {
	const lines = text
		.replace(/\r/g, '')
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length);
	if (!lines.length) return { error: 'Paste the table first.' };
	const sep = lines.some((l) => l.includes('\t')) ? /\t/ : lines.some((l) => l.includes(';')) ? /;/ : lines.some((l) => /\d,\d/.test(l) && l.split(',').length > 2) ? /,/ : /\s+/;
	const decimalComma = sep.source !== ',';
	const notes: string[] = [];
	let sawComma = false;
	const cellNum = (c: string): number => {
		let v = c.trim().replace(/[ \s]/g, '');
		if (decimalComma && /^-?\d+,\d+$/.test(v)) {
			v = v.replace(',', '.');
			sawComma = true;
		}
		return v === '' ? NaN : Number(v);
	};
	let cells = lines.map((l) => l.split(sep).map((c) => c.trim()));

	// A header row: no month name first, and every cell a point ("10", "10%", "0-10").
	let points: number[] | null = null;
	const headerPoint = (c: string): number | null => {
		const r = c.replace(/\s/g, '').match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)%?$/);
		if (r) return Number(r[2]);
		const p = c.replace(/\s/g, '').match(/^(\d+(?:\.\d+)?)%?$/);
		return p ? Number(p[1]) : null;
	};
	const monthOf = (c: string): number | null => MONTHS[c.trim().slice(0, 3).toLowerCase()] ?? null;
	const first = cells[0]!;
	// The first cell may be a label over the month column ("Month", "% points") rather than a point.
	const headerCells = first.filter((c, i) => !(i === 0 && headerPoint(c) === null && (c === '' || /month|%|point/i.test(c))));
	const looksLikeHeader =
		cells.length === 13 &&
		monthOf(first[0] ?? '') === null &&
		headerCells.length >= 2 &&
		headerCells.every((c) => headerPoint(c) !== null) &&
		(first.some((c) => /%|-/.test(c)) || headerCells.map((c) => headerPoint(c)!).every((v, i, a) => i === 0 || v > a[i - 1]!));
	if (looksLikeHeader) {
		points = headerCells.map((c) => headerPoint(c)!);
		if (headerCells.some((c) => /\d-\d/.test(c.replace(/\s/g, '')))) notes.push('Range headings (0–10, 10–20 …) were read as their upper bound (10, 20 …): check the % points.');
		cells = cells.slice(1);
	}
	if (cells.length !== 12) return { error: `Expected 12 rows, one per month (Oct … Sep); the paste has ${cells.length}${points ? ' after the heading row' : ''}.` };

	const labelled = cells.every((r) => monthOf(r[0] ?? '') !== null);
	const rows: number[][] = new Array(12);
	if (labelled) {
		const seen = new Set<number>();
		for (const r of cells) {
			const m = monthOf(r[0]!)!;
			if (seen.has(m)) return { error: `${r[0]} appears twice.` };
			seen.add(m);
			rows[wyRow(m)] = r.slice(1).map(cellNum);
		}
	} else {
		cells.forEach((r, i) => (rows[i] = r.map(cellNum)));
	}
	const width = rows[0]!.length;
	if (!rows.every((r) => r.length === width)) return { error: 'Every row needs the same number of values.' };
	if (points && points.length !== width) return { error: `The heading has ${points.length} % points but the rows have ${width} values.` };
	const badRow = rows.findIndex((r) => r.some((v) => !Number.isFinite(v)));
	if (badRow >= 0) return { error: `${WY[badRow]} has a value that isn't a number.` };
	if (sawComma) notes.push('Decimal commas were read as decimal points (1,207 = 1.207).');
	return { rows, points, monthLabels: labelled, notes };
}

const WY = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];

/**
 * Put a parsed paste into a table's EWR or natural grid. A header row's
 * points replace the table's; without one, the paste must have one value per
 * existing point.
 */
export function applyPaste(t: EwrRuleTable, which: GridKey, grid: ParsedGrid): EwrRuleTable | { error: string } {
	const width = grid.rows[0]!.length;
	if (!grid.points && width !== t.points.length) {
		return { error: `The paste has ${width} values a row but the table has ${t.points.length} % points: paste the heading row too, or change the points first.` };
	}
	const base = grid.points && !same(grid.points, t.points) ? setPoints(t, grid.points) : t;
	return { ...base, [which]: grid.rows.map((r) => [...r]) };
}

/** The grids a table holds: the EWR (total or low flows), the natural flows, and the low flows of a total table (engine ≥ 0.33.0). */
export type GridKey = 'ewr' | 'natural' | 'lowFlow';

/** A blank grid of a table's shape (null cells, so Save stays blocked until it is filled). */
export const blankGrid = (t: Pick<EwrRuleTable, 'points'>) => Array.from({ length: 12 }, () => t.points.map(() => null as unknown as number));

/**
 * Split the low flows out of a total table (a blank low-flow grid, or the
 * one it had), or stop (drop it). A low-flow table has none: its EWR grid is
 * the low flows.
 */
export function setLowFlowSplit(t: EwrRuleTable, on: boolean): EwrRuleTable {
	return { ...t, lowFlow: on && t.component === 'total' ? (t.lowFlow ?? blankGrid(t)) : null };
}

const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** The DRM's default points, as text for the points field. */
export const DEFAULT_POINTS_TEXT = DEFAULT_ASSURANCE_POINTS.join(', ');

/** Mm³ per month ↔ mean m³/s over a 30.4-day month, for the unit hint. */
export const mcmToM3s = (mcm: number) => (mcm * 1e6) / (30.4375 * 86_400);

// ---------------------------------------------------------------------------
// High-flow components (engine ≥ 0.33.0, docs/model.md §2.9d)
// ---------------------------------------------------------------------------

/** A new freshet: November–January, 3 days, once a year; the name and peak are left blank to fill in. */
export const blankHighFlow = (): EwrHighFlowEvent => ({ label: '', months: [11, 12, 1], peakM3s: NaN, durationDays: 3, perYear: 1 });

const FULL_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "Nov", "november", "Sept" or "11" → 11; null otherwise (at least three letters of the name, nothing after it). */
function monthOfText(t: string): number | null {
	if (/^\d+$/.test(t)) {
		const n = Number(t);
		return n >= 1 && n <= 12 ? n : null;
	}
	const s = t.toLowerCase();
	const i = s.length >= 3 ? FULL_MONTHS.findIndex((f) => f.startsWith(s)) : -1;
	return i >= 0 ? i + 1 : null;
}

/**
 * "Nov, Dec, Jan" / "11 12 1" / "Nov-Jan" → calendar months, each once, in
 * the order given; null when a part isn't a month. A range runs forward
 * through the year and wraps: Nov-Jan is 11, 12, 1.
 */
export function parseMonths(text: string): number[] | null {
	const out: number[] = [];
	for (const raw of text.split(/[\s,;/]+/).filter(Boolean)) {
		const range = raw.match(/^([a-z]+|\d+)[-–]([a-z]+|\d+)$/i);
		if (range) {
			const a = monthOfText(range[1]!);
			const b = monthOfText(range[2]!);
			if (a === null || b === null) return null;
			for (let m = a; ; m = (m % 12) + 1) {
				out.push(m);
				if (m === b) break;
			}
			continue;
		}
		const m = monthOfText(raw);
		if (m === null) return null;
		out.push(m);
	}
	return out.length ? [...new Set(out)] : null;
}

/** Cells of one row: tab-separated, else semicolons, else a CSV row (double quotes group a cell). */
function splitRow(line: string): string[] {
	if (line.includes('\t')) return line.split('\t');
	if (line.includes(';')) return line.split(';');
	const cells: string[] = [];
	let cur = '';
	let quoted = false;
	for (const ch of line) {
		if (ch === '"') quoted = !quoted;
		else if (ch === ',' && !quoted) {
			cells.push(cur);
			cur = '';
		} else cur += ch;
	}
	cells.push(cur);
	return cells;
}

/**
 * Read high-flow components pasted from a spreadsheet or a CSV file, one per
 * row: name, months, peak (m³/s), duration (days), events per year. A first
 * row whose peak isn't a number is a heading and is skipped. Months are
 * "Nov-Jan", "Nov Dec Jan" or numbers; in a CSV, quote a months cell that
 * holds commas. The engine's checks (ranges, fits in a year) run on Save.
 */
export function parseHighFlows(text: string): EwrHighFlowEvent[] | { error: string } {
	const lines = text
		.replace(/\r/g, '')
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
	if (!lines.length) return { error: 'Paste the high flows first.' };
	const num = (c: string) => (c.trim() === '' ? NaN : Number(c.trim().replace(/^(\d+),(\d+)$/, '$1.$2')));
	const out: EwrHighFlowEvent[] = [];
	for (const [i, line] of lines.entries()) {
		const cells = splitRow(line).map((c) => c.trim());
		if (cells.length < 5) return { error: `Row ${i + 1} needs five cells: name, months, peak (m³/s), duration (days), events per year.` };
		const [label, months, peak, duration, perYear] = cells as [string, string, string, string, string];
		if (i === 0 && !Number.isFinite(num(peak))) continue;
		const m = parseMonths(months);
		if (!m) return { error: `Row ${i + 1}: “${months}” isn't a list of months (e.g. Nov-Jan, or Nov Dec Jan).` };
		const e: EwrHighFlowEvent = { label, months: m, peakM3s: num(peak), durationDays: num(duration), perYear: num(perYear) };
		if (![e.peakM3s, e.durationDays, e.perYear].every(Number.isFinite)) return { error: `Row ${i + 1} has a value that isn't a number.` };
		out.push(e);
	}
	if (!out.length) return { error: 'No high-flow rows under the heading.' };
	if (out.length > EWR_HIGH_FLOWS_MAX) return { error: `At most ${EWR_HIGH_FLOWS_MAX} high-flow components per table; the paste has ${out.length}.` };
	return out;
}

/**
 * A synthetic example of the CSV the grids read, laid out as a Desktop
 * Reserve Model table (month rows, % point columns, Mm³ per month), falling
 * from the wet-condition flow at 10 % to the drought flow at 99 % and wetter
 * in summer. Invented numbers, for the layout only.
 */
export function exampleGridCsv(kind: 'total' | 'lowFlow'): string {
	const points = DEFAULT_ASSURANCE_POINTS;
	const season = [0.5, 0.8, 1.2, 1.6, 1.8, 1.5, 0.9, 0.6, 0.45, 0.4, 0.35, 0.4];
	const scale = kind === 'total' ? 1 : 0.55;
	const rows = WY.map((m, i) => [m, ...points.map((p) => (season[i]! * scale * (1.1 - p / 100)).toFixed(3))].join(','));
	return `${['Month', ...points.map((p) => `${p}%`)].join(',')}\n${rows.join('\n')}\n`;
}

/** A synthetic example of the high-flow CSV. Invented numbers. */
export const EXAMPLE_HIGH_FLOWS_CSV = 'Name,Months,Peak (m3/s),Duration (days),Events per year\nClass I freshet,Oct-Nov,2.5,2,2\nClass II flood,Dec-Mar,8,3,1\n';
