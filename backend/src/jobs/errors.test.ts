import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError } from '../http/errors.js';
import { describeFailure, JOB_ERROR_MAX, JobError, unexpectedFailure } from './errors.js';

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

describe('unexpectedFailure', () => {
	it('stores fixed words, never retried, and logs the detail as name, code and stack frames only', () => {
		const lines: string[] = [];
		const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
		const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
		const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
		try {
			const err = unexpectedFailure(new TypeError('cannot read /var/task/secret-detail.js for holder Jane'), 'the sweep failed', { id: 'j', projectId: 'p', kind: 'sweep' });
			expect(err).toBeInstanceOf(JobError);
			expect([err.message, err.retry]).toEqual(['the sweep failed', false]);
			expect(describeFailure(err)).toEqual({ message: 'the sweep failed', retry: false, expected: true });
			const logged = lines.join('\n');
			expect(logged).toContain('job_unexpected_error');
			expect(logged).toContain('TypeError');
			expect(logged).not.toContain('Jane');
		} finally {
			spy.mockRestore();
			log.mockRestore();
			warn.mockRestore();
		}
	});
});
