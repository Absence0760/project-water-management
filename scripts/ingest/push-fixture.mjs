#!/usr/bin/env node
// Push a synthetic logger CSV to the ingest endpoint with a per-project API
// key (roadmap WP-2.9, docs/api.md § Ingest, docs/run-locally.md § Ingest):
// the local stand-in for a logger gateway. No network beyond the local API.
//
//   pnpm dev:ingest:push [--file <csv>] [--kind <kind>] [--name <name>] [--unit <unit>] [--keep-dates]
//
// The key comes from WM_INGEST_KEY: the environment, or a gitignored
// `.env.development.local` at the repo root (make the key in the app:
// Settings → API keys; nothing sensitive is committed). WM_API_URL picks the
// API (default http://localhost:3001). The CSV is `date,value` rows (a header
// row is skipped, an empty value is "no reading"). By default the days are
// re-dated so the last one is yesterday (UTC), so the pushed data looks
// fresh; --keep-dates sends them as written.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const DAY = 86_400_000;
const toDay = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
const fromDay = (d) => new Date(d * DAY).toISOString().slice(0, 10);

/** `date,value` rows as one contiguous run of days from the first; gaps and blanks are null. */
export function parseCsv(text) {
	const days = new Map();
	for (const [i, raw] of text.split(/\r?\n/).entries()) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const [date, value = ''] = line.split(',').map((s) => s.trim());
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
			if (i === 0) continue; // a header row
			throw new Error(`line ${i + 1}: "${date}" is not a YYYY-MM-DD date`);
		}
		const v = value === '' ? null : Number(value);
		if (v !== null && !Number.isFinite(v)) throw new Error(`line ${i + 1}: "${value}" is not a number`);
		days.set(toDay(date), v);
	}
	if (days.size === 0) throw new Error('the CSV has no rows');
	const first = Math.min(...days.keys());
	const last = Math.max(...days.keys());
	const values = Array.from({ length: last - first + 1 }, (_, k) => days.get(first + k) ?? null);
	return { startDate: fromDay(first), values };
}

/** The same run of days, moved so its last day is `lastDay` (YYYY-MM-DD). */
export function redate(series, lastDay) {
	return { ...series, startDate: fromDay(toDay(lastDay) - series.values.length + 1) };
}

/** WM_INGEST_KEY / WM_API_URL from the environment, else from a KEY=value file. */
export function readEnv(env, file) {
	const out = { key: env.WM_INGEST_KEY ?? '', api: env.WM_API_URL ?? '' };
	if ((!out.key || !out.api) && file && existsSync(file)) {
		for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
			const m = /^\s*(WM_INGEST_KEY|WM_API_URL)\s*=\s*"?([^"\s]*)"?\s*$/.exec(line);
			if (!m) continue;
			if (m[1] === 'WM_INGEST_KEY' && !out.key) out.key = m[2];
			if (m[1] === 'WM_API_URL' && !out.api) out.api = m[2];
		}
	}
	return { key: out.key, api: (out.api || 'http://localhost:3001').replace(/\/+$/, '') };
}

function args(argv) {
	const o = { file: join(here, 'fixture.csv'), kind: 'flow_logger_m3s', name: 'Logger', unit: 'm3/s', keepDates: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--keep-dates') o.keepDates = true;
		else if (['--file', '--kind', '--name', '--unit'].includes(a) && argv[i + 1] !== undefined) o[a.slice(2)] = argv[++i];
		else throw new Error(`unknown argument ${a}`);
	}
	return o;
}

async function main() {
	const o = args(process.argv.slice(2));
	const { key, api } = readEnv(process.env, join(root, '.env.development.local'));
	if (!key) {
		console.error('No key: set WM_INGEST_KEY (make one in the app under Settings → API keys) in the environment or in .env.development.local.');
		process.exit(2);
	}
	let series = parseCsv(readFileSync(o.file, 'utf8'));
	if (!o.keepDates) series = redate(series, fromDay(Math.floor(Date.now() / DAY) - 1));
	const res = await fetch(`${api}/ingest/v1/series/merge`, {
		method: 'POST',
		headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
		body: JSON.stringify({ kind: o.kind, name: o.name, unit: o.unit, ...series, source: 'push-fixture' })
	});
	const body = await res.json().catch(() => null);
	if (!res.ok) {
		console.error(`ingest answered ${res.status}: ${body?.error ?? 'no body'}`);
		process.exit(1);
	}
	console.log(`pushed ${series.values.length} days from ${series.startDate} into ${o.kind} “${o.name}”: ${body.daysChanged} changed`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	});
}
