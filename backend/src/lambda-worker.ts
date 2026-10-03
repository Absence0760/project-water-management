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
// Each SQS record is handled on its own. One that throws (a database error
// while queueing it) is reported back as a batch item failure
// (ReportBatchItemFailures on every worker trigger, infra/), so SQS retries
// that record alone and, after 5 receives, puts it in the DLQ, which alarms;
// the rest of the batch is done with. A record that can never succeed (an
// unknown message, a result for an unknown fetch or report) is logged and
// dropped, never retried. When every record in the batch threw, the database
// is almost certainly down: the handler throws the first error without running
// the tick, and the whole batch is retried. A tick that throws fails the whole
// batch the same way.
//
// After each tick it logs the oldest due job's age as a CloudWatch embedded
// metric; infra/jobs.tf alarms when the queue backs up.
//
// Like lambda.ts, this must never import a module that loads dotenv.
import type { Context, ScheduledEvent, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { assertLambdaEnv } from './config/production.js';
import { loadRuntimeSecrets } from './config/runtimeSecrets.js';
import { runTick, type TickResult } from './jobs/runner.js';
import { acceptIngestResult } from './feeds/schedule.js';
import { acceptMailEvent } from './mail/suppression.js';
import { acceptPackRenderResult, acceptRenderResult } from './reports/schedule.js';
import { parseWorkerMessage } from './jobs/transport.js';
import { emitMetricLine, logEvent } from './logging/logEvent.js';
import { safeError } from './logging/safeError.js';

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

// The secrets first, once per cold start (config/runtimeSecrets.ts, as in
// lambda.ts), then refuse to start with a local default (config/production.ts).
await loadRuntimeSecrets('worker');
assertLambdaEnv('worker');

const isSqs = (event: unknown): event is SQSEvent => Array.isArray((event as SQSEvent | undefined)?.Records);

/** Whether a record came from the mail-events queue (and so carries an SES event, and nothing else). */
export const fromMailEventsQueue = (record: Pick<SQSRecord, 'eventSourceARN'>, arn = process.env.MAIL_EVENTS_QUEUE_ARN) => !!arn && record.eventSourceARN === arn;

/** Handle one SQS record. Throws only when it should be retried (a database error). */
async function acceptRecord(record: SQSRecord): Promise<void> {
	// An SES bounce or complaint (mail-events queue). Ids and counts in the
	// log, never an address.
	if (fromMailEventsQueue(record)) {
		const outcome = await acceptMailEvent(record.body);
		if (typeof outcome === 'string') logEvent('warn', { event: 'mail_event_dropped', messageId: record.messageId, reason: outcome });
		else logEvent('info', { event: 'mail_suppressed', messageId: record.messageId, reason: outcome.reason, people: outcome.suppressed });
		return;
	}
	const message = parseWorkerMessage(record.body);
	// An unknown message is dropped (logged), never retried into the DLQ:
	// it can't become valid on a retry.
	if (!message) logEvent('warn', { event: 'job_message_ignored', messageId: record.messageId });
	// A fetch result (ingest-results queue): becomes a feed_ingest job, which
	// the tick runs.
	else if (message.type === 'ingest') {
		const outcome = await acceptIngestResult(message);
		if (outcome !== 'queued') logEvent('warn', { event: 'feed_result_dropped', messageId: record.messageId, reason: outcome });
	}
	// A render's outcome (render-results queue): becomes a report_render job.
	else if (message.type === 'rendered') {
		const outcome = await acceptRenderResult(message);
		if (outcome !== 'queued') logEvent('warn', { event: 'render_result_dropped', messageId: record.messageId, reason: outcome });
	}
	// An evidence pack's render outcome (render-results queue): becomes a pack_render job.
	else if (message.type === 'rendered_pack') {
		const outcome = await acceptPackRenderResult(message);
		if (outcome !== 'queued') logEvent('warn', { event: 'pack_render_result_dropped', messageId: record.messageId, reason: outcome });
	}
	// A wake message needs nothing of its own: the tick below runs the job.
}

type TickSummary = { claimed: number; done: number; failed: number; dead: number };

export async function handler(event: SQSEvent, context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<SQSBatchResponse>;
export async function handler(event: ScheduledEvent, context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<TickSummary>;
export async function handler(event: SQSEvent | ScheduledEvent, context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<SQSBatchResponse | TickSummary> {
	const failures: SQSBatchResponse['batchItemFailures'] = [];
	if (isSqs(event)) {
		let firstError: unknown;
		for (const record of event.Records) {
			try {
				await acceptRecord(record);
			} catch (err) {
				firstError ??= err;
				failures.push({ itemIdentifier: record.messageId });
				// Name and code only (safeError): a pg error's text can quote a value, and a mail event's record names an address.
				logEvent('error', { event: 'worker_record_failed', messageId: record.messageId, ...safeError(err) });
			}
		}
		// Every record failed: the database is down, and so would the tick be.
		// Fail the whole batch, as before partial failures were reported.
		if (failures.length > 0 && failures.length === event.Records.length) throw firstError;
	}
	// Leave a minute for the job already running when the budget runs out.
	const budgetMs = Math.max(10_000, (context?.getRemainingTimeInMillis() ?? 300_000) - 60_000);
	const result = await runTick({ budgetMs });
	emitMetricLine(metricLine(result));
	// An SQS invocation answers with the records to retry (an empty list: none).
	if (isSqs(event)) return { batchItemFailures: failures };
	return { claimed: result.claimed, done: result.done, failed: result.failed, dead: result.dead };
}
