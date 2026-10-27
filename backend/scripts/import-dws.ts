// Load a DWS daily flow table into the gauge record store (issue #604 R3-B,
// design D14; 247_gauge_record.sql, docs/deployment.md § DWS gauge records):
//
//   pnpm import:dws <file> --reference "<DWS's reply reference>" [--station A2H012]
//                          [--source dws-request|upload] [--from YYYY-MM-DD --to YYYY-MM-DD] [--origin dws|fixtures]
//
// The primary route for a station's history is a written data request to DWS
// (National Hydrological Services, GeoRequests@dws.gov.za): this loads its
// reply with source dws-request (the default), which a feed reading the store
// prefers to the weekly web pass for every day both hold. `--source upload`
// loads any other DWS daily table (a page saved by hand), which ranks last.
//
// The file is read by the feed's own reader (backend/src/feeds/sources/dws.ts
// parseDwsRows, on the engine's row reader shared with the manual series
// import): DWS's fixed-width daily table, as a saved HyData.aspx page (the
// table in its <pre>) or as the plain text, gzipped or not, with the same
// checks (the DATE … QUAL header, the flow in m³/s, real dates, each day
// once). The station comes from --station, else the one river gauge code the
// text before the table names, else the file name.
//
// The span recorded as covered is the reply's first to last listed day, or
// --from/--to when the request asked for more (days DWS didn't list are
// then "no data", not "not loaded yet"). A load replaces this source's rows
// over the span; other sources' rows stay. Long spans go in calls of at most
// 20 years (the function's cap).
//
// Runs as the schema owner (MIGRATION_DATABASE_URL), like the other import:*
// scripts: gauge_record_write is closed to the app's role. The origin follows
// FEED_SOURCE (dws when live, fixtures for the local stack, whose feeds read
// fixtures rows) unless --origin says. Paths resolve from the directory the
// command was typed in. A reply is the client's to keep: never commit one
// (the repo ships only backend/fixtures/dws/, invented).
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import pg from 'pg';
import { loadDevEnv } from '../src/config/devEnv.js';
import { DWS_RIVER_GAUGE } from '../src/feeds/config.js';
import { type DwsRowDay, parseDwsRows } from '../src/feeds/sources/dws.js';

/** The committed synthetic reply (station X0H001, invented values). */
export const SYNTHETIC_DWS_REPLY = fileURLToPath(new URL('../fixtures/dws/X0H001-reply.synthetic.txt', import.meta.url));

/** Days one call of gauge_record_write may span (its cap is 7330: DWS's 20 years a request). */
export const CHUNK_DAYS = 7000;

export const SOURCES = ['dws-request', 'upload'] as const;
export const USAGE =
	'usage: pnpm import:dws <file> --reference "<DWS’s reply reference>" [--station A2H012] [--source dws-request|upload] [--from YYYY-MM-DD --to YYYY-MM-DD] [--origin dws|fixtures]';

export interface Args {
	file: string;
	reference: string | null;
	station: string | null;
	source: (typeof SOURCES)[number];
	from: string | null;
	to: string | null;
	origin: 'dws' | 'fixtures';
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (s: string) => {
	try {
		return ISO.test(s) && fromEpochDay(toEpochDay(s)) === s;
	} catch {
		return false;
	}
};
const cliPath = (p: string, env: NodeJS.ProcessEnv = process.env): string => resolve(env.INIT_CWD ?? process.cwd(), p);

/** The arguments, or why they can't be taken. */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Args | string {
	const flags = new Map<string, string>();
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (!a.startsWith('--')) {
			positional.push(a);
			continue;
		}
		const v = argv[i + 1];
		if (v === undefined || v.startsWith('--')) return `${a} needs a value`;
		if (!['--reference', '--station', '--source', '--from', '--to', '--origin'].includes(a)) return `unknown option ${a}`;
		flags.set(a, v);
		i++;
	}
	if (positional.length !== 1) return 'give one file';
	const source = (flags.get('--source') ?? 'dws-request') as Args['source'];
	if (!SOURCES.includes(source)) return `--source is ${SOURCES.join(' or ')}`;
	const reference = flags.get('--reference')?.trim() || null;
	if (source === 'dws-request' && !reference) return 'a DWS reply is loaded with its reference: --reference "<the reply’s reference or date>"';
	if (reference && reference.length > 200) return 'the reference is at most 200 characters';
	const station = flags.get('--station') ?? null;
	if (station !== null && !DWS_RIVER_GAUGE.test(station)) return `${station} is not a DWS river gauge code (an H code, e.g. A2H012)`;
	const from = flags.get('--from') ?? null;
	const to = flags.get('--to') ?? null;
	if ((from === null) !== (to === null)) return 'give --from and --to together';
	if (from !== null && (!isDay(from) || !isDay(to!) || from > to!)) return '--from and --to are dates (YYYY-MM-DD), --from first';
	const origin = flags.get('--origin') ?? (env.FEED_SOURCE?.trim() === 'live' ? 'dws' : 'fixtures');
	if (origin !== 'dws' && origin !== 'fixtures') return '--origin is dws or fixtures';
	return { file: cliPath(positional[0]!, env), reference, station, source, from, to, origin };
}

const STATION_IN_TEXT = /\b([A-Z]\d[A-Z]\d{3})(?:100\.00)?\b/g;

/** The station: given, else the one river gauge the text before the table names, else the file name's. */
export function stationOf(text: string, file: string, given: string | null): string {
	if (given) return given;
	const head = text.split(/\r?\n/).findIndex((l) => /^\s*DATE(\s|$)/i.test(l));
	const before = head === -1 ? text : text.split(/\r?\n/).slice(0, head).join('\n');
	const named = new Set([...before.matchAll(STATION_IN_TEXT)].map((m) => m[1]!).filter((s) => DWS_RIVER_GAUGE.test(s)));
	if (named.size === 1) return [...named][0]!;
	const fromName = [...basename(file).matchAll(STATION_IN_TEXT)].map((m) => m[1]!).filter((s) => DWS_RIVER_GAUGE.test(s));
	if (named.size === 0 && fromName.length === 1) return fromName[0]!;
	throw new Error(`the file names ${named.size ? 'several stations' : 'no station'}: give it with --station`);
}

export interface Plan {
	station: string;
	rows: DwsRowDay[];
	/** Each call's span (≤ CHUNK_DAYS days) and its rows. */
	chunks: { from: string; to: string; rows: DwsRowDay[] }[];
	gaps: number;
}

/** What a file loads: its station, its rows (read by the feed's reader) and the calls that write them. */
export function planImport(text: string, args: Args): Plan {
	const station = stationOf(text, args.file, args.station);
	const parsed = parseDwsRows(text, args.from ? { start: args.from, end: args.to! } : undefined);
	if (!parsed.rows.length) throw new Error('the file lists no days');
	if (parsed.outside) throw new Error(`${parsed.outside} row(s) fall outside --from/--to`);
	const from = args.from ?? parsed.rows[0]!.day;
	const to = args.to ?? parsed.rows.at(-1)!.day;
	const chunks: Plan['chunks'] = [];
	for (let a = toEpochDay(from); a <= toEpochDay(to); a += CHUNK_DAYS) {
		const lo = fromEpochDay(a);
		const hi = fromEpochDay(Math.min(a + CHUNK_DAYS - 1, toEpochDay(to)));
		chunks.push({ from: lo, to: hi, rows: parsed.rows.filter((r) => r.day >= lo && r.day <= hi) });
	}
	return { station, rows: parsed.rows, chunks, gaps: parsed.rejected };
}

/** Read the file (gzipped or not) as text. */
export function readText(file: string): string {
	const bytes = readFileSync(file);
	return (file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8');
}

/** Load `args` into the database at `url` (as the schema owner), in one transaction. Returns the plan and the rows written. */
export async function importDws(url: string, args: Args, now = new Date()): Promise<Plan & { written: number }> {
	const plan = planImport(readText(args.file), args);
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		await client.query('BEGIN');
		let written = 0;
		for (const c of plan.chunks) {
			const r = await client.query<{ written: number }>(
				'SELECT written FROM gauge_record_write($1, $2, $3, $4, $5, $6::date[], $7::double precision[], $8::text[], $9, $10)',
				[args.origin, plan.station, args.source, c.from, c.to, c.rows.map((x) => x.day), c.rows.map((x) => x.value), c.rows.map((x) => x.quality), now.toISOString(), args.reference]
			);
			written += r.rows[0]!.written;
		}
		await client.query('COMMIT');
		return { ...plan, written };
	} catch (err) {
		await client.query('ROLLBACK').catch(() => {});
		throw err;
	} finally {
		await client.end();
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	loadDevEnv();
	const url = process.env.MIGRATION_DATABASE_URL;
	const args = parseArgs(process.argv.slice(2));
	if (!url) {
		console.error('MIGRATION_DATABASE_URL is not set');
		process.exit(1);
	}
	if (typeof args === 'string') {
		console.error(`${args}\n${USAGE}`);
		process.exit(2);
	}
	importDws(url, args)
		.then((got) => {
			const span = `${got.chunks[0]!.from} to ${got.chunks.at(-1)!.to}`;
			console.log(`${got.written} day(s) of ${got.station} loaded as ${args.source} (${args.origin}), ${got.gaps} of them gaps, covering ${span}`);
		})
		.catch((err) => {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		});
}
