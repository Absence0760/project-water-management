// The error body (docs/api.md § Errors): `error` in English always; `code`
// and `params` only on the coded errors a farmer can meet, which the
// translated pages word from their catalogue.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { ApiError, ERROR_CODES, handleError, mustChange } from './errors.js';

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

	it('sends no code for an uncoded error (the client words it by status)', async () => {
		const res = await appThrowing(new ApiError(404, 'not found')).request('/');
		expect(await res.json()).toEqual({ error: 'not found' });
	});

	it('keeps the codes unique and snake_case (each is a key of the frontend apiError.ts CODES)', () => {
		expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
		for (const c of ERROR_CODES) expect(c).toMatch(/^[a-z]+(_[a-z]+)*$/);
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
