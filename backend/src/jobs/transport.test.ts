import { afterEach, describe, expect, it, vi } from 'vitest';
import { jobTransport, parseWorkerMessage, wakeMessage, wakeWorker } from './transport.js';

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

describe('the SQS message shape', () => {
	it('carries a version, a type and the job id, nothing else', () => {
		const id = '00000000-0000-4000-8000-000000000000';
		expect(wakeMessage(id)).toEqual({ v: 1, type: 'wake', jobId: id });
		expect(JSON.parse(JSON.stringify(wakeMessage(id)))).toEqual({ v: 1, type: 'wake', jobId: id });
	});

	it('round-trips, and rejects anything it does not understand', () => {
		const id = '00000000-0000-4000-8000-000000000001';
		expect(parseWorkerMessage(JSON.stringify(wakeMessage(id)))).toEqual(wakeMessage(id));
		// Extra fields are dropped, not passed on.
		expect(parseWorkerMessage(JSON.stringify({ ...wakeMessage(id), payload: { x: 1 } }))).toEqual(wakeMessage(id));
		for (const body of ['not json', 'null', '{}', JSON.stringify({ v: 2, type: 'wake', jobId: id }), JSON.stringify({ v: 1, type: 'fetch', jobId: id }), JSON.stringify({ v: 1, type: 'wake', jobId: 7 })]) {
			expect(parseWorkerMessage(body)).toBeNull();
		}
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
