// Build a run's .xlsx workbook from what the API returns (WP-1.28): the
// summary CSV spread over its sheets, the catchment and every node's daily
// series, the EWR grid, the calibration's annual volumes and the run's
// inputs. Pure (no I/O): the export worker fetches, this builds, and the unit
// tests read the result back with the same library.
//
// SheetJS (`xlsx`, CDN tarball, decision D8) writes everything, but a
// client-size run's daily sheets are millions of cells, and SheetJS holds a
// JavaScript object per cell and a copy of each sheet's XML while writing:
// ~4 GB for a 45-year, 13-node run, past what a browser tab can have. So a
// daily sheet goes to SheetJS as a stub (its header row and one probe row with
// every column's number format), and its rows are then streamed into the
// sheet XML SheetJS wrote, in exactly the markup SheetJS writes for a numeric
// cell (`<c r="B2" s="2"><v>1.5</v></c>`). workbook.test.ts pins the
// equivalence: a daily sheet built this way is byte-for-byte the sheet
// SheetJS writes from the same cells. SheetJS writes the parts uncompressed
// and ./zip.ts packs them with the platform's real deflate (SheetJS's own
// browser deflate is fixed-Huffman: ~2.5 times the size).
import type { RunSummary } from '@water-management/engine';
import * as XLSX from 'xlsx/dist/xlsx.mini.min';
import type { Cell } from './csv';
import { parseCsv } from './csv';
import { cellFormat, DATE_FORMAT, numberFormat, unitOf } from './formats';
import { defuse, sheetNamer } from './names';
import { splitSummary, type SummarySheet } from './summary';
import { zip, type ZipEntry } from './zip';

/** One daily column: the daily CSV's header and the series' unit and values. */
export interface DailyColumn {
	header: string;
	unit: string | null;
	values: ArrayLike<number | null>;
}

/** One node's (or the catchment's) daily table, as the bulk route returns it. */
export interface DailyTable {
	/** Sheet name wanted (a node's name, "Catchment"); made unique and Excel-safe here. */
	name: string;
	startDate: string;
	columns: DailyColumn[];
}

export interface WorkbookInput {
	/** The text of …/export/summary.csv for the run. */
	summaryCsv: string;
	/** The run's summary (GET …/runs/:runId): the EWR grid and the calibration's annual volumes. */
	summary: RunSummary;
	/** The run's settings and model snapshots (GET …/runs/:runId), for the Inputs sheet. */
	settings: Record<string, unknown> | null | undefined;
	model: Record<string, unknown> | null | undefined;
	catchment: DailyTable | null;
	/** In network order. */
	nodes: DailyTable[];
}

type Row = Cell[];
const MONTHS_WY = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
/** Water year by the calendar year it starts in: 2001 → "2001/02" (as the CSV writes it). */
const waterYearText = (y: number) => `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
/** Excel's serial for 1970-01-01 (the 1900 date system). */
const EPOCH_SERIAL = 25569;

// ── Generic rows → a sheet ────────────────────────────────────────────────

/**
 * A sheet of rows: text as string cells, numbers as numeric cells with a
 * display format from the unit in their column's header, or, without one,
 * from the nearest text cell to their left in the same row ("Mean natural
 * flow (m³/day)", 123.4). A header is a row of two or more cells that are all
 * text; it applies until the next blank row or header.
 */
function rowsSheet(rows: readonly Row[], widths: number[] = [44]): XLSX.WorkSheet {
	const data: XLSX.CellObject[][] = [];
	let header: Row | null = null;
	let maxC = 0;
	for (const row of rows) {
		if (!row.length) header = null;
		else if (row.length >= 2 && row.every((c) => c === null || typeof c === 'string') && row.some((c) => c !== null)) header = row;
		const out: XLSX.CellObject[] = [];
		let label: string | null = null;
		row.forEach((c, i) => {
			if (typeof c === 'string') {
				out[i] = { t: 's', v: c };
				label = c;
			} else if (typeof c === 'number' && Number.isFinite(c)) {
				const h = header?.[i];
				const unit = (typeof h === 'string' ? unitOf(h) : null) ?? (label ? unitOf(label) : null);
				const z = cellFormat(unit, c);
				out[i] = z ? { t: 'n', v: c, z } : { t: 'n', v: c };
			}
		});
		maxC = Math.max(maxC, row.length);
		data.push(out);
	}
	const ws: XLSX.DenseWorkSheet = { '!data': data } as XLSX.DenseWorkSheet;
	ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length - 1), c: Math.max(0, maxC - 1) } });
	ws['!cols'] = widths.map((wch) => ({ wch }));
	return ws;
}

// ── The sheets built from the run's JSON ───────────────────────────────────

/** The water-year × month EWR grid (RunSummary.ewrCompliance, engine ≥ 0.3.0), days and volume per site. */
export function ewrGridRows(summary: RunSummary): Row[] {
	const g = summary.ewrCompliance;
	const rows: Row[] = [['EWR compliance by water year and month']];
	if (!g) {
		rows.push(['Run made before engine 0.3.0: no EWR grid. Run it again to see it.']);
		return rows;
	}
	rows.push(['A day is not met when its EWR shortfall is below zero; a farm is gridded by its EWR charge (engine ≥ 0.17.0).']);
	const grid = (title: string, cells: number[][], unit?: string) => {
		rows.push([title]);
		rows.push(['Water year', ...MONTHS_WY.map((m) => (unit ? `${m} (${unit})` : m)), unit ? `Year (${unit})` : 'Year']);
		g.waterYears.forEach((y, r) => {
			const row = cells[r] ?? [];
			rows.push([waterYearText(y), ...MONTHS_WY.map((_, m) => row[m] ?? null), row.reduce((a, b) => a + b, 0)]);
		});
	};
	rows.push([]);
	grid('Days simulated', g.days);
	for (const site of [g.outlet, ...g.farms]) {
		rows.push([]);
		rows.push(['Site', site.nodeId === null ? 'Outlet: simulated outflow vs the full pragmatic EWR' : defuse(site.name)]);
		grid('Days the EWR was not met', site.daysNotMet);
		grid('Volume short of the EWR', site.shortfallM3, 'm³');
	}
	return rows;
}

/** Observed vs simulated volume per water year over the calibration window (CalibrationStats.annualVolumes). */
export function annualVolumeRows(summary: RunSummary): Row[] {
	const rows: Row[] = [['Calibration: observed and simulated volume per water year']];
	const v = summary.calibration?.annualVolumes;
	if (!v?.length) {
		rows.push([summary.calibration ? 'No annual volumes in this run (engine before they were recorded)' : 'No observed flow series — calibration not computed']);
		return rows;
	}
	rows.push(['Water year', 'Days observed', 'Days in the window', 'Observed (Mm³)', 'Simulated (Mm³)', 'Difference (%)']);
	for (const a of v) rows.push([waterYearText(a.waterYear), a.days, a.daysInWindow, a.observedMm3, a.simulatedMm3, a.diffPct]);
	return rows;
}

type Json = unknown;
const isObject = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Flatten a JSON value to `path → scalar` pairs: `a.b`, arrays `a[1]` (1-based, so monthly arrays read Jan = [1]). */
function flatten(v: Json, path: string, out: [string, Json][]): void {
	if (Array.isArray(v)) {
		if (!v.length) out.push([path, null]);
		v.forEach((x, i) => flatten(x, `${path}[${i + 1}]`, out));
	} else if (isObject(v)) {
		const keys = Object.keys(v);
		if (!keys.length) out.push([path, null]);
		for (const k of keys) flatten(v[k], path ? `${path}.${k}` : k, out);
	} else out.push([path, v]);
}

/** A scalar as a cell: names and text defused, ids of named things replaced by the name. */
function inputCell(v: Json, names: Map<string, string>): Cell {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v === 'boolean') return v ? 'yes' : 'no';
	if (typeof v === 'string') return defuse(names.get(v) ?? v);
	return null;
}

/**
 * The run's inputs as it ran: every setting (one row per setting, an array's
 * values across the row), then each part of the model (nodes, crops, crop
 * areas, transfers, users, …) as a table, one row per item. References to
 * another item by id show its name.
 */
export function inputRows(settings: Record<string, unknown> | null | undefined, model: Record<string, unknown> | null | undefined): Row[] {
	const rows: Row[] = [];
	const names = new Map<string, string>();
	for (const part of Object.values(model ?? {})) {
		if (Array.isArray(part)) for (const x of part) if (isObject(x) && typeof x.id === 'string' && typeof x.name === 'string') names.set(x.id, x.name);
	}
	rows.push(['Settings the run used']);
	if (!settings) rows.push(['Not recorded for this run']);
	for (const [key, value] of Object.entries(settings ?? {})) {
		// One row per setting; an array of numbers (monthly values) runs across the row.
		if (Array.isArray(value) && value.every((x) => !isObject(x) && !Array.isArray(x))) {
			rows.push([key, ...value.map((x) => inputCell(x, names))]);
			continue;
		}
		const flat: [string, Json][] = [];
		flatten(value, key, flat);
		for (const [p, x] of flat) rows.push([p, inputCell(x, names)]);
	}
	for (const [part, items] of Object.entries(model ?? {})) {
		if (!Array.isArray(items)) continue;
		rows.push([]);
		rows.push([`Model: ${part}`]);
		if (!items.length) {
			rows.push(['none']);
			continue;
		}
		const flats = items.map((x) => {
			const f: [string, Json][] = [];
			flatten(x, '', f);
			return new Map(f.filter(([k]) => k !== 'id'));
		});
		const cols: string[] = [];
		for (const f of flats) for (const k of f.keys()) if (!cols.includes(k)) cols.push(k);
		// The name first, where items have one.
		cols.sort((a, b) => (a === 'name' ? -1 : b === 'name' ? 1 : 0));
		rows.push(cols);
		for (const f of flats) rows.push(cols.map((k) => inputCell(f.get(k), names)));
	}
	return rows;
}

// ── Daily sheets: a SheetJS stub, then the rows streamed into its XML ──────

/** Days in a table: its longest column. */
const tableDays = (t: DailyTable) => Math.max(0, ...t.columns.map((c) => c.values.length));

/**
 * The stub SheetJS writes for a daily table: the header row, and when the
 * table has days a probe row with one cell per column in that column's
 * format, so SheetJS registers the formats and names their style ids. Both
 * rows are replaced by streamDailySheet, which keeps the header row as written.
 */
export function dailyStub(t: DailyTable): XLSX.WorkSheet {
	const header: XLSX.CellObject[] = [{ t: 's', v: 'date' }, ...t.columns.map((c): XLSX.CellObject => ({ t: 's', v: c.header }))];
	const data: XLSX.CellObject[][] = [header];
	if (tableDays(t) > 0) {
		data.push([{ t: 'n', v: 0, z: DATE_FORMAT }, ...t.columns.map((c): XLSX.CellObject => cellWithFormat(0, numberFormat(c.unit)))]);
	}
	const ws = { '!data': data } as XLSX.DenseWorkSheet;
	ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: data.length - 1, c: t.columns.length } });
	ws['!cols'] = [{ wch: 11 }, ...t.columns.map(() => ({ wch: 14 }))];
	return ws;
}

const cellWithFormat = (v: number, z: string | undefined): XLSX.CellObject => (z ? { t: 'n', v, z } : { t: 'n', v });

/** The full cells of a daily table: what SheetJS would be given without the stub (tests compare the two). */
export function dailyCells(t: DailyTable): XLSX.WorkSheet {
	const ws = dailyStub(t) as XLSX.DenseWorkSheet;
	const days = tableDays(t);
	const data = ws['!data'].slice(0, 1);
	const formats = t.columns.map((c) => numberFormat(c.unit));
	const day0 = Date.parse(`${t.startDate}T00:00:00Z`) / 86_400_000 + EPOCH_SERIAL;
	for (let r = 0; r < days; r++) {
		const row: XLSX.CellObject[] = [{ t: 'n', v: day0 + r, z: DATE_FORMAT }];
		t.columns.forEach((c, i) => {
			const v = c.values[r];
			if (typeof v === 'number' && Number.isFinite(v)) row[i + 1] = cellWithFormat(v, formats[i]);
		});
		data.push(row);
	}
	ws['!data'] = data;
	ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: days, c: t.columns.length } });
	return ws;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Replace the stub's rows in SheetJS's sheet XML with the table's: the header
 * row as SheetJS wrote it, then one row per day. Each number is `String(v)`
 * (full precision, as SheetJS writes it); a missing day is no cell at all.
 */
export function streamDailySheet(stubXml: string, t: DailyTable): Uint8Array {
	const days = tableDays(t);
	const last = XLSX.utils.encode_col(t.columns.length);
	const open = stubXml.indexOf('<sheetData>') + '<sheetData>'.length;
	const close = stubXml.indexOf('</sheetData>');
	const rows = stubXml.slice(open, close);
	const headerEnd = rows.indexOf('</row>') + '</row>'.length;
	const probe = rows.slice(headerEnd);
	if (open < '<sheetData>'.length || close < 0 || !probe.startsWith('<row r="2"')) throw new Error('unexpected sheet XML from the spreadsheet library');
	// Each column's style attribute, as SheetJS chose it for the probe cell.
	const style = Array.from({ length: t.columns.length + 1 }, (_, c) => {
		const m = new RegExp(`<c r="${XLSX.utils.encode_col(c)}2"( s="\\d+")?`).exec(probe);
		if (!m) throw new Error('unexpected sheet XML from the spreadsheet library');
		return m[1] ?? '';
	});
	const stubRef = `A1:${last}2`;
	const fullRef = `A1:${last}${days + 1}`;
	const chunks: Uint8Array[] = [enc.encode(stubXml.slice(0, open).split(stubRef).join(fullRef) + rows.slice(0, headerEnd))];
	const letters = Array.from({ length: t.columns.length }, (_, i) => XLSX.utils.encode_col(i + 1));
	const day0 = Date.parse(`${t.startDate}T00:00:00Z`) / 86_400_000 + EPOCH_SERIAL;
	let buf = '';
	for (let r = 0; r < days; r++) {
		const R = r + 2;
		buf += `<row r="${R}"><c r="A${R}"${style[0]}><v>${day0 + r}</v></c>`;
		for (let i = 0; i < t.columns.length; i++) {
			const v = t.columns[i]!.values[r];
			if (typeof v === 'number' && Number.isFinite(v)) buf += `<c r="${letters[i]}${R}"${style[i + 1]}><v>${v}</v></c>`;
		}
		buf += '</row>';
		if (buf.length > 1 << 20) {
			chunks.push(enc.encode(buf));
			buf = '';
		}
	}
	chunks.push(enc.encode(buf + stubXml.slice(close).split(stubRef).join(fullRef)));
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let o = 0;
	for (const c of chunks) {
		out.set(c, o);
		o += c.length;
	}
	return out;
}

// ── The workbook ───────────────────────────────────────────────────────────

/** Sheet order: the summary, the daily tables, then the reports and inputs. */
const AFTER_DAILY: SummarySheet[] = ['Curtailment', 'Reserve compliance', 'Annual volumes', 'Data checks'];

/** The workbook as .xlsx bytes. */
export async function buildWorkbook(input: WorkbookInput): Promise<Uint8Array> {
	const byName = splitSummary(parseCsv(input.summaryCsv));
	const name = sheetNamer();
	const fixed = ['Summary', 'Catchment', ...AFTER_DAILY, 'EWR grid', 'Inputs', 'Warnings'];
	for (const f of fixed) name(f);

	const wb = XLSX.utils.book_new();
	const add = (ws: XLSX.WorkSheet, sheet: string) => XLSX.utils.book_append_sheet(wb, ws, sheet);
	add(rowsSheet(byName.get('Summary') ?? []), 'Summary');

	const daily: { index: number; table: DailyTable }[] = [];
	const tables = [...(input.catchment ? [{ ...input.catchment, sheet: 'Catchment' }] : []), ...input.nodes.map((t) => ({ ...t, sheet: name(t.name) }))];
	for (const t of tables) {
		daily.push({ index: wb.SheetNames.length, table: t });
		add(dailyStub(t), t.sheet);
	}

	for (const s of AFTER_DAILY) {
		let rows = byName.get(s) ?? [];
		if (s === 'Annual volumes') rows = [...rows, ...(rows.length ? [[]] : []), ...annualVolumeRows(input.summary)];
		if (rows.length) add(rowsSheet(rows), s);
		if (s === 'Curtailment') add(rowsSheet(ewrGridRows(input.summary), [16]), 'EWR grid');
	}
	add(rowsSheet(inputRows(input.settings, input.model), [36]), 'Inputs');
	const warnings = byName.get('Warnings');
	if (warnings) add(rowsSheet(warnings, [120]), 'Warnings');

	const raw = XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: false }) as ArrayBuffer;
	const cfb = XLSX.CFB.read(new Uint8Array(raw), { type: 'array' });
	for (const { index, table } of daily) {
		if (tableDays(table) === 0) continue;
		const file = XLSX.CFB.find(cfb, `/xl/worksheets/sheet${index + 1}.xml`) as { content: Uint8Array; size: number } | null;
		if (!file) throw new Error('unexpected workbook layout from the spreadsheet library');
		const content = streamDailySheet(dec.decode(file.content), table);
		file.content = content;
		file.size = content.length;
	}
	return zip(workbookParts(cfb));
}

/**
 * The parts of SheetJS's container, in its order, as its own zip writer picks
 * them: files with content, without the container's internal marker entry.
 */
function workbookParts(cfb: { FullPaths: string[]; FileIndex: { type: number; content?: Uint8Array | number[]; size?: number }[] }): ZipEntry[] {
	const root = cfb.FullPaths[0]!;
	const out: ZipEntry[] = [];
	for (let i = 1; i < cfb.FullPaths.length; i++) {
		const f = cfb.FileIndex[i]!;
		const name = cfb.FullPaths[i]!.slice(root.length);
		if (f.type !== 2 || !f.size || !f.content || !f.content.length || name === '\u0001Sh33tJ5') continue;
		out.push({ name, data: f.content instanceof Uint8Array ? f.content : Uint8Array.from(f.content) });
	}
	return out;
}
