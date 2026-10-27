// A DWS feed fetch read from our own store of DWS gauge flow (issue #604
// R3-B, design D14; 247_gauge_record.sql), when DWS_SOURCE=store (dwsSource
// below: the default in dev, CI and e2e; production stays on live, the
// per-feed request to DWS's site through the fetcher, until the operator has
// DWS's written answer).
//
// The feed_fetch job plans as before (fetch.ts fetchWindow: at most two
// years a window, a year re-read), then reads its station's days from
// gauge_record_current (per day, the best source: a DWS reply, then the
// weekly web pass, then an upload) inside the job, and ingests them in the
// same transaction. No FetchRequest, no SQS round trip, whatever
// FEED_FETCHER says. The answer is the live path's exactly (fetch.ts
// runFetch, case 'dws'): the listed days laid out from the first, a day not
// listed a gap, and the meta's days, gaps, rejected (listed gap rows) and
// quality counts. (`outside` is never set: the store is read by the window.)
//
// What the store doesn't hold (gauge_record_span: the days each source was
// asked for, listed or not):
//   * Nothing at all for the station, or nothing from the window's first day
//     on: the store hasn't reached these days. The fetch writes nothing and
//     records only that it looked (last_attempt_at): no failure, no backoff,
//     and the same window next time, as with the CHIRPS copy (fromMirror.ts).
//   * Days the spans skip, or before the first: DWS has no data there (the
//     page lists none), read as gaps, as the live path reads them.
//   * The days after the store's newest: a window that reaches today reads
//     to today (they come with the next weekly pass, and the feed's year of
//     re-read picks them up); a backfill window that ends before today is cut
//     at the store's newest day, so the walk stops there and waits rather
//     than stepping over days the store will hold.
//
// Fixtures mode (FEED_SOURCE=fixtures): before reading, the window's days are
// written to the store from the synthetic DWS page the live path reads in
// dev (feeds/fixtures.ts fixtureHttp, the same parser), as the weekly pass
// would, with origin `fixtures`. So dev, CI and e2e DWS feeds show the
// values they always did, and nothing needs seeding first.
import { withoutUser, type Db } from '../db/tx.js';
import { feedFetcher } from '../jobs/transport.js';
import type { DwsConfig } from './config.js';
import { fetchFailure, type FetchResult, type FetchWindow } from './fetch.js';
import { loadWebFile } from './gaugeRecordLoad.js';
import { feedSourceMode } from './http.js';
import { ingestResult } from './ingest.js';
import { type DwsRowDay, dwsRowValues, dwsUrl, parseDwsRows } from './sources/dws.js';
import { beginFeedFetch, type FeedRow, recordFeedChecked, takeFeedFetch } from './store.js';

export const DWS_SOURCES = ['store', 'live'] as const;
export type DwsSource = (typeof DWS_SOURCES)[number];

type Env = Record<string, string | undefined>;

/** DWS_SOURCE, or its default: live when FEED_SOURCE is live, else store. */
export function dwsSource(env: Env = process.env): DwsSource {
	const v = env.DWS_SOURCE?.trim();
	if (!v) return env.FEED_SOURCE?.trim() === 'live' ? 'live' : 'store';
	if (!(DWS_SOURCES as readonly string[]).includes(v)) throw new Error(`unknown DWS_SOURCE "${v}" (expected ${DWS_SOURCES.join(', ')})`);
	return v as DwsSource;
}

/** Which gauge_record rows this process reads and writes: dws for a live process, fixtures for the synthetic page's. */
export const gaugeOrigin = (): 'dws' | 'fixtures' => (feedSourceMode() === 'live' ? 'dws' : 'fixtures');

/** The live path's answer (fetch.ts runFetch, case 'dws') from listed rows. */
export function dwsAnswer(rows: readonly DwsRowDay[]): Extract<FetchResult, { ok: true }> {
	const { startDate, values } = dwsRowValues(rows);
	const quality: Record<string, number> = {};
	let rejected = 0;
	for (const r of rows) {
		if (r.value === null) rejected++;
		if (r.quality) quality[r.quality] = (quality[r.quality] ?? 0) + 1;
	}
	const meta: Record<string, string | number> = { days: values.length, gaps: values.filter((v) => v === null).length };
	if (rejected) meta.rejected = rejected;
	for (const [code, n] of Object.entries(quality).slice(0, 10)) meta[`quality ${code.slice(0, 20)}`] = n;
	return startDate === null ? { ok: true, startDate: null, values: [], meta } : { ok: true, startDate, values, meta };
}

/** Fixtures mode: the window's days from the synthetic page, into the store as the weekly pass would put them. */
async function seedFromFixtures(station: string, start: string, end: string): Promise<void> {
	// Loaded only here: fixtures.ts reads its files as it loads, and a Lambda bundle never seeds.
	const { fixtureHttp } = await import('./fixtures.js');
	const page = await fixtureHttp().text(dwsUrl(station, start, end));
	const rows = page === null ? [] : parseDwsRows(page, { start, end }).rows;
	await withoutUser((db) =>
		loadWebFile(db, 'fixtures', { station, from: start, to: end, fetchedAt: new Date().toISOString(), rows: rows.map((r) => [r.day, r.value, r.quality]) })
	);
}

/** How a fetch from the store ended: ingested (or failed, recorded on the feed), or the store doesn't hold the window yet. */
export type GaugeFetchOutcome = 'ingested' | 'not_ready';

/**
 * One DWS feed_fetch read from the store and ingested, in the job's
 * transaction as its acting user (see the header). `jobId` is the running
 * feed_fetch job.
 */
export async function fetchFromGaugeRecord(db: Db, feed: FeedRow, window: FetchWindow, opts: { jobId: string; today: string }): Promise<GaugeFetchOutcome> {
	const station = (feed.config as DwsConfig).station;
	const origin = gaugeOrigin();
	// In production this is the feed's newest fetch, so a late answer to an older one, sent to the fetcher before the
	// switch, is dropped (feed-ingest.ts).
	if (feedFetcher() === 'sqs') {
		await beginFeedFetch(db, feed.id, opts.jobId, window);
		await takeFeedFetch(db, feed.id, opts.jobId);
	}
	// Never a day after today, as the live path (the feed's newest day drives its next window and its health).
	const end = window.end < opts.today ? window.end : opts.today;
	// A window that starts after today (a startDate in the future) asks for no days: the live page lists none.
	if (window.start > end) {
		await ingestResult(db, feed, dwsAnswer([]), window, { cacheOnly: true, fetchJobId: opts.jobId });
		return 'ingested';
	}
	if (origin === 'fixtures') {
		try {
			await seedFromFixtures(station, window.start, end);
		} catch (err) {
			await ingestResult(db, feed, fetchFailure(err, feed.config), window, { fetchJobId: opts.jobId });
			return 'ingested';
		}
	}
	const { rows: spans } = await db.query<{ newest: string | null }>(
		`SELECT to_char(max(day_to), 'YYYY-MM-DD') AS newest FROM gauge_record_span WHERE origin = $1 AND station = $2`,
		[origin, station]
	);
	const newest = spans[0]?.newest ?? null;
	if (newest === null || newest < window.start) {
		// The store hasn't reached these days: nothing written, no failure counted, the same window next time.
		await recordFeedChecked(db, feed.id);
		return 'not_ready';
	}
	// A backfill window past the store's newest day stops there (see the header); the window reaching today reads to its end.
	const read: FetchWindow = newest < end && window.end < opts.today ? { start: window.start, end: newest } : window;
	const { rows } = await db.query<{ day: string; value: number | null; quality: string | null }>(
		`SELECT to_char(day, 'YYYY-MM-DD') AS day, value, quality FROM gauge_record_current
		 WHERE origin = $1 AND station = $2 AND day BETWEEN $3 AND $4 ORDER BY day`,
		[origin, station, read.start, read.end < end ? read.end : end]
	);
	// cacheOnly: nothing was asked of DWS, so a backfill's next window follows in CACHED_NEXT_SECONDS.
	await ingestResult(db, feed, dwsAnswer(rows.map((x) => ({ day: x.day, value: x.value === null ? null : Number(x.value), quality: x.quality }))), read, { cacheOnly: true, fetchJobId: opts.jobId });
	return 'ingested';
}

