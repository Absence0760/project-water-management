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
// fill runs in its own savepoint. An expected failure (the copy's files not
// in the form we read, the copy not answering usefully, the cell cache
// refusing the values: expectedFillFailure) is rolled back to it, logged by
// class, and recorded on the feed (last_meta.gapEra5l / gapImergLate,
// 254_feed_gap_fill_outcome), so the Data tab and GET …/feeds say "couldn't
// fill" rather than "nothing held yet"; the run then says it has no such
// rain (gapRain.ts). Anything else is a bug: rolled back to the savepoint
// and thrown, so the job fails and says so.
//
// Bounded by time, not only by GAP_FILL_WINDOWS: the fill shares the
// feed_fetch job's transaction with the CHIRPS days, so a job that ran past
// the worker Lambda's timeout (300 s, infra/jobs.tf worker_timeout_seconds)
// would lose them too. Before each window it checks the time left: at most
// GAP_FILL_BUDGET_MS from its start, and never past the job's deadline
// (JobContext.deadline, the Lambda's timeout less 10 s) less
// GAP_FILL_MARGIN_MS for the IMERG fill and the commit. Windows it doesn't
// reach wait for the next fetch, newest first as ever. A follow-up job of
// its own was the other choice, but only a feed_fetch job of a CHIRPS feed
// may write the cache (252), so it would widen that rule for no gain: the
// budget keeps the CHIRPS days safe, and the fill still converges.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { resolveGapRain } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';
import type { MirrorStore } from '../mirror/store.js';
import { gapRainFeed, gapRainRecordStart, GAP_PRODUCT_FIRST_DAY } from '../runs/gapRainInput.js';
import { uniqueCells } from './cellCache.js';
import { FILL_MAX_DAYS, fillProductCache, type OtherRainProduct } from './fromMirror.js';
import type { CacheOrigin } from './cellCacheStore.js';
import { FeedFormatError, FeedUnavailableError } from './errors.js';
import type { FeedRow } from './store.js';

/** The most year-long windows of ERA5-Land one fetch reads from the copy. */
export const GAP_FILL_WINDOWS = 12;
/** The days of IMERG Late each fetch fills: the copy's KEEP_DAYS. */
export const IMERG_FILL_DAYS = 30;
/**
 * The most time one fetch spends filling. A window is one or two year
 * chunks of the copy per 20 × 20 block of cells (a few hundred kB from S3)
 * and a merge of at most 100 cells × 366 days. Measured against the
 * committed fixture copy (3 cells, local disk): all 12 windows in about
 * 0.17 s. From S3 each chunk is a GET of tens of milliseconds and a large
 * feed merges more rows, so a second or two a window, and 12 still fit with
 * room to spare; a slow copy stops here instead of at the Lambda's timeout.
 */
export const GAP_FILL_BUDGET_MS = 60_000;
/** Kept back from the job's deadline: the IMERG fill, the outcome's write and the commit. */
export const GAP_FILL_MARGIN_MS = 20_000;

/** Why a product's fill failed, in our words (254: never an error's text). */
export type GapFillError = 'format' | 'unavailable' | 'refused';

export interface GapFillOutcome {
	product: OtherRainProduct;
	/** Windows read from the copy (cached ones aren't counted). */
	windows: number;
	/** 'not_ready': the copy holds no such product yet; 'failed': an expected failure (`error`), rolled back to its savepoint. */
	status: 'ok' | 'not_ready' | 'failed';
	error?: GapFillError;
	/** Windows left for the next fetch: the time ran out (GAP_FILL_BUDGET_MS, the job's deadline) or GAP_FILL_WINDOWS was reached. */
	more?: true;
}

/**
 * A fill failure that is the copy's or the cache's, not a bug: the copy's
 * files aren't in the form we read (FeedFormatError: MirrorFormatError,
 * MirrorManifestError, an implausible value, a cell outside the region), it
 * didn't answer usefully (FeedUnavailableError; MirrorNotReadyError never
 * gets here, fillProductCache answers it 'not_ready'), or the cell cache
 * refused the values (252 chirps_cache_merge's check_violation). Null for
 * anything else.
 */
export function expectedFillFailure(err: unknown): GapFillError | null {
	if (err instanceof FeedFormatError) return 'format';
	if (err instanceof FeedUnavailableError) return 'unavailable';
	if ((err as { code?: unknown } | null)?.code === '23514') return 'refused';
	return null;
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
	opts: { jobId: string; today: string; store?: MirrorStore; origin?: CacheOrigin; deadline?: number | null; now?: () => number }
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
	const now = opts.now ?? Date.now;
	const stopAt = Math.min(now() + GAP_FILL_BUDGET_MS, opts.deadline ? opts.deadline - GAP_FILL_MARGIN_MS : Infinity);
	const out: GapFillOutcome[] = [];
	const run = async (product: OtherRainProduct, windows: { start: string; end: string }[], most: number) => {
		const cells = uniqueCells(source.cells, product);
		const outcome: GapFillOutcome = { product, windows: 0, status: 'ok' };
		await db.query('SAVEPOINT gap_rain_fill');
		try {
			for (const window of windows) {
				if (outcome.windows >= most || now() >= stopAt) {
					outcome.more = true;
					break;
				}
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
			const error = expectedFillFailure(err);
			if (!error) throw err;
			// The class (MirrorFormatError …) and code only: the message can carry values (an implausible rainfall) or, from pg, row data.
			logEvent('warn', { event: 'gap_rain_fill_failed', feedId: feed.id, product, reason: error, ...safeError(err), class: errorClass(err) });
			outcome.status = 'failed';
			outcome.error = error;
		}
		// Where the feed's state lives (254): the Data tab and GET …/feeds read it.
		await db.query('SELECT app_record_gap_fill($1, $2, $3, $4)', [feed.id, opts.jobId, product, outcome.status === 'failed' ? `failed:${outcome.error}` : outcome.status]);
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

/** An error's class name when it is a short token (MirrorFormatError …), else 'Error'. */
function errorClass(err: unknown): string {
	const n = (err as { constructor?: { name?: unknown } } | null)?.constructor?.name;
	return typeof n === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(n) ? n : 'Error';
}
