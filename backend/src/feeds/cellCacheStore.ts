// The shared CHIRPS cell cache in the database (208_chirps_cell_cache.sql):
// reading a feed's cells, and merging a fetch's cell values through
// chirps_cache_merge. Worker side only (the fetcher Lambda has no database);
// the pure side is feeds/cellCache.ts.
import type { Db } from '../db/tx.js';
import { feedFetcher } from '../jobs/transport.js';
import { type CacheView, decodeCellValue, type GridCell, viewKey, windowYears } from './cellCache.js';
import type { ChirpsDailyProduct } from './config.js';
import type { CellsResult } from './fetch.js';
import { feedSourceMode } from './http.js';

/**
 * Where the cached values came from: `chc` (the real files) or `fixtures`
 * (FEED_SOURCE=fixtures, the synthetic grids). Kept apart, so a database that
 * ran on the fixtures never serves their values to a live feed. With
 * FEED_FETCHER=sqs the fetcher Lambda reads, and it is always live
 * (lambda-fetcher.ts refuses to start on the fixtures, config/production.ts),
 * so its answers are merged as `chc` (feed-ingest.ts) whatever the worker's
 * own FEED_SOURCE; an inline fetch reads what FEED_SOURCE says.
 */
export type CacheOrigin = 'chc' | 'fixtures';
export const cacheOrigin = (): CacheOrigin => (feedFetcher() === 'sqs' || feedSourceMode() === 'live' ? 'chc' : 'fixtures');

/** The cache rows of `cells` for the years `window` spans, as the job's acting user (any signed-in session reads it). */
export async function readCellCache(db: Db, origin: CacheOrigin, product: ChirpsDailyProduct, cells: readonly GridCell[], window: { start: string; end: string }): Promise<CacheView> {
	const view: CacheView = new Map();
	if (!cells.length || window.start > window.end) return view;
	const [y0, y1] = windowYears(window);
	const { rows } = await db.query<{ row: number; col: number; year: number; vals: (number | null)[]; final: boolean[] }>(
		`SELECT r.row_idx AS row, r.col_idx AS col, r.year, r.vals, r.final
		 FROM chirps_cell_year r
		 JOIN unnest($3::int[], $4::int[]) AS k(row_idx, col_idx) ON k.row_idx = r.row_idx AND k.col_idx = r.col_idx
		 WHERE r.origin = $1 AND r.product = $2 AND r.year BETWEEN $5 AND $6`,
		[origin, product, cells.map((c) => c.row), cells.map((c) => c.col), y0, y1]
	);
	// pg parses real[] with parseFloat; Math.fround gives back the stored float32 exactly, so a day is the number the file gave.
	for (const r of rows) view.set(viewKey(r, r.year), { vals: r.vals.map((v) => (v === null ? null : Math.fround(v))), final: r.final });
	return view;
}

/**
 * Merge a fetch's cell values for feed `feedId` into the cache
 * (chirps_cache_merge, which takes them only from a running job of that
 * feed, checks every value again and keeps final values over preliminary
 * ones).
 * The cells go in (row, column) order, the function's lock order. Throws
 * what the function raises; the ingest turns that into an invalid answer.
 */
export async function mergeCellCache(db: Db, feedId: string, origin: CacheOrigin, answer: CellsResult['cells']): Promise<number> {
	if (!answer.cells.length || !answer.read.length) return 0;
	const order = answer.cells.map((_, i) => i).sort((a, b) => answer.cells[a]![0] - answer.cells[b]![0] || answer.cells[a]![1] - answer.cells[b]![1]);
	const { rows } = await db.query<{ n: number }>('SELECT chirps_cache_merge($1, $2, $3, $4, $5, $6, $7, $8, $9) AS n', [
		feedId,
		origin,
		answer.product,
		answer.startDate,
		answer.read,
		order.map((i) => answer.cells[i]![0]),
		order.map((i) => answer.cells[i]![1]),
		order.flatMap((i) => answer.values[i]!.map(decodeCellValue)),
		answer.tags ?? null
	]);
	return rows[0]?.n ?? 0;
}

/** What one fetch re-checks (chirps_recheck_claim): days to read again at the feed's cells, and files to HEAD. */
export interface RecheckClaim {
	read: string[];
	head: string[];
}

/**
 * Claim this fetch's share of the re-check of cached finals (210
 * chirps_recheck_claim), as the running feed_fetch job's acting user: up to
 * `reads` days to read again for `cells` (their stale days, then files whose
 * tag isn't known) and up to `heads` files to HEAD. Null when there is none.
 */
export async function claimRecheck(
	db: Db,
	feedId: string,
	origin: CacheOrigin,
	product: ChirpsDailyProduct,
	cells: readonly GridCell[],
	{ heads, reads, intervalDays }: { heads: number; reads: number; intervalDays: number }
): Promise<RecheckClaim | null> {
	if (!cells.length || (heads <= 0 && reads <= 0)) return null;
	const { rows } = await db.query<{ kind: 'reread' | 'verify' | 'head'; day: string }>(
		`SELECT kind, to_char(day, 'YYYY-MM-DD') AS day FROM chirps_recheck_claim($1, $2, $3, $4, $5, $6, $7, $8)`,
		[feedId, origin, product, cells.map((c) => c.row), cells.map((c) => c.col), heads, reads, intervalDays]
	);
	if (!rows.length) return null;
	const sorted = (k: (r: (typeof rows)[number]) => boolean) => rows.filter(k).map((r) => r.day).sort();
	return { read: sorted((r) => r.kind !== 'head'), head: sorted((r) => r.kind === 'head') };
}

/**
 * Apply a re-check's answer (210 chirps_recheck_apply) for the feed's
 * `cells`, in (row, column) order as the request listed them: the files whose
 * tag changed have their cached finals marked stale, and the days read again
 * replace their cells' finals. `fetchJobId` is the fetch that claimed them.
 * Returns how many days' values changed (each logged in chirps_revision).
 * Throws what the function raises; the ingest turns that into an invalid answer.
 */
export async function applyRecheck(
	db: Db,
	feedId: string,
	fetchJobId: string,
	origin: CacheOrigin,
	product: ChirpsDailyProduct,
	cells: readonly GridCell[],
	answer: NonNullable<CellsResult['recheck']>
): Promise<number> {
	if (!answer.head.length && !answer.read.length) return 0;
	const { rows } = await db.query<{ n: number }>('SELECT chirps_recheck_apply($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) AS n', [
		feedId,
		fetchJobId,
		origin,
		product,
		answer.head.map((h) => h.day),
		answer.head.map((h) => h.tag),
		answer.read.map((r) => r.day),
		answer.read.map((r) => r.tag),
		cells.map((c) => c.row),
		cells.map((c) => c.col),
		// Cell by cell, each cell's days in turn; a gone file's day is null on every cell.
		cells.flatMap((_, c) => answer.read.map((r) => (r.values ? decodeCellValue(r.values[c]!) : null)))
	]);
	return rows[0]?.n ?? 0;
}

/** Whether any of `cells` still holds a stale final (chirps_cell_stale): the feed's next fetch should come soon to read it. */
export async function staleLeft(db: Db, origin: CacheOrigin, product: ChirpsDailyProduct, cells: readonly GridCell[]): Promise<boolean> {
	if (!cells.length) return false;
	const { rows } = await db.query(
		`SELECT 1 FROM chirps_cell_stale s JOIN unnest($3::int[], $4::int[]) AS k(r, c) ON s.row_idx = k.r AND s.col_idx = k.c
		 WHERE s.origin = $1 AND s.product = $2 LIMIT 1`,
		[origin, product, cells.map((c) => c.row), cells.map((c) => c.col)]
	);
	return rows.length > 0;
}

/**
 * The days of `origin` / `product` whose cached finals were revised by
 * transactions from `since` (a transaction id, chirps_revision.xid, or null:
 * none yet looked at) to the oldest still running, which no later reader
 * can miss: every transaction before it has finished. At most `maxDays`
 * distinct days, whole transactions at a time (`more`: some were left); `next` is where to look from
 * next time (the oldest transaction not taken). With `since` null only this
 * transaction's own are read: a feed that never looked starts from now, its
 * days already computed from the current cache.
 */
export async function revisedDays(
	db: Db,
	origin: CacheOrigin,
	product: ChirpsDailyProduct,
	sinceMarker: string | null,
	maxDays: number
): Promise<{ days: string[]; next: string; more: boolean }> {
	const { rows: snap } = await db.query<{ xmin: string }>('SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin');
	const xmin = snap[0]!.xmin;
	let since = sinceMarker;
	// A marker past every transaction there is (a database restored from a dump numbers them afresh) would never see a
	// row again: start from now instead, as a feed that never looked does.
	if (since !== null && BigInt(since) > BigInt(xmin)) {
		const { rows: cur } = await db.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid');
		if (BigInt(since) > BigInt(cur[0]!.xid)) since = null;
	}
	// And this transaction's own (its re-check, just applied): taken now, and once more next time, which changes nothing.
	const { rows } = await db.query<{ xid: string; day: string }>(
		`SELECT xid::text AS xid, to_char(day, 'YYYY-MM-DD') AS day FROM chirps_revision
		 WHERE origin = $1 AND product = $2
			AND (($3::xid8 IS NOT NULL AND xid >= $3::xid8 AND xid < $4::xid8) OR xid = pg_current_xact_id_if_assigned())
		 ORDER BY xid, day`,
		[origin, product, since, xmin]
	);
	const days = new Set<string>();
	for (let i = 0; i < rows.length; ) {
		const xid = rows[i]!.xid;
		const group: string[] = [];
		for (; i < rows.length && rows[i]!.xid === xid; i++) group.push(rows[i]!.day);
		const fresh = group.filter((d) => !days.has(d));
		// Whole transactions only, so `next` never splits one; the first always goes, however many days it has. Never
		// past xmin: stopping at this transaction's own group (above xmin), a transaction between them may still commit.
		if (days.size && days.size + fresh.length > maxDays) return { days: [...days].sort(), next: BigInt(xid) < BigInt(xmin) ? xid : xmin, more: true };
		for (const d of fresh) days.add(d);
	}
	return { days: [...days].sort(), next: xmin, more: false };
}

/** Where a feed that hasn't looked at revisions yet starts (revisedDays' `next` for no marker): the oldest transaction still running. */
export async function revisionMarkNow(db: Db): Promise<string> {
	const { rows } = await db.query<{ xmin: string }>('SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin');
	return rows[0]!.xmin;
}
