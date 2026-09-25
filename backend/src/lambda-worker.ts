// Worker Lambda — the production job worker (JOB_TRANSPORT=sqs;
// docs/deployment.md § Background jobs, infra/jobs.tf).
//
// Invoked three ways, and each runs the same tick (jobs/runner.ts) against the
// job table, which is the source of truth:
//   * the EventBridge schedule, every 5 minutes: runs whatever is due, and
//     catches any job whose wake message was lost;
//   * a batch from the SQS `jobs` queue: wake messages the API sends after
//     enqueueing (jobs/transport.ts), so a job needn't wait for the schedule;
//   * a batch from the SQS `ingest-results` queue: a data feed's fetch result
//     from the fetcher Lambda (lambda-fetcher.ts), each queued as a
//     `feed_ingest` job for its feed's acting user (feeds/schedule.ts).
// A tick that throws (the database unreachable) fails the SQS batch, so the
// messages are retried and, after 5 receives, land in the DLQ, which alarms.
//
// After each tick it logs the oldest due job's age as a CloudWatch embedded
// metric; infra/jobs.tf alarms when the queue backs up.
//
// Like lambda.ts, this must never import a module that loads dotenv.
import type { Context, ScheduledEvent, SQSEvent } from 'aws-lambda';
import { runTick, type TickResult } from './jobs/runner.js';
import { acceptIngestResult } from './feeds/schedule.js';
import { parseWorkerMessage } from './jobs/transport.js';

/** CloudWatch namespace of the worker's embedded metrics (infra/jobs.tf alarm). */
export const METRIC_NAMESPACE = 'water-management/Jobs';

/** An Embedded Metric Format log line: CloudWatch turns it into metrics, no PutMetricData needed. */
export function metricLine(r: TickResult, now = Date.now()): string {
	return JSON.stringify({
		_aws: {
			Timestamp: now,
			CloudWatchMetrics: [
				{
					Namespace: METRIC_NAMESPACE,
					Dimensions: [[]],
					Metrics: [
						{ Name: 'OldestDueJobAgeSeconds', Unit: 'Seconds' },
						{ Name: 'JobsDead', Unit: 'Count' },
						{ Name: 'JobsFailed', Unit: 'Count' }
					]
				}
			]
		},
		OldestDueJobAgeSeconds: r.stats.oldestDueSeconds,
		JobsDead: r.dead,
		JobsFailed: r.failed
	});
}

const isSqs = (event: unknown): event is SQSEvent => Array.isArray((event as SQSEvent | undefined)?.Records);

export const handler = async (event: SQSEvent | ScheduledEvent, context?: Pick<Context, 'getRemainingTimeInMillis'>) => {
	if (isSqs(event)) {
		for (const record of event.Records) {
			const message = parseWorkerMessage(record.body);
			// An unknown message is dropped (logged), never retried into the DLQ:
			// it can't become valid on a retry.
			if (!message) console.warn(JSON.stringify({ event: 'job_message_ignored', messageId: record.messageId }));
			// A fetch result (ingest-results queue): becomes a feed_ingest job,
			// which the tick below runs. A database error throws, failing the batch.
			else if (message.type === 'ingest') {
				const outcome = await acceptIngestResult(message);
				if (outcome !== 'queued') console.warn(JSON.stringify({ event: 'feed_result_dropped', messageId: record.messageId, reason: outcome }));
			}
		}
	}
	// Leave a minute for the job already running when the budget runs out.
	const budgetMs = Math.max(10_000, (context?.getRemainingTimeInMillis() ?? 300_000) - 60_000);
	const result = await runTick({ budgetMs });
	console.log(metricLine(result));
	return { claimed: result.claimed, done: result.done, failed: result.failed, dead: result.dead };
};
