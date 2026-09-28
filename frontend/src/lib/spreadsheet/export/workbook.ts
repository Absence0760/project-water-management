// Build a run's .xlsx workbook from what the API returns (WP-1.28): the
// summary CSV spread over its sheets, the catchment and every node's daily
// series, the EWR grid, the calibration's annual volumes and the run's
// inputs. Pure (no I/O): the export worker fetches, this builds, and the unit
// tests read the result back with SheetJS.
//
// workbookPlan() decides the sheets and their rows; ./writer.ts writes them as
// the OOXML parts SheetJS used to write, byte for byte (issue #9: the export
// worker no longer ships SheetJS). A client-size run's daily sheets are
// millions of cells, so the writer streams each daily sheet's rows into bytes
// rather than holding an object or a string per cell, and ./zip.ts packs the
// parts with the platform's real deflate.
import type { RunSummary } from '@water-management/engine';
import type { Cell } from './csv';
import { parseCsv } from './csv';
import { cellFormat, DATE_FORMAT, numberFormat, unitOf } from './formats';
import { defuse, sheetNamer } from './names';
import { splitSummary, type SummarySheet } from './summary';
import { XlsxWorkbook, type XlsxCell } from './writer';

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

// ── Generic rows → cells ───────────────────────────────────────────────────

/**
 * A sheet's cells from its rows: text as text cells, numbers as numeric cells
 * with a display format from the unit in their column's header, or, without
 * one, from the nearest text cell to their left in the same row ("Mean natural
 * flow (m³/day)", 123.4). A header is a row of two or more cells that are all
 * text; it applies until the next blank row or header. `lastCol` is the
 * sheet range's last column (0-based).
 */
export function rowCells(rows: readonly Row[]): { cells: (XlsxCell | undefined)[][]; lastCol: number } {
	const cells: (XlsxCell | undefined)[][] = [];
	let header: Row | null = null;
	let maxC = 0;
	for (const row of rows) {
		if (!row.length) header = null;
		else if (row.length >= 2 && row.every((c) => c === null || typeof c === 'string') && row.some((c) => c !== null)) header = row;
		const out: (XlsxCell | undefined)[] = [];
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
		cells.push(out);
	}
	return { cells, lastCol: Math.max(0, maxC - 1) };
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
	rows.push(['A day is not met when its EWR shortfall is below zero; a unit (farm) is gridded by its EWR charge (engine ≥ 0.17.0).']);
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

// ── Daily sheets ───────────────────────────────────────────────────────────

/**
 * A daily sheet's header row: the date, then each column's header, defused
 * like every other text cell (the bulk route's headers are engine labels
 * today; the daily CSV defuses the same headers, backend export/csv.ts).
 */
export const dailyHeader = (t: DailyTable): string[] => ['date', ...t.columns.map((c) => defuse(c.header))];
/** A daily sheet's column widths in characters: the date, then 14 per column. */
export const dailyWidths = (t: DailyTable): number[] => [11, ...t.columns.map(() => 14)];
/** The Excel date serial of a table's first day. */
export const dailyDay0 = (t: DailyTable): number => Date.parse(`${t.startDate}T00:00:00Z`) / 86_400_000 + EPOCH_SERIAL;

// ── The workbook ───────────────────────────────────────────────────────────

/** Sheet order: the summary, the daily tables, then the reports and inputs. */
const AFTER_DAILY: SummarySheet[] = ['Curtailment', 'Reserve compliance', 'Annual volumes', 'Data checks'];

/** One sheet of the workbook: rows of cells, or a daily table. */
export type SheetPlan = { name: string; rows: Row[]; widths: number[] } | { name: string; daily: DailyTable };

/** The workbook's sheets, in order, with their final (unique, Excel-safe) names. */
export function workbookPlan(input: WorkbookInput): SheetPlan[] {
	const byName = splitSummary(parseCsv(input.summaryCsv));
	const name = sheetNamer();
	const fixed = ['Summary', 'Catchment', ...AFTER_DAILY, 'EWR grid', 'Inputs', 'Warnings'];
	for (const f of fixed) name(f);

	const plan: SheetPlan[] = [{ name: 'Summary', rows: byName.get('Summary') ?? [], widths: [44] }];
	if (input.catchment) plan.push({ name: 'Catchment', daily: input.catchment });
	for (const t of input.nodes) plan.push({ name: name(t.name), daily: t });
	for (const s of AFTER_DAILY) {
		let rows = byName.get(s) ?? [];
		if (s === 'Annual volumes') rows = [...rows, ...(rows.length ? [[]] : []), ...annualVolumeRows(input.summary)];
		if (rows.length) plan.push({ name: s, rows, widths: [44] });
		if (s === 'Curtailment') plan.push({ name: 'EWR grid', rows: ewrGridRows(input.summary), widths: [16] });
	}
	plan.push({ name: 'Inputs', rows: inputRows(input.settings, input.model), widths: [36] });
	const warnings = byName.get('Warnings');
	if (warnings) plan.push({ name: 'Warnings', rows: warnings, widths: [120] });
	return plan;
}

/** The workbook as .xlsx bytes. */
export async function buildWorkbook(input: WorkbookInput): Promise<Uint8Array> {
	const book = new XlsxWorkbook();
	for (const sheet of workbookPlan(input)) {
		if ('daily' in sheet) {
			const t = sheet.daily;
			book.addDaily(sheet.name, dailyHeader(t), DATE_FORMAT, dailyDay0(t), t.columns.map((c) => ({ format: numberFormat(c.unit), values: c.values })), dailyWidths(t));
		} else {
			const { cells, lastCol } = rowCells(sheet.rows);
			book.addRows(sheet.name, cells, lastCol, sheet.widths);
		}
	}
	return book.bytes();
}
