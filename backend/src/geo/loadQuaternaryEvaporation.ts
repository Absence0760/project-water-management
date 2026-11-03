// Load WR2012's monthly evaporation per quaternary into quaternary_evaporation
// (310; docs/maps.md § Quaternary evaporation). The operator's tool, run as the
// schema owner (`pnpm import:quaternary-evaporation`, and in production the
// reference-load kind `quaternary-evaporation`); the app only reads the table.
//
// Input: the CSV `scripts/wbt-import/wrsm_evaporation.py` writes from WR2012's
// WRSM2000 network configurations, one row per quaternary:
//
//   code, span_oct … span_sep   12 monthly S-pan depths, mm (the runoff module's); all empty = none
//   apan_oct … apan_sep         12 monthly A-pan depths, mm (the irrigation module's); all empty = none
//   span_modules, span_agree    how many modules named it, how many gave the row kept (optional)
//   span_other_totals           the other modules' annual totals, space-separated (optional)
//   span_files                  the module files that gave the row kept, space-separated (optional)
//   apan_modules, apan_agree, apan_other_totals, apan_files   the same for A-pan
//
// Any other column (wma, the totals, evap_zone, …) is ignored. A row is
// refused, named, when its code isn't a quaternary code, it repeats one, a
// month of a row given is missing or outside 0–1000 mm, or it has neither
// row. Without the module counts a row given counts as one module, agreeing.
// A load replaces every row of its dataset, in one transaction.
import type pg from 'pg';
import { CODE } from './loadQuaternaries.js';
import { recordReferenceOrigin, type ReferenceOrigin } from './referenceOrigin.js';

/** The credit a production load stores on every row, shown with every proposal (docs/maps.md § Sources). */
export const QUATERNARY_EVAPORATION_SOURCE = 'WR2012 (WRC 2015), WRSM2000 network configurations, WMAs 16–19: monthly S-pan (runoff modules) and A-pan (irrigation modules).';

const MONTHS = ['oct', 'nov', 'dec', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
/** The deepest month a row takes, mm (the column's CHECK). */
export const EVAPORATION_MONTH_MAX_MM = 1000;
/** The most module files or other totals kept per row (the columns' CHECK). */
const LIST_MAX = 50;

export interface QuaternaryEvaporationRecord {
	code: string;
	spanMm: number[] | null;
	apanMm: number[] | null;
	spanModules: number;
	spanAgree: number;
	spanOthersMm: number[];
	spanFiles: string[];
	apanModules: number;
	apanAgree: number;
	apanOthersMm: number[];
	apanFiles: string[];
}

/** Split a CSV line, honouring double quotes (the extractor writes none, a spreadsheet's export may). */
function splitCsv(line: string): string[] {
	const out: string[] = [];
	let cur = '';
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!;
		if (quoted) {
			if (ch === '"' && line[i + 1] === '"') {
				cur += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else cur += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ',') {
			out.push(cur.trim());
			cur = '';
		} else cur += ch;
	}
	out.push(cur.trim());
	return out;
}

/** The records a CSV describes, with a problem per row refused. */
export function quaternaryEvaporationRecords(text: string): { records: QuaternaryEvaporationRecord[]; problems: string[] } {
	const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
	const records: QuaternaryEvaporationRecord[] = [];
	const problems: string[] = [];
	if (!lines.length) return { records, problems: ['the evaporation file is empty'] };
	const head = splitCsv(lines[0]!).map((h) => h.toLowerCase());
	const col = (name: string) => head.indexOf(name);
	const missing = ['code', ...MONTHS.map((m) => `span_${m}`), ...MONTHS.map((m) => `apan_${m}`)].filter((h) => col(h) < 0);
	if (missing.length) return { records, problems: [`the evaporation file has no ${missing.slice(0, 3).map((m) => `"${m}"`).join(', ')}${missing.length > 3 ? ` (and ${missing.length - 3} more)` : ''} column${missing.length === 1 ? '' : 's'}`] };
	const seen = new Set<string>();
	for (const [i, line] of lines.slice(1).entries()) {
		const cells = splitCsv(line);
		const cell = (name: string) => (col(name) >= 0 ? (cells[col(name)] ?? '') : '');
		const code = cell('code').toUpperCase();
		const at = `row ${i + 2}${CODE.test(code) ? ` (${code})` : ''}`;
		if (!CODE.test(code)) {
			problems.push(`${at}: "${cell('code')}" is not a quaternary code`);
			continue;
		}
		if (seen.has(code)) {
			problems.push(`${at}: ${code} appears twice; the second refused`);
			continue;
		}
		const row = (kind: 'span' | 'apan'): number[] | null | string => {
			const raw = MONTHS.map((m) => cell(`${kind}_${m}`));
			if (raw.every((v) => v === '')) return null;
			const values = raw.map((v) => (v === '' ? NaN : Number(v)));
			const bad = values.findIndex((v) => !Number.isFinite(v) || v < 0 || v >= EVAPORATION_MONTH_MAX_MM);
			if (bad >= 0) return `its ${kind === 'span' ? 'S-pan' : 'A-pan'} ${MONTHS[bad]} is ${raw[bad] === '' ? 'missing' : `"${raw[bad]}"`}, not a depth from 0 to ${EVAPORATION_MONTH_MAX_MM} mm`;
			return values;
		};
		const span = row('span');
		const apan = row('apan');
		const why = typeof span === 'string' ? span : typeof apan === 'string' ? apan : span === null && apan === null ? 'it has neither an S-pan nor an A-pan row' : null;
		if (why) {
			problems.push(`${at}: ${why}; refused`);
			continue;
		}
		const int = (name: string, fallback: number) => {
			const n = Number(cell(name));
			return cell(name) !== '' && Number.isInteger(n) && n >= 0 ? n : fallback;
		};
		const list = (name: string) => cell(name).split(/\s+/).filter(Boolean).slice(0, LIST_MAX);
		const totals = (name: string) => list(name).map(Number).filter((n) => Number.isFinite(n));
		const counts = (kind: 'span' | 'apan', present: boolean) => {
			if (!present) return { modules: 0, agree: 0 };
			const modules = Math.max(1, int(`${kind}_modules`, 1));
			return { modules, agree: Math.min(modules, Math.max(1, int(`${kind}_agree`, modules))) };
		};
		const s = counts('span', span !== null);
		const a = counts('apan', apan !== null);
		seen.add(code);
		records.push({
			code,
			spanMm: span as number[] | null,
			apanMm: apan as number[] | null,
			spanModules: s.modules,
			spanAgree: s.agree,
			spanOthersMm: span ? totals('span_other_totals') : [],
			spanFiles: span ? list('span_files') : [],
			apanModules: a.modules,
			apanAgree: a.agree,
			apanOthersMm: apan ? totals('apan_other_totals') : [],
			apanFiles: apan ? list('apan_files') : []
		});
	}
	return { records, problems };
}

/**
 * Replace every row of `dataset` with `records`, in one transaction, as the
 * schema owner, each with `source`, recording the bucket file a production
 * load read (`origin`; a local import names none). Returns the rows written.
 */
export async function replaceQuaternaryEvaporation(
	client: pg.ClientBase,
	dataset: string,
	records: readonly QuaternaryEvaporationRecord[],
	source: string,
	origin: ReferenceOrigin | null = null
): Promise<number> {
	await client.query('BEGIN');
	try {
		await client.query('DELETE FROM quaternary_evaporation WHERE dataset = $1', [dataset]);
		for (const r of records) {
			await client.query(
				`INSERT INTO quaternary_evaporation (dataset, code, span_mm, apan_mm, span_modules, span_agree, span_others_mm, span_files,
					apan_modules, apan_agree, apan_others_mm, apan_files, source)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
				[dataset, r.code, r.spanMm, r.apanMm, r.spanModules, r.spanAgree, r.spanOthersMm, r.spanFiles, r.apanModules, r.apanAgree, r.apanOthersMm, r.apanFiles, source]
			);
		}
		await recordReferenceOrigin(client, 'quaternary-evaporation', dataset, origin);
		await client.query('COMMIT');
		return records.length;
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	}
}
