// `feed_fetch`: fetch one data feed's new days, as the owner who set it up
// (who must still be an editor). Queued by the tick's feed scheduler
// (feeds/schedule.ts) and by "Run now" (POST /projects/:id/feeds/:feedId/run-now).
//
//   FEED_FETCHER=inline (default): fetch here, from FEED_SOURCE (fixtures
//     unless set to live), and ingest in this same transaction.
//   FEED_FETCHER=sqs (production): the worker has no internet, so hand the
//     request to the fetcher Lambda through the `fetch-requests` queue. Its
//     answer comes back on `ingest-results` and becomes a `feed_ingest` job.
//     First the job records itself and its window on the feed
//     (app_begin_feed_fetch, 029), committed on its own connection before the
//     request is sent, so the answer is checked against what was asked for, a
//     late answer to an older fetch is dropped (feed-ingest.ts, issue #31), and
//     an answer that comes back before this job commits still finds it.
//
// A CHIRPS fetch goes through the shared cell cache (208_chirps_cell_cache,
// feeds/cellCache.ts): the request names only the cells and days the cache
// lacks or holds as preliminary. When it lacks none, nothing is fetched at
// all: the feed's days are computed from the cache here, at once.
//
// A CHIRPS fetch also carries its share of the re-check of cached finals CHC
// rewrites in place (210_chirps_final_recheck, cellCache.ts RECHECK_*): the
// days its cells hold stale or untagged to read again, and, once the feed is
// caught up, a few final files to HEAD, claimed for this job. With such work
// the request goes out even when the window needs nothing (its plan all
// skips).
//
// With CHIRPS_SOURCE=mirror (mirror/source.ts; the default in dev, CI and e2e)
// a CHIRPS fetch reads our own copy of CHIRPS instead, in this job, whatever
// FEED_FETCHER says: no FetchRequest, no SQS round trip (feeds/fromMirror.ts,
// issue #604 D3). So does a CHIRPS-GEFS fetch: it reads the newest issue the
// daily GEFS pass copied (feeds/fromMirrorGefs.ts, R3-A).
//
// With DWS_SOURCE=store (feeds/fromGaugeRecord.ts dwsSource; the default in
// dev, CI and e2e) a DWS fetch reads its station's days from our gauge record
// store (247_gauge_record) the same way, in this job (issue #604 R3-B).
//
// After the cutover (both of those, issue #604 R3-C) no fetch reaches the
// SQS or inline paths below, so production sets no FEED_FETCHER and has no
// fetch-requests queue (infra/feeds.tf local.per_feed_fetching). The inline
// path stays for local dev; on Lambda its live client refuses (feeds/http.ts),
// and the job dies saying why.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { z } from 'zod';
import { planFetch, RECHECK_HEAD_DAYS, RECHECK_INTERVAL_DAYS, RECHECK_READ_DAYS, uniqueCells } from '../../feeds/cellCache.js';
import { cacheOrigin, claimRecheck, readCellCache } from '../../feeds/cellCacheStore.js';
import { chirpsProduct, type GridConfig, gridCells } from '../../feeds/config.js';
import { type CellsResult, type FetchRequest, fetchWindow, runFetch, utcToday } from '../../feeds/fetch.js';
import { DAY_SKIP } from '../../feeds/sources/chirps.js';
import { withUser } from '../../db/tx.js';
import { feedHttp, LiveFeedRequestRefusedError } from '../../feeds/http.js';
import { JobError } from '../errors.js';
import { fetchFromMirror } from '../../feeds/fromMirror.js';
import { fetchGefsFromMirror } from '../../feeds/fromMirrorGefs.js';
import { fetchEcmwfFromMirror } from '../../feeds/fromMirrorEcmwf.js';
import { ingestResult } from '../../feeds/ingest.js';
import { chirpsSource } from '../../mirror/source.js';
import { dwsSource, fetchFromGaugeRecord } from '../../feeds/fromGaugeRecord.js';
import { beginFeedFetch, feedForJob, takeFeedFetch } from '../../feeds/store.js';
import { defineHandler } from '../registry.js';
import { feedFetcher, type FetchRequestMessage, sendToQueue } from '../transport.js';

export const FeedFetchPayload = z.object({ feedId: z.string().uuid() }).strict();

// One pending fetch per feed: the key lives in feeds/store.ts, so the ingest (which queues a backfill's next window) shares it.
export { feedFetchDedupeKey } from '../../feeds/store.js';

export const feedFetchHandler = defineHandler({
	role: 'editor',
	payload: FeedFetchPayload,
	async run({ db, job, payload }) {
		const feed = await feedForJob(db, job.projectId, payload.feedId);
		// Removed or switched off since it was queued: nothing to do.
		if (!feed || !feed.enabled) return;
		const today = utcToday();
		const window = fetchWindow(feed.source, feed.config, feed.lastDataDate, today, feed.readThrough, feed.finalThrough);
		const request: FetchRequest = { source: feed.source, config: feed.config, ...window, today };
		if (feed.source === 'chirps' && chirpsSource() === 'mirror') {
			await fetchFromMirror(db, feed, window, { jobId: job.id, today });
			return;
		}
		// CHIRPS-GEFS from the copy too (issue #604 R3-A): the newest issue the daily GEFS pass copied, read in this job.
		if (feed.source === 'chirps_gefs' && chirpsSource() === 'mirror') {
			await fetchGefsFromMirror(db, feed, window, { jobId: job.id, today });
			return;
		}
		// ECMWF ENS (issue #604 R4-C): only ever from the copy, whatever CHIRPS_SOURCE says (there is no per-feed path).
		if (feed.source === 'ecmwf_ens') {
			await fetchEcmwfFromMirror(db, feed, window, { jobId: job.id, today });
			return;
		}
		// DWS from our gauge record store (issue #604 R3-B).
		if (feed.source === 'dws' && dwsSource() === 'store') {
			await fetchFromGaugeRecord(db, feed, window, { jobId: job.id, today });
			return;
		}
		if (feed.source === 'chirps') {
			const product = chirpsProduct(feed.config);
			const cells = uniqueCells(gridCells(feed.config as GridConfig));
			const origin = cacheOrigin();
			const plan = planFetch(cells, await readCellCache(db, origin, product, cells, window), window);
			// HEADs only once the feed is caught up (a CHIRPS day is yesterday at best), so a backfill's windows don't carry them.
			const caughtUp = window.end >= fromEpochDay(toEpochDay(today) - 1);
			const recheck = await claimRecheck(db, feed.id, origin, product, cells, {
				heads: caughtUp ? RECHECK_HEAD_DAYS : 0,
				reads: RECHECK_READ_DAYS,
				intervalDays: RECHECK_INTERVAL_DAYS
			});
			if (!plan && !recheck) {
				// The cache holds every day the window can use, final: no fetch. In
				// production this still counts as the feed's newest fetch, so a late
				// answer to an older one is dropped (feed-ingest.ts).
				if (feedFetcher() === 'sqs') {
					await beginFeedFetch(db, feed.id, job.id, window);
					await takeFeedFetch(db, feed.id, job.id);
				}
				const fromCache: CellsResult = { ok: true, cells: { product, startDate: window.start, read: '', cells: [], values: [] }, meta: { product } };
				await ingestResult(db, feed, fromCache, window, { cacheOnly: true });
				return;
			}
			const grid = (cs: typeof cells) => cs.map((c): [number, number] => [c.row, c.col]);
			// Only re-check work: every cell, every day skipped, so the window reads nothing.
			const days = toEpochDay(window.end) - toEpochDay(window.start) + 1;
			request.cells = plan ? { cells: grid(plan.cells), plan: plan.plan } : { cells: grid(cells), plan: DAY_SKIP.repeat(days) };
			if (recheck) request.recheck = { cells: grid(cells), head: recheck.head, read: recheck.read };
		}
		if (feedFetcher() === 'sqs') {
			// Committed now, on its own connection, before the request leaves (as
			// report-render.ts commits its token): the answer is applied only if
			// app_take_feed_fetch finds this record, and it can't see one this
			// job's transaction hasn't committed. A failure can come back in a
			// third of a second, and an answer that beat the commit, or met a
			// job that rolled back after sending (a lost lease, a timeout), was
			// dropped without a trace: the feed never showed the failure.
			await withUser(job.actingUserId, (tx) => beginFeedFetch(tx, feed.id, job.id, window));
			const message: FetchRequestMessage = { v: 1, type: 'fetch', fetchJobId: job.id, feedId: feed.id, feedVersion: feed.version, request };
			try {
				await sendToQueue(process.env.FETCH_REQUESTS_QUEUE_URL, 'FETCH_REQUESTS_QUEUE_URL', message);
			} catch (err) {
				// Nothing went out: withdraw the record, so the feed isn't held as
				// "a fetch is still out" (fromBoundary.ts, fromUnits.ts) by an
				// answer that can't come. The job's retry records it again.
				await withUser(job.actingUserId, (tx) => takeFeedFetch(tx, feed.id, job.id)).catch(() => {});
				throw err;
			}
			return;
		}
		// Inline: the fetch holds this transaction open for its duration, which
		// is fine locally (fixtures answer at once); production never does this.
		// On Lambda a live client refuses (feeds/http.ts): a worker configured to
		// fetch a source itself is a bug no retry fixes, so the job is dead at once,
		// saying why (issue #604 R3-C).
		let http;
		try {
			http = await feedHttp();
		} catch (err) {
			if (err instanceof LiveFeedRequestRefusedError) {
				throw new JobError(
					`this worker may not fetch ${feed.source} from the source itself: production reads it from our copy or store (CHIRPS_SOURCE=mirror, DWS_SOURCE=store) or hands it to the fetcher (FEED_FETCHER=sqs)`,
					{ retry: false }
				);
			}
			throw err;
		}
		await ingestResult(db, feed, await runFetch(request, http), window, { fetchJobId: job.id });
	}
});
