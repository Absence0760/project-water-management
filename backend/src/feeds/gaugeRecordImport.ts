// A DWS daily flow table loaded into the gauge record store by the operator
// (247_gauge_record.sql, issue #604 R3-B; docs/deployment.md § DWS gauge
// records): which station it is, the rows it lists and the
// gauge_record_write calls that store them. Shared by the two ways in:
//   * `pnpm import:dws` (backend/scripts/import-dws.ts), locally, as the
//     schema owner;
//   * production's reference load, kind `dws` (geo/referenceLoad.ts), in the
//     migrate Lambda as the schema owner, from a file the operator uploaded
//     to the reference bucket (load-reference.yml).
// No I/O but the client handed in, and nothing that pulls in dotenv: the
// migrate Lambda bundles this.
//
// The rows are read by the feed's own reader (sources/dws.ts parseDwsRows,
// on the engine's row reader shared with the manual series import): DWS's
// fixed-width daily table, as a saved HyData.aspx page (the table in its
// <pre>) or as the plain text, with the same checks (the DATE … QUAL header,
// the flow in m³/s, real dates, each day once).
//
// The span recorded as covered is the file's first to last listed day, or a
// wider from/to when the request asked for more (days DWS didn't list then
// read as no data, not "not loaded yet"). A write replaces that source's rows
// over the span and merges the span with the source's spans it touches;
// other sources' rows stay. A span longer than one call's cap goes in calls
// of CHUNK_DAYS days, which the caller runs in one transaction.
import { basename } from 'node:path';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import type pg from 'pg';
import { DWS_RIVER_GAUGE } from './config.js';
import { type DwsRowDay, parseDwsRows } from './sources/dws.js';

/** Days one call of gauge_record_write may span (its cap is 7330: DWS's 20 years a request). */
export const CHUNK_DAYS = 7000;

/** The sources an operator's load writes (dws-web is the worker's weekly pass only). */
export type OperatorSource = 'dws-request' | 'upload';

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

/** What a plan reads: the file's name (a station may be read from it), the station if given, and a wider span if asked. */
export interface PlanOptions {
	file: string;
	station: string | null;
	from: string | null;
	to: string | null;
}

export interface Plan {
	station: string;
	rows: DwsRowDay[];
	/** Each call's span (≤ CHUNK_DAYS days) and its rows. */
	chunks: { from: string; to: string; rows: DwsRowDay[] }[];
	/** Listed rows with no value (a gap, e.g. quality 170): stored as gaps. */
	gaps: number;
}

/** What a file loads: its station, its rows (read by the feed's reader) and the calls that write them. */
export function planImport(text: string, o: PlanOptions): Plan {
	const station = stationOf(text, o.file, o.station);
	const parsed = parseDwsRows(text, o.from ? { start: o.from, end: o.to! } : undefined);
	if (!parsed.rows.length) throw new Error('the file lists no days');
	if (parsed.outside) throw new Error(`${parsed.outside} row(s) fall outside --from/--to`);
	const from = o.from ?? parsed.rows[0]!.day;
	const to = o.to ?? parsed.rows.at(-1)!.day;
	const chunks: Plan['chunks'] = [];
	for (let a = toEpochDay(from); a <= toEpochDay(to); a += CHUNK_DAYS) {
		const lo = fromEpochDay(a);
		const hi = fromEpochDay(Math.min(a + CHUNK_DAYS - 1, toEpochDay(to)));
		chunks.push({ from: lo, to: hi, rows: parsed.rows.filter((r) => r.day >= lo && r.day <= hi) });
	}
	return { station, rows: parsed.rows, chunks, gaps: parsed.rejected };
}

/**
 * Write `plan` through gauge_record_write, one call per chunk, on `client`
 * (the schema owner: the function is closed to water_app). The caller owns
 * the transaction, so a failing chunk leaves nothing behind. Returns the rows
 * written.
 */
export async function writeGaugeRecordPlan(
	client: pg.ClientBase,
	plan: Plan,
	o: { origin: 'dws' | 'fixtures'; source: OperatorSource; reference: string | null; fetchedAt: Date }
): Promise<number> {
	let written = 0;
	for (const c of plan.chunks) {
		const r = await client.query<{ written: number }>(
			'SELECT written FROM gauge_record_write($1, $2, $3, $4, $5, $6::date[], $7::double precision[], $8::text[], $9, $10)',
			[o.origin, plan.station, o.source, c.from, c.to, c.rows.map((x) => x.day), c.rows.map((x) => x.value), c.rows.map((x) => x.quality), o.fetchedAt.toISOString(), o.reference]
		);
		written += r.rows[0]!.written;
	}
	return written;
}
