// Client-side parsing of a two-column daily series CSV (date,value) into the
// API's dense representation: values[i] = value on startDate + i days, with
// null for every day missing from the file.
//
// Read per file, never per row: the delimiter (comma, semicolon or tab, from
// the rows themselves, outside quotes) and the decimal separator (from the
// values that settle it: 12,5 or 0,359 say decimal comma; 2.5 or 1,234.5 say
// decimal point). A file that mixes the two, or whose every separated value
// reads either way (1,234 in a semicolon file), is refused, never guessed.
// DWS hydrology exports (fixed-width YYYYMMDD) are read by ./dws.ts;
// ./file.ts picks the reader.
import { fromEpochDay, toEpochDay, type DayBoundary } from '@water-management/engine';
import type { DwsImport } from './dws';
import { fmtNum } from '$lib/format/number';

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
	/** Sub-daily readings added up into days (only when parsed with a day boundary). */
	subDaily?: SubDailyInfo;
	/** A DWS export's quality codes and the rows it dropped as gaps (./dws.ts). */
	dws?: DwsImport;
	/**
	 * Rows of a plain CSV whose value was negative, read as gaps (issue #51):
	 * every series kind is a rain, flow or evaporation, never below zero, so
	 * a negative is a "no reading" placeholder (-999, -1), as the DWS import
	 * reads it. Absent when there were none.
	 */
	negativeGaps?: number;
}

/** How a sub-daily file was added up into days (issue #40 (b), 033_series_day_boundary.sql). */
export interface SubDailyInfo {
	dayBoundary: DayBoundary;
	/** Rows with a value. */
	readings: number;
	/** The most common number of readings in a day: the file's interval (24 for hourly). */
	readingsPerDay: number;
	/** Days with a value but fewer readings than that: their totals may be short. */
	incompleteDays: number;
}

/** Order of a slash/dot/dash date whose year comes last: 05/01/2020. */
export type DateOrder = 'dmy' | 'mdy';

export class CsvError extends Error {
	constructor(
		message: string,
		readonly line?: number,
		/** The file holds several timed readings a day: parse it again with a day boundary. */
		readonly subDaily = false
	) {
		super(line ? `Line ${line}: ${message}` : message);
		this.name = 'CsvError';
	}
}

export const MAX_SERIES_VALUES = 60_000;

const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
/** 20200105, the date column of DWS and many logger exports. */
const COMPACT = /^(\d{4})(\d{2})(\d{2})$/;
const SLASH_YMD = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
const DMY = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

const dateCell = (raw: string) => raw.trim().replace(/^"|"$/g, '').split(/[ T]/)[0] ?? '';

/**
 * Minutes after midnight of a cell's time part ("2020-01-05 08:30", "…T08:30:00",
 * "1/5/2020 7:30 PM"), 0–1440 (24:00 allowed); null without one; NaN for a bad
 * one. A 12-hour time needs its AM or PM read (7:00 PM is 19:00, 12:00 AM
 * midnight); anything else after the time (a zone, "Z") is refused, never
 * dropped, since dropping it would book the reading to the wrong hour.
 */
export function parseTime(raw: string): number | null {
	const t = raw.trim().replace(/^"|"$/g, '').split(/[ T]/).slice(1).join(' ').trim();
	if (t === '') return null;
	const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:\s*([ap])\.?m\.?)?$/i.exec(t);
	if (!m) return NaN;
	let [h, min, sec] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
	if (m[4]) {
		if (h < 1 || h > 12) return NaN;
		h = (h % 12) + (m[4].toLowerCase() === 'p' ? 12 : 0);
	}
	if (min > 59 || sec > 59 || h > 24 || (h === 24 && (min > 0 || sec > 0))) return NaN;
	return h * 60 + min + sec / 60;
}

const BOUNDARY_MINUTES: Record<DayBoundary, number> = { '00:00': 0, '08:00': 480 };

/**
 * The day a timed reading is booked to (epoch day). A logger's timestamp
 * closes its interval (the rain fell in the hour before 09:00 for a 09:00
 * reading), so a reading stamped exactly at the boundary belongs to the
 * window it closes: with '08:00', 08:00 on the 6th closes the window
 * 08:00 on the 5th → 08:00 on the 6th, booked to the 5th, the day it starts
 * (the manual-gauge convention); with '00:00', midnight closes the day before.
 */
export function bookedDay(date: string, minutes: number, boundary: DayBoundary): number {
	const instant = toEpochDay(date) * 1440 + minutes;
	return Math.floor((instant - BOUNDARY_MINUTES[boundary] - 1e-6) / 1440);
}

/**
 * Accepts YYYY-MM-DD, YYYY/MM/DD, YYYYMMDD, and year-last dates in the given order:
 * DD/MM/YYYY (South African, the default) or MM/DD/YYYY. Optional time part
 * ignored. parseSeriesCsv picks the order for the whole file.
 */
export function parseDate(raw: string, order: DateOrder = 'dmy'): string | null {
	const s = dateCell(raw);
	let y: number, m: number, d: number;
	let match = ISO.exec(s) ?? SLASH_YMD.exec(s) ?? COMPACT.exec(s);
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

export type Delimiter = ',' | ';' | '\t';

/**
 * A line's fields, split on the delimiter outside double quotes (a quoted
 * field may hold the delimiter, and "" is a quote inside one). Fields are
 * trimmed and unquoted. A field can't span lines.
 */
export function splitFields(line: string, delim: Delimiter): string[] {
	const out: string[] = [];
	let cur = '';
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i]!;
		if (quoted) {
			if (c !== '"') cur += c;
			else if (line[i + 1] === '"') (cur += '"'), i++;
			else quoted = false;
		} else if (c === '"' && cur.trim() === '') {
			quoted = true;
			cur = '';
		} else if (c === delim) {
			out.push(cur.trim());
			cur = '';
		} else {
			cur += c;
		}
	}
	out.push(cur.trim());
	return out;
}

const DELIMITERS: readonly Delimiter[] = ['\t', ';', ','];

/**
 * The file's delimiter: the first of tab, semicolon and comma that splits
 * every one of its first rows (outside quotes). Tab and semicolon come first
 * because a file that uses them may use the comma as its decimal separator
 * (2020-01-05;12,5); a comma file can't carry an unquoted decimal comma.
 */
export function detectDelimiter(lines: string[]): Delimiter {
	const sample = lines.slice(0, 50);
	return DELIMITERS.find((d) => sample.length > 0 && sample.every((l) => splitFields(l, d).length >= 2)) ?? ',';
}

const delimName = (d: Delimiter) => (d === '\t' ? 'tabs' : d === ';' ? 'semicolons' : 'commas');

type Decimal = '.' | ',';
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const NUMERIC_LOOKING = /^[+-]?[\d.,]*\d[\d.,]*([eE][+-]?\d+)?$/;
const GROUP_COMMA = /^[+-]?\d{1,3}(,\d{3})+(\.\d*)?([eE][+-]?\d+)?$/;
const GROUP_DOT = /^[+-]?\d{1,3}(\.\d{3})+(,\d*)?([eE][+-]?\d+)?$/;

/**
 * What one value says about the decimal separator: '.' or ',' when it
 * settles it (12,5 · 0,359 · 1.234,5 → ','; 2.5 · 1,234.5 · 1,234,567 → '.'),
 * 'either' when it reads both ways (1,234 or 1.234: a thousands group, or three
 * decimals), null when it has no separator or isn't a number at all.
 */
function decimalHint(s: string): Decimal | 'either' | null {
	if (!NUMERIC_LOOKING.test(s)) return null;
	const commas = s.split(',').length - 1;
	const dots = s.split('.').length - 1;
	if (commas && dots) return s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
	if (commas > 1) return GROUP_COMMA.test(s) ? '.' : null;
	if (dots > 1) return GROUP_DOT.test(s) ? ',' : null;
	if (commas) return /^[+-]?[1-9]\d{0,2},\d{3}$/.test(s) ? 'either' : ',';
	if (dots) return /^[+-]?[1-9]\d{0,2}\.\d{3}$/.test(s) ? 'either' : '.';
	return null;
}

interface Cell {
	s: string;
	line: number;
}

/**
 * The file's decimal separator, from the values that settle it. Values that
 * settle it both ways are refused (the file mixes conventions). With none, a
 * comma file reads its values with a decimal point (its unquoted values can't
 * hold a decimal comma, and 1,234 in quotes is how this app and a spreadsheet
 * write a thousand); a semicolon or tab file with a value that reads either
 * way (1,234 or 1.234) is refused rather than guessed.
 */
function detectDecimal(cells: Cell[], delim: Delimiter): Decimal {
	let point: Cell | undefined;
	let comma: Cell | undefined;
	let either: Cell | undefined;
	for (const c of cells) {
		const h = decimalHint(c.s);
		if (h === '.') point ??= c;
		else if (h === ',') comma ??= c;
		else if (h === 'either') either ??= c;
	}
	if (point && comma) {
		throw new CsvError(
			`the file mixes decimal points ("${point.s}", line ${point.line}) and decimal commas ("${comma.s}", line ${comma.line}); use one throughout`
		);
	}
	if (point) return '.';
	if (comma) return ',';
	if (either && delim !== ',') {
		const sep = either.s.includes(',') ? ',' : '.';
		const [whole, frac] = either.s.split(sep) as [string, string];
		throw new CsvError(
			`"${either.s}" could be ${whole}${frac} or ${whole}.${frac}, and no other value in the file shows whether "${sep}" is a decimal or a thousands separator; write it as ${whole}${frac} or ${whole}.${frac}`,
			either.line
		);
	}
	return '.';
}

/** A value with the file's decimal separator (thousands separators only in valid groups); NaN when it isn't a number. */
function readNumber(s: string, decimal: Decimal): number {
	let t = s;
	if (decimal === '.') {
		if (t.includes(',')) {
			if (!GROUP_COMMA.test(t)) return NaN;
			t = t.replace(/,/g, '');
		}
	} else {
		if (t.includes('.')) {
			if (!GROUP_DOT.test(t)) return NaN;
			t = t.replace(/\./g, '');
		}
		t = t.replace(',', '.');
	}
	return NUMBER.test(t) ? Number(t) : NaN;
}

const NO_READING = /^(na|nan|null|-)$/i;

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

/**
 * Days keyed by epoch day → the dense series: values[i] on startDate + i,
 * null for every day the map lacks or holds as null. Refuses an empty map and
 * a span over MAX_SERIES_VALUES.
 */
export function denseDays(byDay: Map<number, number | null>): Pick<ParsedSeries, 'startDate' | 'endDate' | 'values' | 'rowCount' | 'missingCount'> {
	if (byDay.size === 0) throw new CsvError('no data rows found');
	let start = Infinity;
	let end = -Infinity;
	for (const day of byDay.keys()) {
		if (day < start) start = day;
		if (day > end) end = day;
	}
	const length = end - start + 1;
	if (length > MAX_SERIES_VALUES) {
		throw new CsvError(`series spans ${fmtNum(length)} days; the limit is ${fmtNum(MAX_SERIES_VALUES)}`);
	}
	const values: (number | null)[] = new Array(length).fill(null);
	let rowCount = 0;
	for (const [day, v] of byDay) {
		values[day - start] = v;
		if (v !== null) rowCount++;
	}
	return { startDate: fromEpochDay(start), endDate: fromEpochDay(end), values, rowCount, missingCount: length - rowCount };
}

/**
 * Parse a date,value CSV into daily values. With `dayBoundary`, the file is
 * sub-daily (hourly, 10-minute…): each row's date and time say when its
 * interval ended, and the values are added up into days in that window
 * (bookedDay). Without it, one row per day; a file with several timed rows a
 * day throws a CsvError marked `subDaily`, so the form can ask for a boundary.
 */
export function parseSeriesCsv(text: string, opts: { dayBoundary?: DayBoundary } = {}): ParsedSeries {
	const lines = text.replace(/^﻿/, '').split(/\r\n?|\n/);
	const rows = lines.map((raw, i) => ({ line: raw.trim(), n: i + 1 })).filter((r) => r.line && !r.line.startsWith('#'));
	const delim = detectDelimiter(rows.map((r) => r.line));
	const cellsOf = rows.map((r) => splitFields(r.line, delim));
	const { order, assumed } = detectOrder(cellsOf.map((c) => c[0] ?? ''));
	const dateOrder = order === 'mdy' ? 'mdy' : 'dmy';
	// A header row is text in the date column, and stays out of the decimal vote.
	const first = cellsOf[0]?.[0] ?? '';
	const skip = rows.length > 0 && !parseDate(first, dateOrder) && isHeaderCell(first) ? 1 : 0;
	const valueCells: Cell[] = [];
	for (let r = skip; r < rows.length; r++) {
		const v = (cellsOf[r]![1] ?? '').replace(/\s/g, '');
		if (v !== '' && !NO_READING.test(v)) valueCells.push({ s: v, line: rows[r]!.n });
	}
	const decimal = detectDecimal(valueCells, delim);
	const byDay = new Map<number, number | null>();
	const readingsOn = new Map<number, number>();
	let timed = false;
	let readings = 0;
	let negativeGaps = 0;
	for (let r = skip; r < rows.length; r++) {
		const cells = cellsOf[r]!;
		const i = rows[r]!.n - 1;
		const date = parseDate(cells[0] ?? '', dateOrder);
		if (!date) {
			// "2020-01-05;12" in a comma file: the row is split another way, not a bad date.
			const other = /^([^,;\t]+)([,;\t])/.exec(cells[0] ?? '');
			if (other && other[2] !== delim && parseDate(other[1]!, dateOrder)) {
				throw new CsvError(`this row separates its columns with ${delimName(other[2] as Delimiter)}, but the file uses ${delimName(delim)}`, i + 1);
			}
			throw new CsvError(`"${cells[0]}" is not a date (use YYYY-MM-DD)`, i + 1);
		}
		if (cells.length < 2) throw new CsvError(`expected two columns: date${delim === '\t' ? ' (tab) ' : delim}value`, i + 1);
		const rawVal = cells[1]!.replace(/\s/g, '');
		let value: number | null = null;
		if (rawVal !== '' && !NO_READING.test(rawVal)) {
			value = readNumber(rawVal, decimal);
			if (!Number.isFinite(value)) throw new CsvError(`"${cells[1]}" is not a number`, i + 1);
			if (value < 0) {
				negativeGaps++;
				value = null;
			}
		}
		const minutes = parseTime(cells[0] ?? '');
		if (minutes !== null && Number.isNaN(minutes)) throw new CsvError(`"${cells[0]}" has a time that isn't HH:MM`, i + 1);
		if (minutes !== null) timed = true;
		if (opts.dayBoundary) {
			if (minutes === null) throw new CsvError(`"${cells[0]}" has no time: every row of a sub-daily file needs one (YYYY-MM-DD HH:MM)`, i + 1);
			const day = bookedDay(date, minutes, opts.dayBoundary);
			if (!byDay.has(day)) byDay.set(day, null);
			if (value !== null) {
				byDay.set(day, (byDay.get(day) ?? 0) + value);
				readingsOn.set(day, (readingsOn.get(day) ?? 0) + 1);
				readings++;
			}
			continue;
		}
		const day = toEpochDay(date);
		if (byDay.has(day)) {
			if (timed) throw new CsvError(`several readings on ${date}: this looks like sub-daily data; choose how to add it up into days`, i + 1, true);
			throw new CsvError(`duplicate date ${date}`, i + 1);
		}
		byDay.set(day, value);
	}
	const out: ParsedSeries = {
		...denseDays(byDay),
		dateOrder: order,
		dateOrderAssumed: assumed,
		...(negativeGaps ? { negativeGaps } : {})
	};
	if (opts.dayBoundary) {
		// The file's interval: the most common count of readings in a day (the larger on a tie).
		const tally = new Map<number, number>();
		for (const n of readingsOn.values()) tally.set(n, (tally.get(n) ?? 0) + 1);
		let perDay = 0;
		let seen = -1;
		for (const [n, c] of tally) if (c > seen || (c === seen && n > perDay)) [perDay, seen] = [n, c];
		const incompleteDays = [...readingsOn.values()].filter((n) => n < perDay).length;
		out.subDaily = { dayBoundary: opts.dayBoundary, readings, readingsPerDay: perDay, incompleteDays };
	}
	return out;
}
