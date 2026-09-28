import { describe, expect, it } from 'vitest';
import { safeError, stackFrames } from './safeError.js';

// What SES really answers in the sandbox and on an IAM denial: the address is in the text.
const sesRejected = () =>
	Object.assign(new Error('Email address is not verified. The following identities failed the check in region AF-SOUTH-1: ann@example.com'), {
		name: 'MessageRejected',
		$metadata: { httpStatusCode: 400 }
	});
const sesDenied = () =>
	Object.assign(new Error('User `arn:aws:sts::000000000000:assumed-role/x` is not authorized to perform `ses:SendEmail` on resource `arn:aws:ses:af-south-1:000000000000:identity/ann@example.com`'), {
		name: 'AccessDeniedException',
		$metadata: { httpStatusCode: 403 }
	});

describe('safeError', () => {
	it('keeps an SES error’s code and status, never its text (which names the recipient)', () => {
		expect(safeError(sesRejected())).toEqual({ error: 'MessageRejected', status: 400 });
		expect(safeError(sesDenied())).toEqual({ error: 'AccessDeniedException', status: 403 });
		expect(JSON.stringify(safeError(sesDenied()))).not.toContain('@');
	});

	it('keeps a Postgres SQLSTATE or a Node/SMTP code, not the detail', () => {
		const pg = Object.assign(new Error('duplicate key value violates unique constraint "app_user_email_key"'), { code: '23505', detail: 'Key (email)=(ann@example.com) already exists.' });
		expect(safeError(pg)).toEqual({ error: 'Error', code: '23505' });
		expect(safeError(Object.assign(new Error('Invalid login: 535 ann@example.com'), { code: 'EAUTH' }))).toEqual({ error: 'Error', code: 'EAUTH' });
	});

	it('refuses a name or code that isn’t a short token, and survives non-errors', () => {
		expect(safeError(Object.assign(new Error('x'), { name: 'Rejected: ann@example.com', code: 'to ann@example.com' }))).toEqual({ error: 'Error' });
		expect(safeError('a thrown string with ann@example.com')).toEqual({ error: 'Error' });
		expect(safeError(null)).toEqual({ error: 'Error' });
		expect(safeError(undefined)).toEqual({ error: 'Error' });
	});
});

describe('stackFrames', () => {
	it('keeps the frames and drops the message head, even a multi-line one', () => {
		const err = new Error('line one ann@example.com\nline two bob@example.com');
		const frames = stackFrames(err);
		expect(frames.length).toBeGreaterThan(0);
		expect(frames.every((f) => f.startsWith('at '))).toBe(true);
		expect(frames.join('\n')).not.toContain('@example.com');
	});

	it('caps the frames, and is empty without a stack', () => {
		expect(stackFrames(new Error('x'), 2).length).toBeLessThanOrEqual(2);
		expect(stackFrames({})).toEqual([]);
		expect(stackFrames(null)).toEqual([]);
	});
});
