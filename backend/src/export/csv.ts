// Pure helpers for the CSV / JSON download endpoints (export/routes.ts).
// No I/O: everything here is unit-tested in csv.test.ts.
import { fromEpochDay, toEpochDay } from '@water-management/engine';

/**
 * Largest export body we build. Lambda's buffered (non-streaming) responses
 * are capped at 6 MB, and the API runs behind `hono/aws-lambda`'s buffered
 * `handle`, so anything bigger would fail in production with an opaque 502.
 * 5 MB leaves headroom for headers. One node over a 45-year daily record
 * (16 437 days × 13 series) is under 2 MB, so real catchments fit; the cap only bites on very
 * long records or many user series, and the 413 tells the caller how to
 * narrow the request (`from` / `to`). See docs/api.md § Export.
 */
export const MAX_EXPORT_BYTES = 5 * 1024 * 1024;

/** UTF-8 byte-order mark: without it Excel reads the file as ANSI and mangles "m³". */
export const BOM = '\uFEFF';

/** RFC 4180 line terminator. */
export const EOL = '\r\n';

/**
 * Leading comment line on every CSV exported from a legacy-runoff-model run
 * (audit H1, operator decision 2026-09-24): the model doesn't conserve water
 * at the event scale, so results are a workbook comparison, not evidence.
 * A leading "#" line is either skipped or read as one harmless extra cell by
 * spreadsheet and CSV tooling; either way the header row a parser expects as
 * row 1 still follows right after it.
 */
export const LEGACY_RUN_CSV_COMMENT = '# runoff_model=legacy; workbook comparison only; not evidence (audit H1)';

/** Prepend LEGACY_RUN_CSV_COMMENT ahead of `lines` when `legacy` is true; otherwise pass them through unchanged. */
export function* withLegacyComment(legacy: boolean, lines: Iterable<string>): Generator<string> {
	if (legacy) yield LEGACY_RUN_CSV_COMMENT;
	yield* lines;
}

/** A number cell: empty for null / NaN / ±Infinity (missing days). */
export function numCell(v: number | null | undefined): string {
	return typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

/**
 * A text cell, RFC 4180-quoted when it contains a comma, quote or line break.
 * Text that a spreadsheet would treat as a formula (leading = + - @ tab CR) is
 * prefixed with an apostrophe (OWASP "CSV injection"): names and labels are
 * user-controlled, and the file is opened by other members of the project.
 */
export function textCell(v: string): string {
	const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One CSV record (no terminator). Strings are text cells, numbers/null are number cells. */
export function csvRow(cells: readonly (string | number | null | undefined)[]): string {
	return cells.map((c) => (typeof c === 'string' ? textCell(c) : numCell(c))).join(',');
}

/** Column header for a series: "label (unit)", or just the label when unitless. */
export function seriesHeader(label: string, unit: string | null | undefined): string {
	return unit ? `${label} (${unit})` : label;
}

export interface DailyColumn {
	header: string;
	values: readonly (number | null)[];
}

/**
 * Lines of a daily table: `date` + one column per series, one row per day from
 * `startDate + offset` for `days` rows (values index = offset + row). Missing
 * values are empty cells. A generator so a caller can stop early (size cap) or
 * stream it.
 */
export function* dailyCsvLines(
	startDate: string,
	columns: readonly DailyColumn[],
	range: { offset: number; days: number }
): Generator<string> {
	yield csvRow(['date', ...columns.map((c) => c.header)]);
	const day0 = toEpochDay(startDate);
	for (let r = 0; r < range.days; r++) {
		const i = range.offset + r;
		yield [fromEpochDay(day0 + i), ...columns.map((c) => numCell(c.values[i]))].join(',');
	}
}

/**
 * Join lines into a CSV body (BOM + CRLF), stopping as soon as it would exceed
 * `maxBytes`. Returns null when it doesn't fit.
 */
export function collectCsv(lines: Iterable<string>, maxBytes = MAX_EXPORT_BYTES): string | null {
	const parts: string[] = [BOM];
	let bytes = 3; // the BOM is 3 bytes in UTF-8
	for (const line of lines) {
		bytes += Buffer.byteLength(line, 'utf8') + EOL.length;
		if (bytes > maxBytes) return null;
		parts.push(line, EOL);
	}
	return parts.join('');
}

/** ASCII file-name slug: "Client Catchment (v2)" → "client-catchment-v2". Never empty. */
export function slugify(s: string, fallback = 'export'): string {
	const slug = s
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60)
		.replace(/-+$/, '');
	return slug || fallback;
}

/** `<project>_<part>_…_<YYYY-MM-DD>.<ext>`, date in UTC so it doesn't depend on the server's TZ. */
export function exportFilename(projectName: string, parts: string[], ext: 'csv' | 'json', now = new Date()): string {
	const date = now.toISOString().slice(0, 10);
	return [slugify(projectName, 'project'), ...parts.map((p) => slugify(p)), date].join('_') + `.${ext}`;
}

/** `Content-Disposition: attachment` for an ASCII slug file name (see exportFilename). */
export function attachment(filename: string): string {
	const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_');
	return `attachment; filename="${safe}"`;
}

/**
 * Resolve an optional `from`/`to` (ISO, inclusive) window against a daily
 * series of `length` days from `startDate`. The window is clamped to the
 * series; null when it doesn't overlap it at all.
 */
export function dayRange(
	startDate: string,
	length: number,
	from?: string,
	to?: string
): { offset: number; days: number } | null {
	const day0 = toEpochDay(startDate);
	const lo = Math.max(0, from ? toEpochDay(from) - day0 : 0);
	const hi = Math.min(length - 1, to ? toEpochDay(to) - day0 : length - 1);
	if (hi < lo) return null;
	return { offset: lo, days: hi - lo + 1 };
}
