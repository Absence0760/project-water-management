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
//     `feed_ingest` job for its feed's acting user (feeds/schedule.ts);
//   * a batch from the SQS `mail-events` queue: SES bounce and complaint
//     events (infra/ses.tf), which flag the address and pause its alert
//     emails (mail/suppression.ts). A record is read as an SES event only
//     when it came from that queue (MAIL_EVENTS_QUEUE_ARN), and one from that
//     queue is never read as a job message: each queue is trusted for its own
//     kind of message only.
// A tick that throws (the database unreachable) fails the SQS batch, so the
// messages are retried and, after 5 receives, land in the DLQ, which alarms.
//
// After each tick it logs the oldest due job's age as a CloudWatch embedded
// metric; infra/jobs.tf alarms when the queue backs up.
//
// Like lambda.ts, this must never import a module that loads dotenv.
import type { Context, ScheduledEvent, SQSEvent, SQSRecord } from 'aws-lambda';
import { assertLambdaEnv } from './config/production.js';
import { runTick, type TickResult } from './jobs/runner.js';
import { acceptIngestResult } from './feeds/schedule.js';
import { acceptMailEvent } from './mail/suppression.js';
import { acceptRenderResult } from './reports/schedule.js';
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
						{ Name: 'JobsFailed', Unit: 'Count' },
						// Alert mails (alerts/send.ts): infra/jobs.tf alarms on a burst (docs/deployment.md § Runbooks, alert storm).
						{ Name: 'AlertMailsSent', Unit: 'Count' },
						{ Name: 'AlertMailsFailed', Unit: 'Count' }
					]
				}
			]
		},
		OldestDueJobAgeSeconds: r.stats.oldestDueSeconds,
		JobsDead: r.dead,
		JobsFailed: r.failed,
		AlertMailsSent: r.alerts.sent,
		AlertMailsFailed: r.alerts.failed
	});
}

// Refuse to start with a local default (config/production.ts).
assertLambdaEnv('worker');

const isSqs = (event: unknown): event is SQSEvent => Array.isArray((event as SQSEvent | undefined)?.Records);

/** Whether a record came from the mail-events queue (and so carries an SES event, and nothing else). */
export const fromMailEventsQueue = (record: Pick<SQSRecord, 'eventSourceARN'>, arn = process.env.MAIL_EVENTS_QUEUE_ARN) => !!arn && record.eventSourceARN === arn;

export const handler = async (event: SQSEvent | ScheduledEvent, context?: Pick<Context, 'getRemainingTimeInMillis'>) => {
	if (isSqs(event)) {
		for (const record of event.Records) {
			// An SES bounce or complaint (mail-events queue). Ids and counts in
			// the log, never an address. A database error throws, failing the batch.
			if (fromMailEventsQueue(record)) {
				const outcome = await acceptMailEvent(record.body);
				if (typeof outcome === 'string') console.warn(JSON.stringify({ event: 'mail_event_dropped', messageId: record.messageId, reason: outcome }));
				else console.log(JSON.stringify({ event: 'mail_suppressed', messageId: record.messageId, reason: outcome.reason, people: outcome.suppressed }));
				continue;
			}
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
			// A render's outcome (render-results queue): becomes a report_render job.
			else if (message.type === 'rendered') {
				const outcome = await acceptRenderResult(message);
				if (outcome !== 'queued') console.warn(JSON.stringify({ event: 'render_result_dropped', messageId: record.messageId, reason: outcome }));
			}
		}
	}
	// Leave a minute for the job already running when the budget runs out.
	const budgetMs = Math.max(10_000, (context?.getRemainingTimeInMillis() ?? 300_000) - 60_000);
	const result = await runTick({ budgetMs });
	console.log(metricLine(result));
	return { claimed: result.claimed, done: result.done, failed: result.failed, dead: result.dead };
};
