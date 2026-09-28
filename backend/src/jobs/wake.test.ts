import { afterEach, describe, expect, it, vi } from 'vitest';
import { jobTransport, wakeWorker } from './wake.js';

afterEach(() => vi.unstubAllEnvs());

describe('jobTransport', () => {
	it('defaults to inprocess (local-first)', () => {
		expect(jobTransport(undefined)).toBe('inprocess');
		expect(jobTransport('')).toBe('inprocess');
		expect(jobTransport('  ')).toBe('inprocess');
	});

	it('accepts the three transports and refuses anything else', () => {
		for (const t of ['inprocess', 'memory', 'sqs'] as const) expect(jobTransport(t)).toBe(t);
		expect(() => jobTransport('localstack')).toThrow(/unknown JOB_TRANSPORT "localstack"/);
	});
});

describe('wakeWorker', () => {
	it('never throws: a failed wake-up is logged (the tick runs the job later)', async () => {
		vi.stubEnv('JOB_TRANSPORT', 'sqs');
		vi.stubEnv('JOBS_QUEUE_URL', '');
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(wakeWorker('00000000-0000-4000-8000-000000000000')).resolves.toBeUndefined();
		expect(spy).toHaveBeenCalledWith(expect.stringContaining('waking the job worker failed'), 'JOBS_QUEUE_URL is not set');
		spy.mockRestore();
	});

	it('does nothing for inprocess (the insert trigger NOTIFYs the worker)', async () => {
		vi.stubEnv('JOB_TRANSPORT', 'inprocess');
		const spy = vi.spyOn(console, 'error');
		await wakeWorker('00000000-0000-4000-8000-000000000000');
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});
