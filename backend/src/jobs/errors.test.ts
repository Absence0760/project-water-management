import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError } from '../http/errors.js';
import { describeFailure, JOB_ERROR_MAX, JobError } from './errors.js';

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

describe('describeFailure', () => {
	it('keeps our own messages, and their retry decision', () => {
		expect(describeFailure(new JobError('source unreachable'))).toEqual({ message: 'source unreachable', retry: true, expected: true });
		expect(describeFailure(new JobError('bad station', { retry: false }))).toEqual({ message: 'bad station', retry: false, expected: true });
	});

	it('never stores database text, only the SQLSTATE', () => {
		const f = describeFailure(pgError('23505', 'duplicate key value violates unique constraint "job_dedupe_idx"'));
		expect(f).toEqual({ message: 'a database error (SQLSTATE 23505)', retry: true, expected: false });
		expect(describeFailure(pgError('42501', 'new row violates row-level security policy for table "job"'))).toEqual({
			message: 'not permitted',
			retry: false,
			expected: true
		});
	});

	it('treats connection loss, serialisation failures and deadlocks as expected, retryable', () => {
		for (const code of ['08006', '40001', '40P01', '57P01', '53300']) {
			expect(describeFailure(pgError(code, 'boom'))).toMatchObject({ retry: true, expected: true });
		}
	});

	it('client errors other than a rate limit are not retried', () => {
		expect(describeFailure(new ApiError(400, 'missing series'))).toEqual({ message: 'missing series', retry: false, expected: true });
		expect(describeFailure(new ApiError(429, 'slow down')).retry).toBe(true);
	});

	it('an invalid payload is dead; anything unknown says only "an internal error"', () => {
		const zod = z.object({ a: z.string() }).safeParse({ a: 1 });
		expect(describeFailure(zod.error)).toEqual({ message: 'the job’s payload is not valid', retry: false, expected: true });
		expect(describeFailure(new TypeError('x is undefined at /srv/app.js:1'))).toEqual({ message: 'an internal error', retry: true, expected: false });
		expect(describeFailure('a string')).toMatchObject({ message: 'an internal error' });
	});

	it('clips a long message to the column limit', () => {
		const m = describeFailure(new JobError('x'.repeat(2000))).message;
		expect(m).toHaveLength(JOB_ERROR_MAX);
		expect(m.endsWith('…')).toBe(true);
	});
});
