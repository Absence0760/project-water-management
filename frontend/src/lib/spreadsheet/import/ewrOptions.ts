// The daily outlet EWR's source (engine ≥ 1.77.0, issue #455, docs/model.md
// §2.9f) from an optional [EWR options] sheet: a port of
// extract_project.py read_ewr_options(), same values, same notes in the same
// order. A workbook without the sheet's names imports as before: the
// pragmatic EWR, and no ewrDailySource key in the settings.
import type { EwrDailySource } from '@water-management/engine';
import { type Cell, clean } from './cells';
import type { Report } from './report';
import type { B023Workbook } from './workbook';

/** The [EWR options] sheet's defined names, all optional. */
export const EWR_OPTION_NAMES = [
	'zEwrOpt_Method',
	'zEwrOpt_Scaling',
	'zEwrOpt_TableMar',
	'zEwrOpt_TableArea',
	'zEwrOpt_TabM3s',
	'zEwrOpt_PctPoints',
	'zEwrOpt_NaturalPct',
	'zEwrOpt_ReservePct'
] as const;

const METHODS: Record<string, EwrDailySource['method']> = { pragmatic: 'pragmatic', 'tab file': 'tab', 'percentile tables': 'percentile' };
const SCALINGS: Record<string, EwrDailySource['scaling']> = { 'mar ratio': 'mar', 'area ratio': 'area' };
const POINTS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.99];
const METHOD_TEXT: Record<EwrDailySource['method'], string> = { pragmatic: 'the pragmatic EWR', tab: 'the DRM TAB file', percentile: 'the DRM percentile tables' };
const SHEET = 'EWR options';

/** A plain number (openpyxl's int or float, never a bool or text). */
const isNumber = (v: Cell): v is number => typeof v === 'number' && Number.isFinite(v);
/** A number above 0, else null (a blank, text or 0). */
const positive = (v: Cell): number | null => (isNumber(v) && v > 0 ? v : null);
/** Numbers ≥ 0, or null when any cell is blank, text or below 0. */
const values = (cells: Cell[]): number[] | null => (cells.every((v) => isNumber(v) && v >= 0) ? (cells as number[]) : null);

export function readEwrOptions(wb: B023Workbook, report: Report): EwrDailySource | null {
	if (!wb.has('zEwrOpt_Method')) return null;
	const raw = clean(wb.cellNamed('zEwrOpt_Method'));
	let method = METHODS[raw.toLowerCase() || 'pragmatic'];
	if (method === undefined) {
		report.note('ewr-options-fallback', `WARNING: [EWR options] the EWR method "${raw}" is not Pragmatic, TAB file or Percentile tables: imported as the pragmatic EWR`, { sheet: SHEET });
		method = 'pragmatic';
	}
	const rawScaling = wb.has('zEwrOpt_Scaling') ? clean(wb.cellNamed('zEwrOpt_Scaling')) : '';
	// No scaling given: the area ratio, the default since 2026-10-10 (issue #90 B2; engine blankEwrDailySource).
	let scaling = SCALINGS[rawScaling.toLowerCase() || 'area ratio'];
	if (scaling === undefined) {
		report.note('ewr-options-fallback', `WARNING: [EWR options] the scaling "${rawScaling}" is not MAR ratio or Area ratio: imported as Area ratio`, { sheet: SHEET });
		scaling = 'area';
	}
	const tableMarMm3 = wb.has('zEwrOpt_TableMar') ? positive(wb.cellNamed('zEwrOpt_TableMar')) : null;
	const tableAreaKm2 = wb.has('zEwrOpt_TableArea') ? positive(wb.cellNamed('zEwrOpt_TableArea')) : null;
	let tabM3s: number[] | null = null;
	if (wb.has('zEwrOpt_TabM3s')) {
		const cells = wb.named('zEwrOpt_TabM3s').flat();
		tabM3s = cells.length === 12 ? values(cells) : null;
	}
	const grid = (name: string): number[][] | null => {
		if (!wb.has(name)) return null;
		const rows = wb.named(name);
		if (rows.length !== 12 || rows.some((r) => r.length !== POINTS.length)) return null;
		const out = rows.map(values);
		return out.every((r) => r !== null) ? (out as number[][]) : null;
	};
	const naturalPctM3s = grid('zEwrOpt_NaturalPct');
	const reservePctM3s = grid('zEwrOpt_ReservePct');
	if (wb.has('zEwrOpt_PctPoints')) {
		const points = wb.named('zEwrOpt_PctPoints').flat();
		// zip() stops at the shorter list, as the Python does.
		if (points.length !== POINTS.length || points.some((v, i) => i < POINTS.length && (!isNumber(v) || Math.abs(v - POINTS[i]!) > 1e-9))) {
			report.note('ewr-options-fallback', 'WARNING: [EWR options] the percentile points are not 0.1, 0.2 ... 0.9, 0.99: the tables are read as those ten points, in order', { sheet: SHEET });
		}
	}
	const missing: string[] = [];
	if (method === 'tab' && tabM3s === null) missing.push('the 12 TAB flows');
	if (method === 'percentile' && naturalPctM3s === null) missing.push('the natural flow percentile table');
	if (method === 'percentile' && reservePctM3s === null) missing.push('the total Reserve flow percentile table');
	if (method !== 'pragmatic' && scaling === 'mar' && tableMarMm3 === null) missing.push('the table MAR');
	if (method !== 'pragmatic' && scaling === 'area' && tableAreaKm2 === null) missing.push('the table area');
	if (missing.length) {
		report.note(
			'ewr-options-fallback',
			`WARNING: [EWR options] ${METHOD_TEXT[method]} needs ${missing.join(', ')} (a number for every cell, none below 0): imported as the pragmatic EWR`,
			{ sheet: SHEET }
		);
		method = 'pragmatic';
	}
	report.note(
		'ewr-options',
		`[EWR options] the daily EWR at the outlet: ${METHOD_TEXT[method]}${method === 'pragmatic' ? '' : `, scaled by the ${scaling === 'mar' ? 'MAR' : 'area'} ratio`} (docs/model.md 2.9f)`,
		{ sheet: SHEET }
	);
	return { method, scaling, tableMarMm3, tableAreaKm2, tabM3s, naturalPctM3s, reservePctM3s };
}
