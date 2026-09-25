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
// A request it can't parse is dropped (logged): a retry can't fix it. A
// failed send throws, so SQS retries the message and, after 5 receives,
// dead-letters it (alarmed).
//
// Like lambda.ts, this must never import a module that loads dotenv.
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { runFetch } from './feeds/fetch.js';
import { feedHttp } from './feeds/http.js';
import { type IngestResultMessage, parseFetchRequest, sendToQueue } from './jobs/transport.js';

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
	const failures: SQSBatchResponse['batchItemFailures'] = [];
	const http = await feedHttp();
	for (const record of event.Records) {
		const req = parseFetchRequest(record.body);
		if (!req) {
			console.warn(JSON.stringify({ event: 'fetch_request_ignored', messageId: record.messageId }));
			continue;
		}
		const started = Date.now();
		const result = await runFetch(req.request, http);
		const message: IngestResultMessage = { v: 1, type: 'ingest', fetchJobId: req.fetchJobId, feedId: req.feedId, feedVersion: req.feedVersion, result };
		try {
			await sendToQueue(process.env.INGEST_RESULTS_QUEUE_URL, 'INGEST_RESULTS_QUEUE_URL', message);
		} catch (err) {
			console.error(JSON.stringify({ event: 'fetch_result_send_failed', messageId: record.messageId, error: (err as Error).message }));
			failures.push({ itemIdentifier: record.messageId });
			continue;
		}
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
