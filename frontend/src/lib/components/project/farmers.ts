// View helpers for FarmersPanel and InviteFarmersDialog (WP-2.1, WP-2.2):
// which farms a farmer is linked to, by name, the checkbox list's selection,
// the bulk invite CSV and its outcomes. Kept free of Svelte so they can be
// unit-tested.
import { LANGUAGES } from '@water-management/engine/languages';
import type { BulkFarmerResult, BulkFarmerRow, FarmerEntry } from '$lib/api/types';

export interface FarmOption {
	id: string;
	name: string;
}

/**
 * The names of a farmer's farms, in the order the farms are listed. A link to
 * a node the model no longer has as a farm (deleted, not saved yet) shows as
 * "a removed farm" rather than disappearing, so the count still adds up.
 */
export function farmNames(farmer: Pick<FarmerEntry, 'nodeIds'>, farms: readonly FarmOption[]): string[] {
	const linked = new Set(farmer.nodeIds);
	const names = farms.filter((f) => linked.has(f.id)).map((f) => f.name);
	const missing = farmer.nodeIds.filter((id) => !farms.some((f) => f.id === id)).length;
	return missing ? [...names, missing === 1 ? 'a removed hydrological unit' : `${missing} removed hydrological units`] : names;
}

/** Add or remove `id`, keeping the farms' order. */
export function toggleFarm(selected: readonly string[], id: string, farms: readonly FarmOption[]): string[] {
	const next = new Set(selected);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	return farms.filter((f) => next.has(f.id)).map((f) => f.id);
}

/** Rows per bulk request (the server's cap, POST /farmers/bulk). */
export const BULK_MAX_ROWS = 200;

/** A parsed CSV line: the row to send, and the line it came from (1-based, for the preview). */
export interface CsvFarmerRow extends BulkFarmerRow {
	line: number;
}

export interface ParsedFarmerCsv {
	rows: CsvFarmerRow[];
	/** Problems with the file as a whole (the rows themselves are checked by the server). */
	problems: string[];
}

/** One line's fields: comma-, semicolon- or tab-separated, with "quoted, fields" and "" for a quote. */
function splitLine(line: string, sep: string): string[] {
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
		} else if (ch === '"' && cur.trim() === '') {
			quoted = true;
			cur = '';
		} else if (ch === sep) {
			out.push(cur.trim());
			cur = '';
		} else cur += ch;
	}
	out.push(cur.trim());
	return out;
}

const HEADERS: Record<string, keyof BulkFarmerRow> = {
	email: 'email',
	'e-mail': 'email',
	'email address': 'email',
	farm: 'farm',
	'farm name': 'farm',
	language: 'locale',
	locale: 'locale',
	lang: 'locale'
};

/**
 * The Invite farmers dialog's CSV (`email,farm,language`, one farm per row),
 * pasted or uploaded, with or without a header row. A header may put the
 * columns in any order; without one they are taken as email, farm,
 * language. Blank lines are skipped. The rows go to the server as they are:
 * whether an address is valid or a farm exists is its call, row by row.
 */
export function parseFarmerCsv(text: string): ParsedFarmerCsv {
	const lines = text
		.replace(/^﻿/, '')
		.split(/\r\n|\r|\n/)
		.map((l, i) => ({ text: l, line: i + 1 }))
		.filter((l) => l.text.trim() !== '');
	if (!lines.length) return { rows: [], problems: ['Paste or upload at least one row: email,farm,language.'] };
	const first = lines[0]!.text;
	const sep = first.includes('\t') ? '\t' : first.includes(';') && !first.includes(',') ? ';' : ',';
	let order: (keyof BulkFarmerRow | null)[] = ['email', 'farm', 'locale'];
	const head = splitLine(first, sep).map((c) => HEADERS[c.toLowerCase()] ?? null);
	if (head.includes('email') && head.includes('farm')) {
		order = head;
		lines.shift();
	}
	const rows = lines.map(({ text: l, line }) => {
		const cells = splitLine(l, sep);
		const row: CsvFarmerRow = { line, email: '', farm: '' };
		order.forEach((key, i) => {
			if (key && cells[i] !== undefined) row[key] = cells[i]!;
		});
		if (!row.locale) delete row.locale;
		return row;
	});
	const problems: string[] = [];
	if (!rows.length) problems.push('The file has a header row but no farmers under it.');
	if (rows.length > BULK_MAX_ROWS) problems.push(`At most ${BULK_MAX_ROWS} rows at a time; this has ${rows.length}. Split it into several files.`);
	return { rows, problems };
}

/** A CSV cell, quoted when it holds a comma, a quote or a line break (parseFarmerCsv reads it back). */
const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * The invite CSV's example file (the dialog's "Expected format", issue #456):
 * a header and a row for each of the project's first two hydrological units,
 * an invented address and a language code each (else one row with a
 * placeholder name), so it reads back as it is (parseFarmerCsv) and every
 * farm in it is one the project has.
 */
export function inviteExampleCsv(farms: readonly Pick<FarmOption, 'name'>[]): string {
	const names = farms
		.map((f) => f.name.trim())
		.filter(Boolean)
		.slice(0, 2);
	const rows = (names.length ? names : ['Hydrological unit name']).map((n, i) => `farmer${i + 1}@example.com,${csvCell(n)},${LANGUAGES[i % LANGUAGES.length]!.code}`);
	return ['email,farm,language', ...rows, ''].join('\r\n');
}

/** "3 added, 12 invited, 2 with errors" (only the parts that aren't zero). */
export function bulkSummary(results: readonly Pick<BulkFarmerResult, 'status'>[], dryRun: boolean): string {
	const count = (s: BulkFarmerResult['status']) => results.filter((r) => r.status === s).length;
	const errors = count('error');
	const parts = [
		count('added') ? `${count('added')} ${dryRun ? 'to add' : 'added'}` : '',
		count('invited') ? `${count('invited')} ${dryRun ? 'to invite' : 'invited'}` : '',
		errors ? `${errors} with ${errors === 1 ? 'an error' : 'errors'}` : ''
	].filter(Boolean);
	return parts.join(', ') || 'No rows';
}

/** The preview or result table's outcome for one row. */
export function outcomeText(r: Pick<BulkFarmerResult, 'status' | 'error'>, dryRun: boolean): string {
	if (r.status === 'error') return r.error ?? 'Error';
	if (r.status === 'added') return dryRun ? 'Will be added (has an account)' : 'Added';
	return dryRun ? 'Will be invited by email' : 'Invited';
}
