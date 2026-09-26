// A DWS hydrology export in the manual series import (issue #45): the
// fixed-width daily table the DWS Hydrological Services site prints
// (HyData.aspx, saved as text or as the page), or plain whitespace-separated
// "YYYYMMDD value [quality]" rows.
//
// Rows are read by the same code as the automatic DWS feed
// (@water-management/engine/dws, parseDwsRow), so a missing-data quality code
// (170, 255 …), a blank value or a negative placeholder (-999) is a gap here
// exactly as it is there: never a value that gets imported and scored. What
// was dropped, and why, is returned for the upload summary.
import { toEpochDay } from '@water-management/engine';
import { DWS_HEADER, DWS_ROW, dwsColumns, dwsTableText, parseDwsRow, type DwsColumns, type DwsGap } from '@water-management/engine/dws';
import { CsvError, denseDays, type ParsedSeries } from './csv';

export interface DwsImport {
	/** Dated rows in the file. */
	rows: number;
	/** Rows by quality code, as the file gave them. */
	quality: Record<string, number>;
	/** Rows read as gaps, by why: a missing-data code, a blank or NA value, a negative placeholder. */
	gaps: Record<Exclude<DwsGap, 'text'>, number>;
	/** The missing-data quality codes met, with their rows. */
	gapCodes: Record<string, number>;
	/** The value column as the file's format block describes it ("Daily avg flow rate in cubic metres/sec"). */
	column?: string;
}

const NO_READING = /^(na|nan|null|-)$/i;
const VALUE_SPEC = /^\s*POS\.\s*10\s*-\s*18\s*=\s*/i;

/**
 * Whether a file is a DWS-style table rather than a CSV: it has a DATE … QUAL
 * header before any dated row, or its first line that starts with a digit is a YYYYMMDD date followed by whitespace, with no comma
 * or semicolon in it (20200105,5 or 20200105;1,5 is a CSV, read by csv.ts).
 */
export function isDwsExport(text: string): boolean {
	const body = dwsTableText(text) ?? text;
	for (const raw of body.split(/\r?\n/)) {
		const l = raw.trim();
		if (DWS_HEADER.test(l) && /\bQUAL\b/i.test(l)) return true;
		if (/^\d/.test(l)) return DWS_ROW.test(l) && !/[,;]/.test(l);
	}
	return false;
}

/** Read a DWS export (isDwsExport) into daily values. Every date is year-first, so no date order is assumed. */
export function parseDwsExport(text: string): ParsedSeries {
	const clean = text.replace(/^﻿/, '');
	const table = dwsTableText(clean);
	// Line numbers are the file's only when the table is the file (not a saved page's <pre>).
	const plain = table === null || table === clean;
	const lines = (table ?? clean).split(/\r?\n/).map((l) => l.trimEnd());
	const lineNo = (i: number) => (plain ? i + 1 : undefined);
	const firstRow = lines.findIndex((l) => DWS_ROW.test(l.trim()));
	const h = lines.findIndex((l) => DWS_HEADER.test(l));
	let cols: DwsColumns | null = null;
	let column: string | undefined;
	if (h !== -1 && (firstRow === -1 || h < firstRow)) {
		if (/\bTIME\b/i.test(lines[h]!)) {
			throw new CsvError('this DWS export has a TIME column, so it holds readings through the day; export the daily data instead', lineNo(h));
		}
		cols = dwsColumns(lines[h]!);
		column = lines
			.slice(0, h)
			.find((l) => VALUE_SPEC.test(l))
			?.replace(VALUE_SPEC, '')
			.trim();
	}
	const byDay = new Map<number, number | null>();
	const info: DwsImport = { rows: 0, quality: {}, gaps: { code: 0, blank: 0, negative: 0 }, gapCodes: {} };
	for (let i = 0; i < lines.length; i++) {
		if (!DWS_ROW.test(lines[i]!.trim())) continue;
		const row = parseDwsRow(lines[i]!, cols);
		if (row.iso === null) throw new CsvError(`"${row.date}" is not a date (a DWS date is YYYYMMDD)`, lineNo(i));
		let gap = row.gap;
		if (gap === 'text') {
			if (!NO_READING.test(row.rawValue ?? '')) throw new CsvError(`"${row.rawValue}" on ${row.iso} is not a number`, lineNo(i));
			gap = 'blank';
		}
		const day = toEpochDay(row.iso);
		if (byDay.has(day)) throw new CsvError(`duplicate date ${row.iso}`, lineNo(i));
		byDay.set(day, row.value);
		info.rows++;
		if (row.quality) info.quality[row.quality] = (info.quality[row.quality] ?? 0) + 1;
		if (gap !== null) info.gaps[gap]++;
		if (gap === 'code') info.gapCodes[row.quality!] = (info.gapCodes[row.quality!] ?? 0) + 1;
	}
	if (byDay.size === 0 && /no data for this period/i.test(clean)) throw new CsvError('the DWS export says "No data for this period": it holds no days');
	if (column) info.column = column;
	return { ...denseDays(byDay), dateOrder: 'iso', dateOrderAssumed: false, dws: info };
}
