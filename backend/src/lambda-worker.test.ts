import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TickResult } from './jobs/runner.js';

const tick: TickResult = { purged: 1, invitesPurged: 0, claimed: 3, done: 1, failed: 1, dead: 1, lost: 0, stats: { due: 2, running: 0, oldestDueSeconds: 420 },
	alerts: { scheduled: 0, purged: 0, sent: 7, skipped: 1, failed: 2, digests: 1 }
};
const runTick = vi.fn(async (_o?: unknown) => tick);
vi.mock('./jobs/runner.js', () => ({ runTick: (o: unknown) => runTick(o) }));
const acceptIngestResult = vi.fn(async (_m: unknown) => 'queued' as string);
vi.mock('./feeds/schedule.js', () => ({ acceptIngestResult: (m: unknown) => acceptIngestResult(m) }));
const acceptRenderResult = vi.fn(async (_m: unknown) => 'queued' as string);
vi.mock('./reports/schedule.js', () => ({ acceptRenderResult: (m: unknown) => acceptRenderResult(m) }));
const acceptMailEvent = vi.fn(async (_b: string): Promise<unknown> => ({ reason: 'bounce', suppressed: 1 }));
vi.mock('./mail/suppression.js', () => ({ acceptMailEvent: (b: string) => acceptMailEvent(b) }));

const { handler, metricLine, METRIC_NAMESPACE } = await import('./lambda-worker.js');

afterEach(() => {
	runTick.mockClear();
	vi.restoreAllMocks();
});

describe('metricLine', () => {
	it('is an Embedded Metric Format line with the oldest due job age (the backlog alarm reads it)', () => {
		const line = JSON.parse(metricLine(tick, 1_700_000_000_000));
		expect(line._aws.Timestamp).toBe(1_700_000_000_000);
		expect(line._aws.CloudWatchMetrics[0].Namespace).toBe(METRIC_NAMESPACE);
		expect(METRIC_NAMESPACE).toBe('water-management/Jobs');
		expect(line._aws.CloudWatchMetrics[0].Metrics.map((m: { Name: string }) => m.Name)).toEqual(['OldestDueJobAgeSeconds', 'JobsDead', 'JobsFailed', 'AlertMailsSent', 'AlertMailsFailed']);
		expect(line).toMatchObject({ OldestDueJobAgeSeconds: 420, JobsDead: 1, JobsFailed: 1, AlertMailsSent: 7, AlertMailsFailed: 2 });
	});
});

describe('handler', () => {
	it('runs a tick on the EventBridge schedule, within the time left', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const res = await handler({ source: 'aws.events', 'detail-type': 'Scheduled Event' } as never, { getRemainingTimeInMillis: () => 300_000 });
		expect(runTick).toHaveBeenCalledWith({ budgetMs: 240_000 });
		expect(res).toEqual({ claimed: 3, done: 1, failed: 1, dead: 1 });
	});

	it('runs one tick for an SQS batch, and drops (logs) messages it does not understand', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const records = [
			{ messageId: 'm1', body: JSON.stringify({ v: 1, type: 'wake', jobId: '00000000-0000-4000-8000-000000000000' }) },
			{ messageId: 'm2', body: 'garbage' }
		];
		await handler({ Records: records } as never, { getRemainingTimeInMillis: () => 30_000 });
		expect(runTick).toHaveBeenCalledTimes(1);
		// Never less than 10 s of budget.
		expect(runTick).toHaveBeenCalledWith({ budgetMs: 10_000 });
		expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'job_message_ignored', messageId: 'm2' }));
	});

	it('queues each ingest-results message as a feed_ingest job before the tick, and logs one it drops', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const msg = {
			v: 1,
			type: 'ingest',
			fetchJobId: '00000000-0000-4000-8000-000000000002',
			feedId: '00000000-0000-4000-8000-000000000003',
			feedVersion: 'v1',
			result: { ok: true, startDate: '2026-01-01', values: [1], meta: {} }
		};
		acceptIngestResult.mockResolvedValueOnce('queued').mockResolvedValueOnce('unknown_fetch');
		await handler({ Records: [{ messageId: 'm1', body: JSON.stringify(msg) }, { messageId: 'm2', body: JSON.stringify(msg) }] } as never);
		expect(acceptIngestResult).toHaveBeenCalledTimes(2);
		expect(acceptIngestResult).toHaveBeenCalledWith(msg);
		expect(runTick).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'feed_result_dropped', messageId: 'm2', reason: 'unknown_fetch' }));
		acceptIngestResult.mockClear();
	});

	it('queues each render-results message as a report_render job before the tick, and logs one it drops', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const msg = { v: 1, type: 'rendered', reportId: '00000000-0000-4000-8000-000000000004', result: { ok: true, pages: 9, bytes: 1000, ms: 4000 } };
		acceptRenderResult.mockResolvedValueOnce('queued').mockResolvedValueOnce('unknown_report');
		await handler({ Records: [{ messageId: 'm1', body: JSON.stringify(msg) }, { messageId: 'm2', body: JSON.stringify(msg) }] } as never);
		expect(acceptRenderResult).toHaveBeenCalledTimes(2);
		expect(acceptRenderResult).toHaveBeenCalledWith(msg);
		expect(runTick).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'render_result_dropped', messageId: 'm2', reason: 'unknown_report' }));
		acceptRenderResult.mockClear();
	});

	it('fails the batch when an ingest result can’t be queued (database down), so SQS retries it', async () => {
		acceptIngestResult.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
		const body = JSON.stringify({ v: 1, type: 'ingest', fetchJobId: '00000000-0000-4000-8000-000000000002', feedId: '00000000-0000-4000-8000-000000000003', feedVersion: 'v1', result: {} });
		await expect(handler({ Records: [{ messageId: 'm1', body }] } as never)).rejects.toThrow('ECONNREFUSED');
		expect(runTick).not.toHaveBeenCalled();
		acceptIngestResult.mockClear();
	});

	describe('the mail-events queue (SES bounces and complaints)', () => {
		const MAIL_ARN = 'arn:aws:sqs:af-south-1:000000000000:water-management-mail-events';
		const JOBS_ARN = 'arn:aws:sqs:af-south-1:000000000000:water-management-jobs';
		const ses = JSON.stringify({ eventType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'a@example.com' }] } });
		afterEach(() => {
			vi.unstubAllEnvs();
			acceptMailEvent.mockClear();
			acceptIngestResult.mockClear();
		});

		it('applies a record from the mail-events queue as an SES event, and logs counts, never the address', async () => {
			vi.stubEnv('MAIL_EVENTS_QUEUE_ARN', MAIL_ARN);
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			await handler({ Records: [{ messageId: 'm1', eventSourceARN: MAIL_ARN, body: ses }] } as never);
			expect(acceptMailEvent).toHaveBeenCalledWith(ses);
			expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'mail_suppressed', messageId: 'm1', reason: 'bounce', people: 1 }));
			expect(log.mock.calls.flat().join('\n')).not.toContain('a@example.com');
			expect(runTick).toHaveBeenCalledTimes(1);
		});

		it('trusts only its queue: an SES-shaped message on another queue is never applied (positive control above)', async () => {
			vi.stubEnv('MAIL_EVENTS_QUEUE_ARN', MAIL_ARN);
			vi.spyOn(console, 'log').mockImplementation(() => {});
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			await handler({ Records: [{ messageId: 'm1', eventSourceARN: JOBS_ARN, body: ses }] } as never);
			expect(acceptMailEvent).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'job_message_ignored', messageId: 'm1' }));
		});

		it('with no mail-events queue configured, nothing is read as an SES event (local and tests)', async () => {
			vi.stubEnv('MAIL_EVENTS_QUEUE_ARN', '');
			vi.spyOn(console, 'log').mockImplementation(() => {});
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			await handler({ Records: [{ messageId: 'm1', eventSourceARN: '', body: ses }] } as never);
			expect(acceptMailEvent).not.toHaveBeenCalled();
		});

		it('never reads a job message that arrives on the mail-events queue as one (it is logged and dropped)', async () => {
			vi.stubEnv('MAIL_EVENTS_QUEUE_ARN', MAIL_ARN);
			vi.spyOn(console, 'log').mockImplementation(() => {});
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			acceptMailEvent.mockResolvedValueOnce('invalid');
			const ingest = JSON.stringify({ v: 1, type: 'ingest', fetchJobId: '00000000-0000-4000-8000-000000000002', feedId: '00000000-0000-4000-8000-000000000003', feedVersion: 'v1', result: {} });
			await handler({ Records: [{ messageId: 'm1', eventSourceARN: MAIL_ARN, body: ingest }] } as never);
			expect(acceptIngestResult).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'mail_event_dropped', messageId: 'm1', reason: 'invalid' }));
		});

		it('fails the batch when the database is down, so SQS retries the event', async () => {
			vi.stubEnv('MAIL_EVENTS_QUEUE_ARN', MAIL_ARN);
			acceptMailEvent.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
			await expect(handler({ Records: [{ messageId: 'm1', eventSourceARN: MAIL_ARN, body: ses }] } as never)).rejects.toThrow('ECONNREFUSED');
			expect(runTick).not.toHaveBeenCalled();
		});
	});

	describe('partial batch failures (ReportBatchItemFailures)', () => {
		const ingest = (n: number) =>
			JSON.stringify({ v: 1, type: 'ingest', fetchJobId: `00000000-0000-4000-8000-00000000000${n}`, feedId: '00000000-0000-4000-8000-000000000003', feedVersion: 'v1', result: {} });
		const wake = JSON.stringify({ v: 1, type: 'wake', jobId: '00000000-0000-4000-8000-000000000000' });
		afterEach(() => acceptIngestResult.mockReset().mockResolvedValue('queued'));

		it('answers an all-good batch with no failures', async () => {
			vi.spyOn(console, 'log').mockImplementation(() => {});
			const res = await handler({ Records: [{ messageId: 'm1', body: wake }, { messageId: 'm2', body: ingest(1) }] } as never);
			expect(res).toEqual({ batchItemFailures: [] });
		});

		it('reports only the record that threw, still handles the rest, and runs the tick', async () => {
			vi.spyOn(console, 'log').mockImplementation(() => {});
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			acceptIngestResult.mockResolvedValueOnce('queued').mockRejectedValueOnce(new Error('deadlock detected')).mockResolvedValueOnce('queued');
			const res = await handler({
				Records: [
					{ messageId: 'm1', body: ingest(1) },
					{ messageId: 'm2', body: ingest(2) },
					{ messageId: 'm3', body: ingest(4) },
					{ messageId: 'm4', body: wake }
				]
			} as never);
			expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }] });
			expect(acceptIngestResult).toHaveBeenCalledTimes(3);
			expect(runTick).toHaveBeenCalledTimes(1);
			expect(error).toHaveBeenCalledWith(JSON.stringify({ event: 'worker_record_failed', messageId: 'm2', error: 'deadlock detected' }));
		});

		it('never reports a dropped record (unknown message, or a result for an unknown fetch): a retry cannot fix it', async () => {
			vi.spyOn(console, 'log').mockImplementation(() => {});
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			vi.spyOn(console, 'error').mockImplementation(() => {});
			acceptIngestResult.mockResolvedValueOnce('unknown_fetch').mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
			const res = await handler({
				Records: [
					{ messageId: 'm1', body: 'garbage' },
					{ messageId: 'm2', body: ingest(1) },
					{ messageId: 'm3', body: ingest(2) }
				]
			} as never);
			expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm3' }] });
		});

		it('fails the whole batch, without a tick, when every record threw (the database is down)', async () => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			acceptIngestResult.mockRejectedValueOnce(new Error('connect ECONNREFUSED')).mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
			await expect(handler({ Records: [{ messageId: 'm1', body: ingest(1) }, { messageId: 'm2', body: ingest(2) }] } as never)).rejects.toThrow('ECONNREFUSED');
			expect(runTick).not.toHaveBeenCalled();
		});

		it('still fails the whole batch when the tick throws after a partial failure', async () => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			acceptIngestResult.mockRejectedValueOnce(new Error('deadlock detected'));
			runTick.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
			await expect(handler({ Records: [{ messageId: 'm1', body: ingest(1) }, { messageId: 'm2', body: wake }] } as never)).rejects.toThrow('ECONNREFUSED');
		});
	});

	it('lets a failed tick throw, so SQS retries the batch (and dead-letters it after 5)', async () => {
		runTick.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
		await expect(handler({ Records: [] } as never)).rejects.toThrow('ECONNREFUSED');
	});
});
