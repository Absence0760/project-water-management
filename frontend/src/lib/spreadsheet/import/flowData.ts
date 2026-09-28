// [Flow data] daily series (extract_project.py read_flow_data): the dates
// and the hydrology columns F..K. Column F (Pitman flow) is counted, never
// imported: the app has no Pitman input (docs/engine-audit.md P1).
import { toEpochDay, type SeriesKind } from '@water-management/engine';
import { type Cell, XlDateTime, cellAddress, clean, columnLetter } from './cells';
import { InvalidWorkbookError } from './errors';
import type { Report } from './report';
import type { B023Workbook } from './workbook';

export interface ImportedSeries {
	kind: SeriesKind;
	name: string;
	unit: string;
	startDate: string;
	values: (number | null)[];
}

/** [Flow data] hydrology columns F..K, in order; null = Pitman flow, not imported. */
const FLOW_DATA_KINDS: [SeriesKind | null, string][] = [
	[null, 'm3/s'],
	['flow_observed_m3s', 'm3/s'],
	['flow_logger_m3s', 'm3/s'],
	['rain_catchment_mm', 'mm'],
	['rain_chirps_mm', 'mm'],
	['rain_forecast_mm', 'mm']
];

export interface FlowData {
	dates: string[];
	series: ImportedSeries[];
	/** Days the Pitman column held a number. */
	pitmanDays: number;
}

/** openpyxl gives a date for a date-formatted cell; anything else ends the table. */
function dateOf(v: Cell): string | null {
	return v instanceof XlDateTime ? v.iso : null;
}

/** A value cell as read_flow_data keeps it: a number, else blank (text, errors, booleans and dates too). */
function reading(v: Cell): number | null {
	return typeof v === 'number' ? v : null;
}

/**
 * read_flow_data(): rows from two below the header while the date column
 * holds a date, up to and including zFlowData_DateE_DateSeries. Dates must be
 * consecutive. A column with no values is skipped.
 */
export function readFlowData(wb: B023Workbook, report: Report): FlowData {
	const { sheet, c1: cd, r1: hr } = wb.ref('zFlowData_HeaderDate');
	const lastDate = dateOf(wb.cellNamed('zFlowData_DateE_DateSeries'));
	const h1 = wb.ref('zFlowData_HeaderHydrologyData').c1;
	const dates: string[] = [];
	const raw: (number | null)[][] = FLOW_DATA_KINDS.map(() => []);
	const nonNumeric = FLOW_DATA_KINDS.map(() => ({ count: 0, first: '' }));
	const lastRow = wb.lastRow(sheet);
	for (let r = hr + 2; r <= lastRow; r++) {
		const d = dateOf(wb.cell(sheet, cd, r));
		if (d === null) break;
		dates.push(d);
		for (let i = 0; i < FLOW_DATA_KINDS.length; i++) {
			const v = wb.cell(sheet, h1 + 1 + i, r);
			raw[i]!.push(reading(v));
			if (reading(v) === null && v !== null && v !== '') {
				const n = nonNumeric[i]!;
				if (!n.count) n.first = cellAddress(h1 + 1 + i, r);
				n.count++;
			}
		}
		if (lastDate !== null && d === lastDate) break;
	}
	for (let i = 1; i < dates.length; i++) {
		if (toEpochDay(dates[i]!) - toEpochDay(dates[i - 1]!) !== 1) {
			throw new InvalidWorkbookError(`[Flow data] dates are not consecutive at ${dates[i - 1]} -> ${dates[i]}`, sheet, cellAddress(cd, hr + 2 + i));
		}
	}
	const series: ImportedSeries[] = [];
	let pitmanDays = 0;
	FLOW_DATA_KINDS.forEach(([kind, unit], i) => {
		const values = raw[i]!;
		if (kind === null) {
			pitmanDays = values.filter((v) => v !== null).length;
			return;
		}
		if (values.every((v) => v === null)) return;
		const name = clean(wb.cell(sheet, h1 + 1 + i, hr)) || kind;
		const bad = nonNumeric[i]!;
		if (bad.count) {
			report.unmap({
				code: 'non-numeric-series-values',
				message: `[Flow data] column ${columnLetter(h1 + 1 + i)} (${name}) has ${bad.count} cell${bad.count === 1 ? '' : 's'} holding text, an error or a date instead of a number, first at ${bad.first}; imported as blank`,
				sheet,
				cell: bad.first
			});
		}
		series.push({ kind, name, unit, startDate: dates[0]!, values });
	});
	return { dates, series, pitmanDays };
}
