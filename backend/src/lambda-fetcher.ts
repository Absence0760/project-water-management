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
// (ingest/gefs.ts, issue #604 R3-A), on its own rule.
//
// Like lambda.ts, this must never import a module that loads dotenv
// (lambda-fetcher.test.ts bundles it to check).
import type { Context, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { z } from 'zod';
import { assertLambdaEnv } from './config/production.js';
import { FEED_SERVER_ERROR_PREFIX, FeedFormatError, FeedRefusedError, FeedServerError, FeedUnavailableError, feedErrorMessage } from './feeds/errors.js';
import { type FetchAnswer, type FetchRequest, runFetch, utcToday } from './feeds/fetch.js';
import { type FeedHttp, feedHttp, feedSourceMode } from './feeds/http.js';
import { DWS_SERVER_ERROR, DWS_SERVER_ERROR_LABEL, dwsFailureLabel } from './feeds/sources/dws.js';
import { type IngestResultMessage, MAX_MESSAGE_BYTES, parseFetchRequest, sendToQueue } from './jobs/transport.js';
import { emitMetricLine, logEvent } from './logging/logEvent.js';
import { safeError } from './logging/safeError.js';

// Refuse to start with a local default, FEED_SOURCE=fixtures above all (config/production.ts).
assertLambdaEnv('fetcher');

/** Time kept back from the Lambda's remaining time to send the answer. */
export const FETCH_SEND_MARGIN_MS = 15_000;
/** Without a Lambda context (tests, a local call): the fetch's own budget. */
const DEFAULT_BUDGET_MS = 100_000;

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

/** runFetch, answered as a failure if it hasn't finished within `ms`. */
async function fetchWithin(req: FetchRequest, http: FeedHttp, ms: number): Promise<FetchAnswer> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<FetchAnswer>((resolve) => {
		timer = setTimeout(() => resolve({ ok: false, error: TOO_SLOW }), Math.max(0, ms));
	});
	try {
		return await Promise.race([runFetch(req, withDeadline(http, Date.now() + ms)), late]);
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
	logEvent(message !== null ? 'error' : 'info', {
		event: 'mirror_daily_ingest',
		product: 'gefs',
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

export async function handler(event: SQSEvent, context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<SQSBatchResponse>;
export async function handler(event: DailyIngestEvent, context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<DailyIngestAnswer | GefsIngestAnswer>;
export async function handler(event: SQSEvent | DailyIngestEvent, context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<SQSBatchResponse | DailyIngestAnswer | GefsIngestAnswer> {
	if (isDailyIngestEvent(event)) return isGefsPass(event) ? gefsIngest(context) : dailyIngest(context);
	if (!Array.isArray((event as SQSEvent | undefined)?.Records)) {
		// Neither mode: nothing to answer, and a retry can't help. Fail loudly (the Errors alarm), naming no payload.
		logEvent('error', { event: 'fetcher_event_unknown' });
		throw new Error('the fetcher was invoked with an event it does not know (expected an SQS batch or {"mode":"daily-ingest"})');
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
