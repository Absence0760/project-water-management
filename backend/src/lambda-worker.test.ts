import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TickResult } from './jobs/runner.js';

const tick: TickResult = { purged: 1, invitesPurged: 0, claimed: 3, done: 1, failed: 1, dead: 1, lost: 0, stats: { due: 2, running: 0, oldestDueSeconds: 420 } };
const runTick = vi.fn(async (_o?: unknown) => tick);
vi.mock('./jobs/runner.js', () => ({ runTick: (o: unknown) => runTick(o) }));
const acceptIngestResult = vi.fn(async (_m: unknown) => 'queued' as string);
vi.mock('./feeds/schedule.js', () => ({ acceptIngestResult: (m: unknown) => acceptIngestResult(m) }));
const acceptRenderResult = vi.fn(async (_m: unknown) => 'queued' as string);
vi.mock('./reports/schedule.js', () => ({ acceptRenderResult: (m: unknown) => acceptRenderResult(m) }));

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
		expect(line._aws.CloudWatchMetrics[0].Metrics.map((m: { Name: string }) => m.Name)).toEqual(['OldestDueJobAgeSeconds', 'JobsDead', 'JobsFailed']);
		expect(line).toMatchObject({ OldestDueJobAgeSeconds: 420, JobsDead: 1, JobsFailed: 1 });
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

	it('lets a failed tick throw, so SQS retries the batch (and dead-letters it after 5)', async () => {
		runTick.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
		await expect(handler({ Records: [] } as never)).rejects.toThrow('ECONNREFUSED');
	});
});
