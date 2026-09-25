import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TickResult } from './jobs/runner.js';

const tick: TickResult = { purged: 1, claimed: 3, done: 1, failed: 1, dead: 1, lost: 0, stats: { due: 2, running: 0, oldestDueSeconds: 420 } };
const runTick = vi.fn(async (_o?: unknown) => tick);
vi.mock('./jobs/runner.js', () => ({ runTick: (o: unknown) => runTick(o) }));

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

	it('lets a failed tick throw, so SQS retries the batch (and dead-letters it after 5)', async () => {
		runTick.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
		await expect(handler({ Records: [] } as never)).rejects.toThrow('ECONNREFUSED');
	});
});
