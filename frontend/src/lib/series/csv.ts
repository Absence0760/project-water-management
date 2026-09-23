// Client-side parsing of a two-column daily series CSV (date,value) into the
// API's dense representation: values[i] = value on startDate + i days, with
// null for every day missing from the file.
import { fromEpochDay, toEpochDay } from '@water-management/engine';

export interface ParsedSeries {
	startDate: string;
	endDate: string;
	values: (number | null)[];
	/** Rows that carried a numeric value. */
	rowCount: number;
	/** Days in the span with no value (missing rows or blank values). */
	missingCount: number;
	/** How d/m/y-style dates were read: 'iso' when every date was year-first. */
	dateOrder: 'iso' | DateOrder;
	/** True when no day above 12 settled the order and day/month was assumed. */
	dateOrderAssumed: boolean;
}

/** Order of a slash/dot/dash date whose year comes last: 05/01/2020. */
export type DateOrder = 'dmy' | 'mdy';

export class CsvError extends Error {
	constructor(
		message: string,
		readonly line?: number
	) {
		super(line ? `Line ${line}: ${message}` : message);
		this.name = 'CsvError';
	}
}

export const MAX_SERIES_VALUES = 60_000;

const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const SLASH_YMD = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
const DMY = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

const dateCell = (raw: string) => raw.trim().replace(/^"|"$/g, '').split(/[ T]/)[0] ?? '';

/**
 * Accepts YYYY-MM-DD, YYYY/MM/DD, and year-last dates in the given order:
 * DD/MM/YYYY (South African, the default) or MM/DD/YYYY. Optional time part
 * ignored. parseSeriesCsv picks the order for the whole file.
 */
export function parseDate(raw: string, order: DateOrder = 'dmy'): string | null {
	const s = dateCell(raw);
	let y: number, m: number, d: number;
	let match = ISO.exec(s) ?? SLASH_YMD.exec(s);
	if (match) {
		[y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
	} else if ((match = DMY.exec(s))) {
		const [a, b] = [Number(match[1]), Number(match[2])];
		[d, m] = order === 'dmy' ? [a, b] : [b, a];
		y = Number(match[3]);
	} else {
		return null;
	}
	const date = new Date(Date.UTC(y, m - 1, d));
	if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
	return date.toISOString().slice(0, 10);
}

function splitRow(line: string): string[] {
	const delim = line.includes(';') && !line.includes(',') ? ';' : line.includes('\t') && !line.includes(',') ? '\t' : ',';
	return line.split(delim).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
}

/**
 * Day/month or month/day for the whole file, from the year-last dates in it:
 * a first part above 12 means day/month, a second part above 12 month/day.
 * Both is a mixed file (rejected); neither leaves day/month assumed.
 */
function detectOrder(cells: string[]): { order: 'iso' | DateOrder; assumed: boolean } {
	let yearLast = false;
	let dayFirst = false;
	let monthFirst = false;
	for (const c of cells) {
		const m = DMY.exec(dateCell(c));
		if (!m) continue;
		yearLast = true;
		if (Number(m[1]) > 12) dayFirst = true;
		if (Number(m[2]) > 12) monthFirst = true;
	}
	if (dayFirst && monthFirst) throw new CsvError('dates mix day/month and month/day order; use YYYY-MM-DD');
	if (!yearLast) return { order: 'iso', assumed: false };
	return monthFirst ? { order: 'mdy', assumed: false } : { order: 'dmy', assumed: !dayFirst };
}

/** A header cell is text; a cell starting with a digit is a (possibly bad) date. */
const isHeaderCell = (cell: string) => !/^\d/.test(dateCell(cell));

export function parseSeriesCsv(text: string): ParsedSeries {
	const lines = text.replace(/^﻿/, '').split(/\r?\n/);
	const rows = lines.map((raw, i) => ({ line: raw.trim(), n: i + 1 })).filter((r) => r.line && !r.line.startsWith('#'));
	const cellsOf = rows.map((r) => splitRow(r.line));
	const { order, assumed } = detectOrder(cellsOf.map((c) => c[0] ?? ''));
	const byDay = new Map<number, number | null>();
	for (let r = 0; r < rows.length; r++) {
		const cells = cellsOf[r]!;
		const i = rows[r]!.n - 1;
		const date = parseDate(cells[0] ?? '', order === 'mdy' ? 'mdy' : 'dmy');
		if (!date) {
			if (r === 0 && isHeaderCell(cells[0] ?? '')) continue; // header row
			throw new CsvError(`"${cells[0]}" is not a date (use YYYY-MM-DD)`, i + 1);
		}
		if (cells.length < 2) throw new CsvError('expected two columns: date,value', i + 1);
		const rawVal = cells[1]!;
		let value: number | null = null;
		if (rawVal !== '' && !/^(na|nan|null|-)$/i.test(rawVal)) {
			value = Number(rawVal.replace(/\s/g, ''));
			if (!Number.isFinite(value)) throw new CsvError(`"${rawVal}" is not a number`, i + 1);
		}
		const day = toEpochDay(date);
		if (byDay.has(day)) throw new CsvError(`duplicate date ${date}`, i + 1);
		byDay.set(day, value);
	}
	if (byDay.size === 0) throw new CsvError('no data rows found');
	const days = [...byDay.keys()];
	const start = Math.min(...days);
	const end = Math.max(...days);
	const length = end - start + 1;
	if (length > MAX_SERIES_VALUES) {
		throw new CsvError(`series spans ${length.toLocaleString('en-US')} days; the limit is ${MAX_SERIES_VALUES.toLocaleString('en-US')}`);
	}
	const values: (number | null)[] = new Array(length).fill(null);
	let rowCount = 0;
	for (const [day, v] of byDay) {
		values[day - start] = v;
		if (v !== null) rowCount++;
	}
	return {
		startDate: fromEpochDay(start),
		endDate: fromEpochDay(end),
		values,
		rowCount,
		missingCount: length - rowCount,
		dateOrder: order,
		dateOrderAssumed: assumed
	};
}
