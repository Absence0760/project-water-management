// Fetcher Lambda — the data feeds' only door to the internet (FEED_SOURCE=live;
// docs/architecture.md § Data feeds, infra/feeds.tf).
//
// It runs OUTSIDE the VPC and has no database access and no credentials to
// one: its role may only receive from `fetch-requests` and send to
// `ingest-results`. For each request it downloads and parses the source
// (feeds/fetch.ts runFetch, which never throws) and sends the result, success
// or failure, back for the worker to apply as the feed's acting user. What it
// sends is treated as untrusted input on the other side.
//
// Every request that names a fetch job gets an answer, so the feed's health
// records what happened (the feed_fetch job is already done, so nothing else
// would): a fetch still running near the Lambda's timeout is answered as a
// failure ("did not answer in time") rather than timing out into retries and
// the DLQ, and a request it can route but not run (e.g. a source this build
// doesn't know) is answered as a failure too. Only a message with no fetch job
// to answer is dropped (logged): a retry can't fix it. A failed send is the
// one retried case: it is reported as a batch item failure, so SQS retries
// that message and, after 5 receives, dead-letters it (alarmed).
//
// A second mode (issue #604 R2-B): an EventBridge schedule invokes it with
// `{"mode":"daily-ingest"}` (DAILY_INGEST_EVENT, infra/feeds.tf), and it
// copies the new CHIRPS preliminary days into the rain data copy
// (ingest/daily.ts), publishing the copy's MirrorLagDays for Product=prelim.
// That run writes the mirror bucket (MIRROR_URL); the per-feed mode above
// stays as it is until the worker reads the copy everywhere (R3-C). The same
// mode with `"pass":"gefs"` copies the newest CHIRPS-GEFS issue instead
// (ingest/gefs.ts, issue #604 R3-A), on its own rule, and with
// `"pass":"indices"` NOAA CPC's ONI and AAO climate indices (ingest/indices.ts,
// issue #620), on a rule of its own too.
//
// A third (issue #604 R3-B): a weekly schedule invokes it with
// `{"mode":"dws-weekly"}` (DWS_WEEKLY_EVENT, infra/feeds.tf), and it reads the
// newest two years of each station our DWS feeds name into the mirror bucket
// (ingest/dws.ts), for the worker to load into the gauge record store,
// publishing MirrorLagDays for Product=dws.
//
// A fourth (issue #604 R5): an hourly schedule invokes it with
// `{"mode":"dams-weekly"}` (DAMS_WEEKLY_EVENT, infra/dam_observations.tf), and
// it runs the dam observation passes (dams/observed/): each reads the wanted
// list the worker wrote (dams/wanted.json) and writes its files and status
// into the mirror bucket, for the worker to load into dam_observation, and
// publishes its heartbeat and recency metrics (DamObservations namespace).
//
// Like lambda.ts, this must never import a module that loads dotenv
// (lambda-fetcher.test.ts bundles it to check).
import type { Context, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { z } from 'zod';
import { assertLambdaEnv } from './config/production.js';
import { FEED_SERVER_ERROR_PREFIX, FeedFormatError, FeedRefusedError, FeedServerError, FeedUnavailableError, feedErrorMessage } from './feeds/errors.js';
import { type FetchAnswer, type FetchRequest, runFetch, utcToday } from './feeds/fetch.js';
import { allowLiveFeedRequests, type FeedHttp, feedHttp, feedSourceMode } from './feeds/http.js';
import { DWS_SERVER_ERROR, DWS_SERVER_ERROR_LABEL, dwsFailureLabel } from './feeds/sources/dws.js';
import { type IngestResultMessage, MAX_MESSAGE_BYTES, parseFetchRequest, sendToQueue } from './jobs/transport.js';
import { emitMetricLine, logEvent } from './logging/logEvent.js';
import { safeError } from './logging/safeError.js';

// Refuse to start with a local default, FEED_SOURCE=fixtures above all (config/production.ts).
assertLambdaEnv('fetcher');
// The one Lambda that asks CHC and DWS: every other process refuses a live request on Lambda (feeds/http.ts).
allowLiveFeedRequests();

/** Time kept back from the Lambda's remaining time to send the answer. */
export const FETCH_SEND_MARGIN_MS = 15_000;
/** Without a Lambda context (tests, a local call): the fetch's own budget, the Lambda's timeout (infra/feeds.tf, 900 s) less the margin. */
const DEFAULT_BUDGET_MS = 885_000;

const TOO_SLOW = feedErrorMessage(new FeedUnavailableError('it did not answer in time'));
const INVALID_REQUEST = 'the fetch request was not valid, so nothing was fetched';

const UNAVAILABLE = feedErrorMessage(new FeedUnavailableError(''));
const REFUSED = feedErrorMessage(new FeedRefusedError());
const FORMAT = feedErrorMessage(new FeedFormatError(''));

/** The source's own server error pages, as stored, with the fixed label each logs as its detail (feeds/errors.ts FeedServerError). */
const SERVER_ERRORS: ReadonlyMap<string, string> = new Map([[feedErrorMessage(new FeedServerError(DWS_SERVER_ERROR, DWS_SERVER_ERROR_LABEL)), DWS_SERVER_ERROR_LABEL]]);

/**
 * A failed fetch's error, as a fixed code for the log (feed_fetch_failed): the
 * stored message can name the grid cell or station, so it never goes to a log
 * whole (failureDetail is the part that may). `throttled`: the source
 * answered HTTP 429 or 503 (feeds/errors.ts FeedThrottledError). `refused`:
 * it answered HTTP 403, refusing this server's address (FeedRefusedError).
 * A server error page (FeedServerError: DWS's ScriptServer page) is
 * `unavailable`, its detail saying which page.
 */
export function fetchFailureReason(error: string): 'timeout' | 'throttled' | 'refused' | 'invalid_request' | 'unavailable' | 'format' | 'internal' | 'other' {
	if (error === TOO_SLOW) return 'timeout';
	if (error === INVALID_REQUEST) return 'invalid_request';
	if (error === REFUSED) return 'refused';
	if (error.startsWith(FEED_SERVER_ERROR_PREFIX)) return 'unavailable';
	if (error.startsWith(UNAVAILABLE)) return /^HTTP (429|503)\b/.test(error.slice(UNAVAILABLE.length)) ? 'throttled' : 'unavailable';
	if (error.startsWith(FORMAT)) return 'format';
	if (error === feedErrorMessage(new Error())) return 'internal';
	return 'other';
}

/**
 * The endings of an unavailable fetch's message that name no cell, station or
 * URL: the live client's own (feeds/http.ts) and the fetcher's deadline.
 * Anything else (a forecast's partial issue, a message added later) is left
 * out of the log rather than trusted.
 */
const SAFE_DETAILS: readonly string[] = [
	'the request timed out',
	'the request failed',
	'the response is larger than expected',
	'the source redirected too many times',
	'the source redirected somewhere it may not',
	'the request was refused (not a known source host)',
	'a file changed while it was being read',
	'it did not answer in time'
];
/** The longest detail logged (each above is shorter; the cap guards one added later). */
export const FAILURE_DETAIL_MAX = 80;

/**
 * What of a failed fetch's message may go to the log beside its reason: the
 * HTTP status (`HTTP 429`, `HTTP 403`), one of SAFE_DETAILS, a server error
 * page's label (`ScriptServer error page`), or for a DWS format failure the
 * fixed label of the check that failed (sources/dws.ts DWS_FORMAT_FAILURES:
 * `no data table`, `columns changed`), else null. Never a format error's
 * text, which names grid cells, stations and quotes the page.
 */
export function failureDetail(error: string): string | null {
	if (error === REFUSED) return 'HTTP 403';
	const server = SERVER_ERRORS.get(error);
	if (server) return server;
	if (error.startsWith(FORMAT)) return dwsFailureLabel(error.slice(FORMAT.length));
	if (!error.startsWith(UNAVAILABLE)) return null;
	const rest = error.slice(UNAVAILABLE.length);
	const status = /^HTTP [1-5]\d\d\b/.exec(rest);
	if (status) return status[0];
	return SAFE_DETAILS.includes(rest) && rest.length <= FAILURE_DETAIL_MAX ? rest : null;
}

/** Enough of a fetch message to answer it: the ids the worker routes the answer by. */
const FetchEnvelope = z.object({ v: z.literal(1), type: z.literal('fetch'), fetchJobId: z.string().uuid(), feedId: z.string().uuid(), feedVersion: z.string().max(40) });

function envelope(body: string): z.output<typeof FetchEnvelope> | null {
	if (body.length > MAX_MESSAGE_BYTES) return null;
	try {
		const m = FetchEnvelope.safeParse(JSON.parse(body));
		return m.success ? m.data : null;
	} catch {
		return null;
	}
}

/** `http` that refuses new requests once `deadline` (epoch ms) has passed, so an abandoned fetch stops. */
export function withDeadline(http: FeedHttp, deadline: number): FeedHttp {
	const check = () => {
		if (Date.now() >= deadline) throw new FeedUnavailableError('it did not answer in time');
	};
	return {
		range: async (url, start, end) => (check(), http.range(url, start, end)),
		text: async (url) => (check(), http.text(url)),
		...(http.rangeTagged ? { rangeTagged: async (url: string, start: number, end: number) => (check(), http.rangeTagged!(url, start, end)) } : {}),
		...(http.head ? { head: async (url: string) => (check(), http.head!(url)) } : {})
	};
}

/**
 * runFetch within `ms`. The fetch is told the deadline (its budget): a CHIRPS
 * cell-cache fetch stops starting days short of it and answers with the days
 * it finished, which matters since the live client keeps to about a request a
 * second (feeds/http.ts PACE_*) and a long window no longer fits. Past the
 * deadline itself no new request starts (withDeadline), and a fetch still
 * running is answered as a failure.
 */
async function fetchWithin(req: FetchRequest, http: FeedHttp, ms: number): Promise<FetchAnswer> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<FetchAnswer>((resolve) => {
		timer = setTimeout(() => resolve({ ok: false, error: TOO_SLOW }), Math.max(0, ms));
	});
	const deadline = Date.now() + ms;
	try {
		return await Promise.race([runFetch(req, withDeadline(http, deadline), { stopAt: deadline }), late]);
	} finally {
		clearTimeout(timer);
	}
}

/** The scheduled event that runs the daily ingest (infra/feeds.tf, the daily-ingest rule's input). */
export const DAILY_INGEST_EVENT = { mode: 'daily-ingest' } as const;
export type DailyIngestEvent = typeof DAILY_INGEST_EVENT;

/** Time kept back from the Lambda's remaining time for the daily ingest's last save and its log. */
export const DAILY_SAVE_MARGIN_MS = 20_000;

/** Whether `event` is the daily ingest's scheduled event (and not an SQS batch). */
export function isDailyIngestEvent(event: unknown): event is DailyIngestEvent {
	return typeof event === 'object' && event !== null && !Array.isArray(event) && !('Records' in event) && (event as { mode?: unknown }).mode === DAILY_INGEST_EVENT.mode;
}

// --- The GEFS pass (issue #604 R3-A) ------------------------------------------------------
// `{"mode":"daily-ingest","pass":"gefs"}` (infra/feeds.tf, its own rule, ~08:38 UTC and hourly
// after): the newest complete CHIRPS-GEFS issue into the copy (ingest/gefs.ts). Its own
// invocation, not after the preliminary pass: CHC issues at ~08:30 UTC, and the two passes'
// requests at one a second don't fit one 120 s run.
export const GEFS_INGEST_EVENT = { mode: 'daily-ingest', pass: 'gefs' } as const;
const isGefsPass = (event: DailyIngestEvent) => (event as { pass?: unknown }).pass === GEFS_INGEST_EVENT.pass;

// --- The indices pass (issue #620) --------------------------------------------------------
// `{"mode":"daily-ingest","pass":"indices"}` (infra/feeds.tf, its own daily rule, off until
// climate_indices_enabled): CPC's ONI and AAO files into the copy (ingest/indices.ts). Two
// requests, so it would fit after another pass, but a rule of its own keeps a CPC refusal
// from failing CHC's run and the reverse.
export const INDICES_INGEST_EVENT = { mode: 'daily-ingest', pass: 'indices' } as const;
const isIndicesPass = (event: DailyIngestEvent) => (event as { pass?: unknown }).pass === INDICES_INGEST_EVENT.pass;

/** What an indices pass answers (the schedule ignores it; a manual invoke shows it). */
export interface IndicesIngestAnswer {
	changed: string[];
	through: Record<string, string>;
	lagDays: number | null;
	stopped: string;
}

async function indicesIngest(): Promise<IndicesIngestAnswer> {
	const { runIndicesIngest, indicesLagMetricLine } = await import('./ingest/indices.js');
	const { dailyMirrorUrl, REQUEST_INTERVAL_MS } = await import('./ingest/daily.js');
	const { openStore } = await import('./mirror/store.js');
	const started = Date.now();
	const r = await runIndicesIngest({
		store: openStore(dailyMirrorUrl()),
		http: await feedHttp(),
		today: utcToday(),
		intervalMs: feedSourceMode() === 'live' ? REQUEST_INTERVAL_MS : 0
	});
	if (r.lagDays !== null) emitMetricLine(indicesLagMetricLine(r.lagDays));
	const message = r.error !== null ? feedErrorMessage(r.error) : null;
	// Index ids, months and a reason code, never an upstream body.
	logEvent(message !== null ? 'error' : 'info', {
		event: 'mirror_daily_ingest',
		product: 'indices',
		changed: r.changed,
		unchanged: r.unchanged,
		through: r.through,
		lagDays: r.lagDays,
		stopped: r.stopped,
		requests: r.requests,
		...(message !== null ? { reason: fetchFailureReason(message), detail: failureDetail(message) } : {}),
		ms: Date.now() - started
	});
	if (r.error !== null) throw r.error;
	return { changed: r.changed, through: r.through, lagDays: r.lagDays, stopped: r.stopped };
}

async function gefsIngest(context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<GefsIngestAnswer> {
	const { runGefsIngest, gefsLagMetricLine } = await import('./ingest/gefs.js');
	const { dailyMirrorUrl, REQUEST_INTERVAL_MS } = await import('./ingest/daily.js');
	const { openStore } = await import('./mirror/store.js');
	const started = Date.now();
	const budget = context ? context.getRemainingTimeInMillis() - DAILY_SAVE_MARGIN_MS : DEFAULT_BUDGET_MS;
	const r = await runGefsIngest({
		store: openStore(dailyMirrorUrl()),
		http: await feedHttp(),
		today: utcToday(),
		deadline: started + budget,
		intervalMs: feedSourceMode() === 'live' ? REQUEST_INTERVAL_MS : 0
	});
	if (r.lagDays !== null) emitMetricLine(gefsLagMetricLine(r.lagDays));
	const message = r.error !== null ? feedErrorMessage(r.error) : null;
	// refused_today: CHC refused an earlier run today, so this one asked nothing (ingest/gefs.ts GEFS_REFUSED_KEY).
	logEvent(message !== null ? 'error' : r.stopped === 'refused_today' ? 'warn' : 'info', {
		event: 'mirror_daily_ingest',
		product: 'gefs',
		...(r.refusedAt !== null ? { refusedAt: r.refusedAt } : {}),
		...(r.markerError !== null ? { markerFailed: safeError(r.markerError).error } : {}),
		copied: r.copied,
		partial: r.partial,
		held: r.held.length,
		newest: r.held[0] ?? null,
		deleted: r.deleted.length,
		lagDays: r.lagDays,
		stopped: r.stopped,
		requests: r.requests,
		...(message !== null ? { reason: fetchFailureReason(message), detail: failureDetail(message) } : {}),
		ms: Date.now() - started
	});
	if (r.error !== null) throw r.error;
	return { copied: r.copied, newest: r.held[0] ?? null, lagDays: r.lagDays, stopped: r.stopped };
}

/** What a GEFS pass answers (the schedule ignores it; a manual invoke shows it). */
export interface GefsIngestAnswer {
	copied: string | null;
	newest: string | null;
	lagDays: number | null;
	stopped: string;
}

/** What a daily-ingest invocation answers (the schedule ignores it; a manual invoke shows it). */
export interface DailyIngestAnswer {
	copied: number;
	dropped: number;
	prelimThrough: string | null;
	lagDays: number | null;
	stopped: string;
}

/**
 * One daily ingest run (ingest/daily.ts): the copy MIRROR_URL names, the
 * client FEED_SOURCE names (live in production, the synthetic files locally,
 * where pacing is off). The lag metric goes out whatever happened, then a
 * failure (an HTTP 403 above all) fails the invocation, which is not retried
 * (feeds.tf: the next day's run tries again).
 */
async function dailyIngest(context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<DailyIngestAnswer> {
	// Loaded only for this mode: the per-feed mode never opens the copy.
	const { dailyMirrorUrl, lagMetricLine, REQUEST_INTERVAL_MS, runDailyIngest } = await import('./ingest/daily.js');
	const { openStore } = await import('./mirror/store.js');
	const started = Date.now();
	const budget = context ? context.getRemainingTimeInMillis() - DAILY_SAVE_MARGIN_MS : DEFAULT_BUDGET_MS;
	const r = await runDailyIngest({
		store: openStore(dailyMirrorUrl()),
		http: await feedHttp(),
		today: utcToday(),
		deadline: started + budget,
		intervalMs: feedSourceMode() === 'live' ? REQUEST_INTERVAL_MS : 0
	});
	if (r.lagDays !== null) emitMetricLine(lagMetricLine(r.lagDays));
	const failed = r.error !== null;
	const message = failed ? feedErrorMessage(r.error) : null;
	// Counts, days and a reason code, never an upstream body.
	logEvent(failed ? 'error' : 'info', {
		event: 'mirror_daily_ingest',
		product: 'prelim',
		copied: r.copied.length,
		dropped: r.dropped.length,
		prelimThrough: r.prelimThrough,
		lagDays: r.lagDays,
		stopped: r.stopped,
		requests: r.requests,
		...(message !== null ? { reason: fetchFailureReason(message), detail: failureDetail(message) } : {}),
		ms: Date.now() - started
	});
	if (failed) throw r.error;
	return { copied: r.copied.length, dropped: r.dropped.length, prelimThrough: r.prelimThrough, lagDays: r.lagDays, stopped: r.stopped };
}

// --- The weekly DWS pass (issue #604 R3-B) ---------------------------------------------

/** The scheduled event that runs the weekly DWS pass (infra/feeds.tf, the dws-weekly rule's input). */
export const DWS_WEEKLY_EVENT = { mode: 'dws-weekly' } as const;
export type DwsWeeklyEvent = typeof DWS_WEEKLY_EVENT;

/** Whether `event` is the weekly DWS pass's scheduled event. */
export function isDwsWeeklyEvent(event: unknown): event is DwsWeeklyEvent {
	return typeof event === 'object' && event !== null && !Array.isArray(event) && !('Records' in event) && (event as { mode?: unknown }).mode === DWS_WEEKLY_EVENT.mode;
}

/** What a dws-weekly invocation answers (counts only, never a station). */
export interface DwsWeeklyAnswer {
	fetched: number;
	failed: number;
	fresh: number;
	lagDays: number | null;
	stopped: string;
}

/**
 * One weekly DWS pass (ingest/dws.ts): the bucket MIRROR_URL names, the
 * client FEED_SOURCE names. The lag metric goes out whatever happened, then a
 * stop by DWS (HTTP 403, 429/503, the ScriptServer page) fails the invocation,
 * which is not retried (feeds.tf: next week's run tries again).
 */
async function dwsWeekly(context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<DwsWeeklyAnswer> {
	// Loaded only for this mode.
	const { dwsLagMetricLine, runDwsWeekly } = await import('./ingest/dws.js');
	const { dailyMirrorUrl, REQUEST_INTERVAL_MS } = await import('./ingest/daily.js');
	const { openStore } = await import('./mirror/store.js');
	const started = Date.now();
	const budget = context ? context.getRemainingTimeInMillis() - DAILY_SAVE_MARGIN_MS : DEFAULT_BUDGET_MS;
	const r = await runDwsWeekly({
		store: openStore(dailyMirrorUrl()),
		http: await feedHttp(),
		today: utcToday(),
		deadline: started + budget,
		intervalMs: feedSourceMode() === 'live' ? REQUEST_INTERVAL_MS : 0
	});
	if (r.lagDays !== null) emitMetricLine(dwsLagMetricLine(r.lagDays));
	// Each station skipped this run, and why: its code (a public DWS gauge code, so the operator can look at it) and
	// the fixed reason and check label, never the page's text (failureDetail).
	for (const f of r.failures) {
		const m = feedErrorMessage(f.error);
		logEvent('warn', { event: 'dws_station_failed', station: f.station, reason: fetchFailureReason(m), detail: failureDetail(m) });
	}
	const failed = r.error !== null;
	const message = failed ? feedErrorMessage(r.error) : null;
	// Counts and a reason code, never an upstream body (the stations skipped are logged above, one line each).
	logEvent(failed ? 'error' : r.failed.length ? 'warn' : 'info', {
		event: 'dws_weekly',
		fetched: r.fetched.length,
		failed: r.failed.length,
		fresh: r.fresh,
		lagDays: r.lagDays,
		stopped: r.stopped,
		requests: r.requests,
		...(message !== null ? { reason: fetchFailureReason(message), detail: failureDetail(message) } : {}),
		ms: Date.now() - started
	});
	if (failed) throw r.error;
	return { fetched: r.fetched.length, failed: r.failed.length, fresh: r.fresh, lagDays: r.lagDays, stopped: r.stopped };
}

// --- The dam observation passes (issue #604 R5) -------------------------------------------

/** The scheduled event that runs the dam observation passes (infra/dam_observations.tf, the dams-weekly rule's input). */
export const DAMS_WEEKLY_EVENT = { mode: 'dams-weekly' } as const;
export type DamsWeeklyEvent = typeof DAMS_WEEKLY_EVENT;

/** Whether `event` is the dam passes' scheduled event. */
export function isDamsWeeklyEvent(event: unknown): event is DamsWeeklyEvent {
	return typeof event === 'object' && event !== null && !Array.isArray(event) && !('Records' in event) && (event as { mode?: unknown }).mode === DAMS_WEEKLY_EVENT.mode;
}

/**
 * The share of the run's budget the Waterbodies pass may use: its files are
 * few and frozen upstream (a 304 each, once a week), and the rest is the
 * WOfS pass's, which reads scenes.
 */
export const WATERBODIES_BUDGET_SHARE = 0.3;

/** What one source's pass answers (counts only, never a dam or uid). */
export interface DamPassAnswer {
	fetched: number;
	unchanged: number;
	failed: number;
	fresh: number;
	recencyDays: number | null;
	stopped: string;
}
/** What a dams-weekly invocation answers: each source's pass that ran. */
export type DamsWeeklyAnswer = Partial<Record<'waterbodies' | 'wofs', DamPassAnswer>>;

/**
 * A source paused after its pass stopped on a 403 or throttling (handover.ts
 * pausedUntil): nothing asked, and no heartbeat, so the heartbeat alarm fires
 * (that is the alert, issue #604's rule: a refusal stops and alerts, never a
 * retry). Logged, and not an error: the stopping run already failed.
 */
function pausedAnswer(source: 'waterbodies' | 'wofs', pausedUntil: string | undefined, ms: number): { answer: DamPassAnswer; error: null } {
	logEvent('warn', { event: 'dams_pass', source, stopped: 'paused', pausedUntil: pausedUntil ?? null, ms });
	return { answer: { fetched: 0, unchanged: 0, failed: 0, fresh: 0, recencyDays: null, stopped: 'paused' }, error: null };
}

/** The Waterbodies pass (dams/observed/waterbodies.ts): its metrics whatever happened, then its stop (an HTTP 403, 429/503) as the error. */
async function waterbodiesPass(deadline: number): Promise<{ answer: DamPassAnswer; error: unknown }> {
	const { runWaterbodiesPass, waterbodiesHttp, REQUEST_INTERVAL_MS } = await import('./dams/observed/waterbodies.js');
	const { damPassMetricLine, damsStore } = await import('./dams/observed/handover.js');
	const started = Date.now();
	const mode = feedSourceMode();
	const r = await runWaterbodiesPass({
		store: damsStore(),
		http: await waterbodiesHttp(mode),
		today: utcToday(),
		deadline,
		intervalMs: mode === 'live' ? REQUEST_INTERVAL_MS : 0
	});
	if (r.stopped === 'paused') return pausedAnswer('waterbodies', r.pausedUntil, Date.now() - started);
	// The heartbeat goes out for every completed pass: a stop by the upstream is reported by the error below, not by silence.
	emitMetricLine(damPassMetricLine('waterbodies', r.recencyDays));
	const message = r.error !== null ? feedErrorMessage(r.error) : null;
	// Counts and a reason code, never a uid or an upstream body.
	logEvent(message !== null ? 'error' : r.failed.length ? 'warn' : 'info', {
		event: 'dams_pass',
		source: 'waterbodies',
		fetched: r.fetched.length,
		unchanged: r.unchanged.length,
		failed: r.failed.length,
		fresh: r.fresh,
		recencyDays: r.recencyDays,
		stopped: r.stopped,
		requests: r.requests,
		...(message !== null ? { reason: fetchFailureReason(message), detail: failureDetail(message) } : {}),
		ms: Date.now() - started
	});
	return { answer: { fetched: r.fetched.length, unchanged: r.unchanged.length, failed: r.failed.length, fresh: r.fresh, recencyDays: r.recencyDays, stopped: r.stopped }, error: r.error };
}

/**
 * The WOfS pass (dams/observed/wofs/pass.ts): DE Africa's per-scene water
 * layer summed inside every traced dam's outline. Its metrics whatever
 * happened, then its stop (an HTTP 403, 429/503) as the error. A scene it
 * couldn't read is counted (`sceneFailed`), never named.
 */
async function wofsPass(deadline: number): Promise<{ answer: DamPassAnswer; error: unknown }> {
	const { runWofsPass, STAC_INTERVAL_MS, SCENE_INTERVAL_MS } = await import('./dams/observed/wofs/pass.js');
	const { damPassMetricLine, damsStore } = await import('./dams/observed/handover.js');
	const started = Date.now();
	const mode = feedSourceMode();
	const live = mode === 'live';
	const r = await runWofsPass({
		store: damsStore(),
		http: await feedHttp(mode),
		today: utcToday(),
		deadline,
		stacIntervalMs: live ? STAC_INTERVAL_MS : 0,
		sceneIntervalMs: live ? SCENE_INTERVAL_MS : 0
	});
	if (r.stopped === 'paused') return pausedAnswer('wofs', r.pausedUntil, Date.now() - started);
	emitMetricLine(damPassMetricLine('wofs', r.recencyDays));
	const message = r.error !== null ? feedErrorMessage(r.error) : null;
	const unchanged = Math.max(0, r.turns - r.written.length - r.failures.length);
	// Counts and reason codes, never a dam, an item or an upstream body.
	logEvent(message !== null ? 'error' : r.failures.length || r.sceneFailures.length ? 'warn' : 'info', {
		event: 'dams_pass',
		source: 'wofs',
		fetched: r.written.length,
		unchanged,
		failed: r.failures.length,
		failedCodes: [...new Set(r.failures.map((f) => f.code))],
		sceneFailed: r.sceneFailures.length,
		fresh: r.fresh,
		recencyDays: r.recencyDays,
		stopped: r.stopped,
		stacRequests: r.stacRequests,
		sceneRequests: r.sceneRequests,
		scenesRead: r.scenesRead,
		...(message !== null ? { reason: fetchFailureReason(message), detail: failureDetail(message) } : {}),
		ms: Date.now() - started
	});
	return { answer: { fetched: r.written.length, unchanged, failed: r.failures.length, fresh: r.fresh, recencyDays: r.recencyDays, stopped: r.stopped }, error: r.error };
}

/**
 * One run of the dam observation passes: Waterbodies first (at most
 * WATERBODIES_BUDGET_SHARE of the time), then WOfS. A pass stopped by its
 * upstream doesn't keep the other from running; the invocation fails at the
 * end if either was stopped, and is not retried (dam_observations.tf: the
 * next hour's run tries again). Hourly for the WOfS backfill's sake; each
 * pass keeps its own per-key cadence (a Waterbodies uid weekly, a dam's
 * newest WOfS scenes daily), and a run with nothing due still publishes
 * both heartbeats and recencies. A source whose pass stopped on a 403 or
 * throttling is paused for a day (or a longer Retry-After): its pass asks
 * nothing and publishes no heartbeat, so its heartbeat alarm fires.
 */
async function damsWeekly(context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<DamsWeeklyAnswer> {
	const started = Date.now();
	const budget = context ? context.getRemainingTimeInMillis() - DAILY_SAVE_MARGIN_MS : DEFAULT_BUDGET_MS;
	const answer: DamsWeeklyAnswer = {};
	const errors: unknown[] = [];
	const wb = await waterbodiesPass(started + budget * WATERBODIES_BUDGET_SHARE);
	answer.waterbodies = wb.answer;
	if (wb.error !== null) errors.push(wb.error);
	// WOfS with the rest of the budget.
	const wofs = await wofsPass(started + budget);
	answer.wofs = wofs.answer;
	if (wofs.error !== null) errors.push(wofs.error);
	if (errors.length) throw errors[0];
	return answer;
}

export async function handler(event: SQSEvent, context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<SQSBatchResponse>;
export async function handler(event: DailyIngestEvent, context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<DailyIngestAnswer | GefsIngestAnswer | IndicesIngestAnswer>;
export async function handler(event: DwsWeeklyEvent, context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<DwsWeeklyAnswer>;
export async function handler(event: DamsWeeklyEvent, context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<DamsWeeklyAnswer>;
export async function handler(
	event: SQSEvent | DailyIngestEvent | DwsWeeklyEvent | DamsWeeklyEvent,
	context?: Pick<Context, 'getRemainingTimeInMillis'>
): Promise<SQSBatchResponse | DailyIngestAnswer | GefsIngestAnswer | IndicesIngestAnswer | DwsWeeklyAnswer | DamsWeeklyAnswer> {
	if (isDailyIngestEvent(event)) return isGefsPass(event) ? gefsIngest(context) : isIndicesPass(event) ? indicesIngest() : dailyIngest(context);
	if (isDwsWeeklyEvent(event)) return dwsWeekly(context);
	if (isDamsWeeklyEvent(event)) return damsWeekly(context);
	if (!Array.isArray((event as SQSEvent | undefined)?.Records)) {
		// No mode: nothing to answer, and a retry can't help. Fail loudly (the Errors alarm), naming no payload.
		logEvent('error', { event: 'fetcher_event_unknown' });
		throw new Error('the fetcher was invoked with an event it does not know (expected an SQS batch, {"mode":"daily-ingest"}, {"mode":"dws-weekly"} or {"mode":"dams-weekly"})');
	}
	return fetchBatch(event as SQSEvent, context);
}

async function fetchBatch(event: SQSEvent, context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<SQSBatchResponse> {
	const failures: SQSBatchResponse['batchItemFailures'] = [];
	const http = await feedHttp();
	for (const record of event.Records) {
		const req = parseFetchRequest(record.body);
		let ids: z.output<typeof FetchEnvelope>;
		let result: FetchAnswer;
		const started = Date.now();
		if (req) {
			ids = req;
			const budget = context ? context.getRemainingTimeInMillis() - FETCH_SEND_MARGIN_MS : DEFAULT_BUDGET_MS;
			result = await fetchWithin(req.request, http, budget);
		} else {
			const env = envelope(record.body);
			if (!env) {
				logEvent('warn', { event: 'fetch_request_ignored', messageId: record.messageId });
				continue;
			}
			logEvent('warn', { event: 'fetch_request_invalid', messageId: record.messageId, feedId: env.feedId });
			ids = env;
			result = { ok: false, error: INVALID_REQUEST };
		}
		const message: IngestResultMessage = { v: 1, type: 'ingest', fetchJobId: ids.fetchJobId, feedId: ids.feedId, feedVersion: ids.feedVersion, result };
		try {
			await sendToQueue(process.env.INGEST_RESULTS_QUEUE_URL, 'INGEST_RESULTS_QUEUE_URL', message);
		} catch (err) {
			logEvent('error', { event: 'fetch_result_send_failed', messageId: record.messageId, ...safeError(err) });
			failures.push({ itemIdentifier: record.messageId });
			continue;
		}
		// The answer went back, but it says the fetch failed: the Lambda itself
		// succeeded, so its Errors metric never sees this. One line per failed
		// answer (a retried send logs nothing until it goes through), metric
		// and alarm in infra/feeds.tf. Ids, the source, a reason code and the
		// safe detail (failureDetail: `HTTP 429`, `the request timed out`), never a cell or a station.
		if (!result.ok) {
			logEvent('warn', {
				event: 'feed_fetch_failed',
				feedId: ids.feedId,
				fetchJobId: ids.fetchJobId,
				source: req ? req.request.source : null,
				reason: fetchFailureReason(result.error),
				detail: failureDetail(result.error)
			});
		}
		if (!req) continue;
		// Ids, the source and the outcome only: never the values or an upstream body.
		logEvent('info', {
			event: 'feed_fetched',
			feedId: req.feedId,
			source: req.request.source,
			ok: result.ok,
			// A cell-cache answer: the days it covers, and how many cell-days it read from CHC.
			days: !result.ok ? 0 : 'cells' in result ? result.cells.read.length : result.values.length,
			...(result.ok && 'cells' in result ? { cellDaysRead: result.cells.values.reduce((n, row) => n + row.filter((v) => v !== null).length, 0) } : {}),
			ms: Date.now() - started
		});
	}
	// Only the failed sends are retried (the event source reports partial failures).
	return { batchItemFailures: failures };
}
