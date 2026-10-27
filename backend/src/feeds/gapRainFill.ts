// Fill the cell cache with the gap-filling products a project's runs read
// (engine ≥ 1.101.0, issue #604 R4-B, settings.gapRain; runs/gapRainInput.ts
// reads them).
//
// 252 lets only a running feed_fetch job of a CHIRPS feed write the cache, so
// the fill rides on the fetch of the CHIRPS feed whose cells the runs read
// (gapRainFeed): after the feed's own CHIRPS days, in the same job, from our
// copy (fromMirror.ts fillProductCache). Only when the feed reads the copy
// (CHIRPS_SOURCE=mirror) and the project's settings.gapRain asks for a product.
//
// ERA5-Land: the record's span (from the first day of the outlet catchment
// rain or CHIRPS, at most back to 1950) to today, which the fits need, in
// windows of at most a year (FILL_MAX_DAYS), newest first. A window the cache
// holds final costs a cache read and no copy read (fillProductCache
// 'cached') and doesn't count; at most GAP_FILL_WINDOWS windows a fetch read
// the copy, so a long record arrives over a few fetches, and once it is in,
// each fetch reads only the days ERA5-Land added.
// IMERG Late: the copy keeps only its last 30 days (ingest/imerg.py
// KEEP_DAYS), so each fetch fills those; the cache keeps them after the copy
// drops them, which is the history a version's fit grows from.
//
// A failure here never takes the feed's CHIRPS days with it: each product's
// fill runs in its own savepoint, and one that throws is rolled back to it
// and logged; the run then says it has no such rain (gapRain.ts).
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { resolveGapRain } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import type { MirrorStore } from '../mirror/store.js';
import { gapRainFeed, gapRainRecordStart, GAP_PRODUCT_FIRST_DAY } from '../runs/gapRainInput.js';
import { uniqueCells } from './cellCache.js';
import { FILL_MAX_DAYS, fillProductCache, type OtherRainProduct } from './fromMirror.js';
import type { CacheOrigin } from './cellCacheStore.js';
import type { FeedRow } from './store.js';

/** The most year-long windows of ERA5-Land one fetch reads from the copy. */
export const GAP_FILL_WINDOWS = 12;
/** The days of IMERG Late each fetch fills: the copy's KEEP_DAYS. */
export const IMERG_FILL_DAYS = 30;

export interface GapFillOutcome {
	product: OtherRainProduct;
	/** Windows read from the copy (cached ones aren't counted); status 'not_ready' when the copy holds no such product yet, 'failed' when the fill threw (logged). */
	windows: number;
	status: 'done' | 'not_ready' | 'failed';
}

/**
 * After a CHIRPS feed's fetch from the copy (feed-fetch.ts), fill the gap
 * products its project's runs read over the feed's cells. Nothing unless the
 * project's settings.gapRain asks for a product and this is the feed whose
 * cells its runs read. `jobId` is the running feed_fetch job.
 */
export async function fillGapProducts(
	db: Db,
	feed: Pick<FeedRow, 'id' | 'projectId'>,
	opts: { jobId: string; today: string; store?: MirrorStore; origin?: CacheOrigin }
): Promise<GapFillOutcome[]> {
	const { rows } = await db.query<{ settings: { gapRain?: unknown } | null }>('SELECT settings FROM project WHERE id = $1', [feed.projectId]);
	const gap = resolveGapRain(rows[0]?.settings?.gapRain, []);
	if (!gap) return [];
	const { rows: read } = await db.query<{ id: string }>(
		`SELECT id FROM time_series WHERE project_id = $1 AND site_node_id IS NULL AND kind = 'rain_chirps_mm' ORDER BY name COLLATE "C" LIMIT 1`,
		[feed.projectId]
	);
	const source = await gapRainFeed(db, feed.projectId, read[0]?.id ?? null);
	if (source?.feedId !== feed.id) return [];
	const start = (await gapRainRecordStart(db, feed.projectId)) ?? opts.today;
	const out: GapFillOutcome[] = [];
	const run = async (product: OtherRainProduct, windows: { start: string; end: string }[], most: number) => {
		const cells = uniqueCells(source.cells, product);
		const outcome: GapFillOutcome = { product, windows: 0, status: 'done' };
		await db.query('SAVEPOINT gap_rain_fill');
		try {
			for (const window of windows) {
				if (outcome.windows >= most) break;
				const r = await fillProductCache(db, { feedId: feed.id, jobId: opts.jobId, product, cells, window, today: opts.today, ...(opts.store ? { store: opts.store } : {}), ...(opts.origin ? { origin: opts.origin } : {}) });
				if (r.status === 'not_ready') {
					outcome.status = 'not_ready';
					break;
				}
				if (r.status === 'filled') outcome.windows++;
			}
			await db.query('RELEASE SAVEPOINT gap_rain_fill');
		} catch (err) {
			await db.query('ROLLBACK TO SAVEPOINT gap_rain_fill');
			console.error(JSON.stringify({ msg: 'gap rain fill failed', feedId: feed.id, product, error: (err as Error).message }));
			outcome.status = 'failed';
		}
		out.push(outcome);
	};
	if (gap.product !== 'chirps') {
		const first = Math.max(toEpochDay(start), toEpochDay(GAP_PRODUCT_FIRST_DAY.era5l));
		const windows: { start: string; end: string }[] = [];
		for (let end = toEpochDay(opts.today); end >= first; end -= FILL_MAX_DAYS) {
			windows.push({ start: fromEpochDay(Math.max(first, end - FILL_MAX_DAYS + 1)), end: fromEpochDay(end) });
		}
		await run('era5l', windows, GAP_FILL_WINDOWS);
	}
	if (gap.imergLate) {
		const end = toEpochDay(opts.today);
		await run('imerg_late', [{ start: fromEpochDay(Math.max(end - IMERG_FILL_DAYS + 1, toEpochDay(GAP_PRODUCT_FIRST_DAY.imerg_late))), end: opts.today }], 1);
	}
	return out;
}
