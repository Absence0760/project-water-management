// The manual series import's entry point: a DWS hydrology export (fixed-width
// YYYYMMDD rows, ./dws.ts) or a date,value CSV (./csv.ts), told apart by the
// first dated row.
import type { DayBoundary } from '@water-management/engine';
import { parseSeriesCsv, type ParsedSeries } from './csv';
import { isDwsExport, parseDwsExport } from './dws';

/** A DWS export is daily, so `dayBoundary` applies to a CSV only. */
export function parseSeriesFile(text: string, opts: { dayBoundary?: DayBoundary } = {}): ParsedSeries {
	return isDwsExport(text) ? parseDwsExport(text) : parseSeriesCsv(text, opts);
}
