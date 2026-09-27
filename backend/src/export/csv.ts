// Pure helpers for the CSV / JSON download endpoints (export/routes.ts).
// No I/O: everything here is unit-tested in csv.test.ts.
import { fromEpochDay, toEpochDay } from '@water-management/engine';
import { localDate } from '../projects/timeZone.js';

/**
 * Largest export body we build. Lambda's buffered (non-streaming) responses
 * are capped at 6 MB, and the API runs behind `hono/aws-lambda`'s buffered
 * `handle`, so anything bigger would fail in production with an opaque 502.
 * 5 MB leaves headroom for headers. The catchment table fits real records,
 * but a farm's daily CSV (~32 full-precision columns, ≈ 150 KB a year) passes
 * the cap beyond about 30 years, and the 413 tells the caller how to narrow
 * the request (`from` / `to`). The bulk series route pages under it instead
 * (runs/bulk.ts); WP-1.29 (streaming) lifts it. See docs/api.md § Export.
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

/**
 * A value in a `#` provenance line (runProvenanceComment), percent-encoded so
 * the line stays one harmless comment whatever a user typed: `%` itself, the
 * line's own separators (`;` `=`), the CSV metacharacters (`,` `"`) and every
 * control character (tab, CR, LF, NEL, the Unicode line separators) become
 * their UTF-8 `%XX` (decodeURIComponent reads it back). With no comma, quote or line break left, a CSV reader that doesn't
 * skip comments sees the whole line as one cell starting with `#`, which no
 * spreadsheet evaluates, so a label like `=HYPERLINK(…)` or `+1` stays text
 * (OWASP "CSV injection"); a reader splitting on `;` (Excel in a comma-decimal
 * locale) gets cells that start with a space and a key, never with `= + - @`.
 */
export function provenanceValue(v: string): string {
	return v.replace(/[%;=,"\x00-\x1f\x7f-\x9f\u2028\u2029]/g, encodeURIComponent);
}

/** What made a daily CSV: the run it came from, for its leading `#` line. */
export interface RunProvenance {
	label: string;
	engineVersion: string;
	runoffModel: string;
	/** ISO timestamp. */
	createdAt: string;
	startDate: string;
	endDate: string;
	/**
	 * A farm's file only: the farm's dam capacity (m³) as the run's stored model had it; null when the
	 * run didn't store one. Undefined leaves the key out (catchment, gauge and all-farms files).
	 */
	damCapacityM3?: number | null;
}

/**
 * The leading provenance line of every daily CSV (farm, node, catchment and
 * all-farms files): which run, engine and runoff model made it, when, and over
 * what period, so the file still says where it came from once it is renamed or
 * pasted into a workbook (the file name alone carries the run). Same shape as
 * LEGACY_RUN_CSV_COMMENT; values go through provenanceValue.
 */
export function runProvenanceComment(p: RunProvenance): string {
	const pairs: [string, string][] = [
		['run', p.label],
		['engine', p.engineVersion],
		['runoff_model', p.runoffModel],
		['created', p.createdAt],
		['period', `${p.startDate}..${p.endDate}`]
	];
	if (p.damCapacityM3 !== undefined) pairs.push(['dam_capacity_m3', numCell(p.damCapacityM3)]);
	return `# ${pairs.map(([k, v]) => `${k}=${provenanceValue(v)}`).join('; ')}`;
}

/**
 * A daily CSV's leading `#` lines: the legacy-run warning first when the run is
 * legacy (so row 1 still says so, as on summary.csv), then the provenance line,
 * then `lines` (the header row and the days).
 */
export function* withRunComments(legacy: boolean, provenance: RunProvenance, lines: Iterable<string>): Generator<string> {
	yield* withLegacyComment(legacy, [runProvenanceComment(provenance)]);
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
	/** A text column instead (the forecast flag): the cell of day `index`; `values` is then ignored. */
	text?: (index: number) => string;
}

/**
 * The daily exports' forecast flag (WP-2.12): `F` on a forecast run's days
 * from summary.forecast.from (the workbook's "F" rows), empty before. null
 * for an ordinary run, which has no forecast days.
 */
export function forecastColumn(startDate: string, forecast: { from: string } | undefined): DailyColumn | null {
	if (!forecast) return null;
	const cut = toEpochDay(forecast.from) - toEpochDay(startDate);
	return { header: 'forecast (F = modelled on forecast rain)', values: [], text: (i) => (i >= cut ? 'F' : '') };
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
		yield [fromEpochDay(day0 + i), ...columns.map((c) => (c.text ? textCell(c.text(i)) : numCell(c.values[i])))].join(',');
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

/**
 * `<project>_<part>_…_<YYYY-MM-DD>.<ext>`, dated by the calendar day in the
 * project's time zone (058_project_time_zone.sql), never UTC's or the
 * server's: a South African export at 00:30 SAST is named for that day, not
 * the one before (issue #45).
 */
export function exportFilename(projectName: string, parts: string[], ext: 'csv' | 'json', timeZone: string, now = new Date()): string {
	const date = localDate(now, timeZone);
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
