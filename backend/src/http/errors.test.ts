// The error body (docs/api.md § Errors): `error` in English always; `code`
// and `params` only on the coded errors a farmer can meet, which the
// translated pages word from their catalogue.
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobCollisionError } from '../jobs/queue.js';
import { ApiError, ERROR_CODES, handleError, MACHINE_ERROR_CODES, mustChange } from './errors.js';

function appThrowing(err: unknown) {
	const app = new Hono();
	app.onError(handleError);
	app.get('/', () => {
		throw err;
	});
	return app;
}

describe('handleError', () => {
	it('sends a coded error’s code and params beside the English message', async () => {
		const res = await appThrowing(ApiError.coded(429, 'signin_locked', 'too many sign-in attempts', { seconds: 60 })).request('/');
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({ error: 'too many sign-in attempts', code: 'signin_locked', params: { seconds: 60 } });
	});

	it('answers a job collision with a pending job the caller can’t see as 409 job_collision, not a 500 (issue #386)', async () => {
		const res = await appThrowing(new JobCollisionError()).request('/');
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: expect.stringMatching(/already queued or just starting/), code: 'job_collision' });
	});

	it('sends no code for an uncoded error (the client words it by status)', async () => {
		const res = await appThrowing(new ApiError(404, 'not found')).request('/');
		expect(await res.json()).toEqual({ error: 'not found' });
	});

	it('keeps the codes unique and snake_case (each is a key of the frontend apiError.ts CODES)', () => {
		expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
		for (const c of ERROR_CODES) expect(c).toMatch(/^[a-z]+(_[a-z]+)*$/);
	});

	it('keeps the machine-only codes apart from the worded ones (the frontend test reads ERROR_CODES only)', () => {
		const all = [...ERROR_CODES, ...MACHINE_ERROR_CODES];
		expect(new Set(all).size).toBe(all.length);
		for (const c of MACHINE_ERROR_CODES) expect(c).toMatch(/^[a-z]+(_[a-z]+)*$/);
	});
});

describe('handleError: the conflict guard (163_licensing_authority)', () => {
	it('answers its check_violation as 409 role_conflict with fixed words, never the database’s text', async () => {
		const pg = Object.assign(new Error('someone who edits a project … farmer@example.com'), { code: '23514', constraint: 'role_conflict' });
		const res = await appThrowing(pg).request('/');
		expect(res.status).toBe(409);
		const body = (await res.json()) as { code?: string; error: string };
		expect(body.code).toBe('role_conflict');
		expect(body.error).toMatch(/applying party/);
		expect(JSON.stringify(body)).not.toContain('farmer@example.com');
	});

	it('leaves every other check_violation the generic 409 with no code', async () => {
		const res = await appThrowing(Object.assign(new Error('x'), { code: '23514', constraint: 'scenario_outcome_check' })).request('/');
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: 'violates a data rule' });
	});
});

describe('handleError: an unhandled error (issue #126)', () => {
	afterEach(() => vi.restoreAllMocks());

	// A pg error's message and detail carry row values; a thrown Error can
	// carry anything a user typed. Neither may reach the log or the response.
	function pgLikeError() {
		const e = Object.assign(new Error('duplicate key: farmer@example.com owns "Secret Farm"'), {
			name: 'error',
			code: '22P02',
			detail: 'Key (email)=(farmer@example.com) already exists.'
		});
		return e;
	}

	it('logs one structured unhandled_error line (the alarm’s event): name, code, route pattern and stack frames, never the message', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const app = new Hono();
		app.onError(handleError);
		app.get('/projects/:id/secret-token/:token', () => {
			throw pgLikeError();
		});
		const res = await app.request('/projects/11111111-2222-3333-4444-555555555555/secret-token/tok-abc123');

		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: 'Internal server error' });

		expect(error).toHaveBeenCalledTimes(1);
		expect(error.mock.calls[0]).toHaveLength(1);
		const raw = error.mock.calls[0]![0] as string;
		const line = JSON.parse(raw);
		expect(line).toMatchObject({ event: 'unhandled_error', method: 'GET', route: '/projects/:id/secret-token/:token', error: 'error', code: '22P02' });
		expect(Object.keys(line).sort()).toEqual(['at', 'code', 'error', 'event', 'method', 'route']);
		expect(line.at.length).toBeGreaterThan(0);
		for (const frame of line.at) expect(frame).toMatch(/^at /);
		for (const leak of ['farmer@example.com', 'Secret Farm', 'duplicate key', 'already exists', 'tok-abc123', '11111111-2222']) {
			expect(raw).not.toContain(leak);
		}
	});

	it('keeps a name or code that isn’t a short token out of the line, and still answers the generic 500', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const err = Object.assign(new Error('boom'), { name: 'Failed for farmer@example.com', code: 'user text: Secret Farm' });
		const res = await appThrowing(err).request('/');
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: 'Internal server error' });
		const raw = error.mock.calls[0]![0] as string;
		expect(JSON.parse(raw)).toMatchObject({ event: 'unhandled_error', method: 'GET', route: '/', error: 'Error' });
		expect(JSON.parse(raw)).not.toHaveProperty('code');
		for (const leak of ['farmer@example.com', 'Secret Farm', 'boom']) expect(raw).not.toContain(leak);
	});

	it('does not log a handled error (the alarm counts server faults only)', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		await appThrowing(new ApiError(404, 'not found')).request('/');
		await appThrowing(Object.assign(new Error('dup'), { code: '23505' })).request('/');
		expect(error).not.toHaveBeenCalled();
	});
});

describe('mustChange (issue #56)', () => {
	it('passes a write that changed a row, and turns one that changed none into a 404', () => {
		expect(() => mustChange({ rowCount: 1 })).not.toThrow();
		for (const rowCount of [0, null]) {
			let thrown: unknown;
			try {
				mustChange({ rowCount });
			} catch (e) {
				thrown = e;
			}
			expect(thrown).toBeInstanceOf(ApiError);
			expect((thrown as ApiError).status).toBe(404);
		}
	});
});
