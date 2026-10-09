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
	const { rows } = await db.query<{ n: number }>('SELECT chirps_cache_merge($1, $2, $3, $4, $5, $6, $7, $8) AS n', [
		feedId,
		origin,
		answer.product,
		answer.startDate,
		answer.read,
		order.map((i) => answer.cells[i]![0]),
		order.map((i) => answer.cells[i]![1]),
		order.flatMap((i) => answer.values[i]!.map(decodeCellValue))
	]);
	return rows[0]?.n ?? 0;
}
