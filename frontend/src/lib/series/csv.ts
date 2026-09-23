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
}

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

/** Accepts YYYY-MM-DD, YYYY/MM/DD and DD/MM/YYYY (South African order). Optional time part ignored. */
export function parseDate(raw: string): string | null {
	const s = raw.trim().replace(/^"|"$/g, '').split(/[ T]/)[0] ?? '';
	let y: number, m: number, d: number;
	let match = ISO.exec(s) ?? SLASH_YMD.exec(s);
	if (match) {
		[y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
	} else if ((match = DMY.exec(s))) {
		[d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
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

export function parseSeriesCsv(text: string): ParsedSeries {
	const lines = text.replace(/^﻿/, '').split(/\r?\n/);
	const byDay = new Map<number, number | null>();
	let first = true;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.trim();
		if (!line || line.startsWith('#')) continue;
		const cells = splitRow(line);
		const date = parseDate(cells[0] ?? '');
		if (!date) {
			if (first) {
				first = false; // header row
				continue;
			}
			throw new CsvError(`"${cells[0]}" is not a date (use YYYY-MM-DD)`, i + 1);
		}
		first = false;
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
		missingCount: length - rowCount
	};
}
