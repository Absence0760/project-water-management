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
// Like lambda.ts, this must never import a module that loads dotenv
// (lambda-fetcher.test.ts bundles it to check).
import type { Context, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { z } from 'zod';
import { assertLambdaEnv } from './config/production.js';
import { FeedUnavailableError, feedErrorMessage } from './feeds/errors.js';
import { type FetchRequest, type FetchResult, runFetch } from './feeds/fetch.js';
import { type FeedHttp, feedHttp } from './feeds/http.js';
import { type IngestResultMessage, MAX_MESSAGE_BYTES, parseFetchRequest, sendToQueue } from './jobs/transport.js';

// Refuse to start with a local default, FEED_SOURCE=fixtures above all (config/production.ts).
assertLambdaEnv('fetcher');

/** Time kept back from the Lambda's remaining time to send the answer. */
export const FETCH_SEND_MARGIN_MS = 15_000;
/** Without a Lambda context (tests, a local call): the fetch's own budget. */
const DEFAULT_BUDGET_MS = 100_000;

const TOO_SLOW = feedErrorMessage(new FeedUnavailableError('it did not answer in time'));
const INVALID_REQUEST = 'the fetch request was not valid, so nothing was fetched';

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
		text: async (url) => (check(), http.text(url))
	};
}

/** runFetch, answered as a failure if it hasn't finished within `ms`. */
async function fetchWithin(req: FetchRequest, http: FeedHttp, ms: number): Promise<FetchResult> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<FetchResult>((resolve) => {
		timer = setTimeout(() => resolve({ ok: false, error: TOO_SLOW }), Math.max(0, ms));
	});
	try {
		return await Promise.race([runFetch(req, withDeadline(http, Date.now() + ms)), late]);
	} finally {
		clearTimeout(timer);
	}
}

export const handler = async (event: SQSEvent, context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<SQSBatchResponse> => {
	const failures: SQSBatchResponse['batchItemFailures'] = [];
	const http = await feedHttp();
	for (const record of event.Records) {
		const req = parseFetchRequest(record.body);
		let ids: z.output<typeof FetchEnvelope>;
		let result: FetchResult;
		const started = Date.now();
		if (req) {
			ids = req;
			const budget = context ? context.getRemainingTimeInMillis() - FETCH_SEND_MARGIN_MS : DEFAULT_BUDGET_MS;
			result = await fetchWithin(req.request, http, budget);
		} else {
			const env = envelope(record.body);
			if (!env) {
				console.warn(JSON.stringify({ event: 'fetch_request_ignored', messageId: record.messageId }));
				continue;
			}
			console.warn(JSON.stringify({ event: 'fetch_request_invalid', messageId: record.messageId, feedId: env.feedId }));
			ids = env;
			result = { ok: false, error: INVALID_REQUEST };
		}
		const message: IngestResultMessage = { v: 1, type: 'ingest', fetchJobId: ids.fetchJobId, feedId: ids.feedId, feedVersion: ids.feedVersion, result };
		try {
			await sendToQueue(process.env.INGEST_RESULTS_QUEUE_URL, 'INGEST_RESULTS_QUEUE_URL', message);
		} catch (err) {
			console.error(JSON.stringify({ event: 'fetch_result_send_failed', messageId: record.messageId, error: (err as Error).message }));
			failures.push({ itemIdentifier: record.messageId });
			continue;
		}
		if (!req) continue;
		// Ids, the source and the outcome only: never the values or an upstream body.
		console.log(
			JSON.stringify({
				event: 'feed_fetched',
				feedId: req.feedId,
				source: req.request.source,
				ok: result.ok,
				days: result.ok ? result.values.length : 0,
				ms: Date.now() - started
			})
		);
	}
	// Only the failed sends are retried (the event source reports partial failures).
	return { batchItemFailures: failures };
};
