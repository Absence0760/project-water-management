// Rows of date and value pasted into the series form (issue #477 (b)): the
// same reader as a file (./file.ts: a DWS export or a date,value CSV), so the
// Expected format note, the date and decimal rules and the overwrite preview
// are the upload's own. A block copied from a spreadsheet arrives
// tab-separated, which the CSV reader takes as it is.
import type { DayBoundary } from '@water-management/engine';
import { CsvError, type ParsedSeries } from './csv';
import { parseSeriesFile } from './file';

/** The most text the box reads: 60 000 rows of a date and a value, with room for a header and long numbers. */
export const MAX_PASTE_CHARS = 4_000_000;

/** What was pasted, read as a series; a CsvError says why not (an empty box too). */
export function parsePastedSeries(text: string, opts: { dayBoundary?: DayBoundary } = {}): ParsedSeries {
	if (text.length > MAX_PASTE_CHARS) throw new CsvError('that is more than the box takes; upload it as a file instead');
	if (!text.trim()) throw new CsvError('paste rows of a date and a value, one day a row');
	return parseSeriesFile(text, opts);
}
