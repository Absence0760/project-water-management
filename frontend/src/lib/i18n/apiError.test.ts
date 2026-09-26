// Server errors on the translated pages: worded from the code (or the
// status), never the server's English; and every code the API can send has
// its message (the contract in backend/src/http/errors.ts ERROR_CODES).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ApiError } from '$lib/api/client';
import { errorText } from './apiError';
import { en } from './messages/en';

const backendCodes = () => {
	const src = readFileSync(new URL('../../../../backend/src/http/errors.ts', import.meta.url), 'utf8');
	const list = /export const ERROR_CODES = \[([^\]]*)\]/.exec(src)?.[1] ?? '';
	return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
};

describe('errorText', () => {
	it('has a message for every code the API sends', () => {
		const codes = backendCodes();
		expect(codes.length).toBeGreaterThan(10);
		expect(codes.filter((c) => !(`error.${c}` in en))).toEqual([]);
	});

	it('words a coded error from the catalogue, not the server’s English', () => {
		expect(errorText(new ApiError(400, 'this link is invalid or has expired — request a new one', undefined, 'link_invalid'))).toBe(
			'This link is invalid or has expired. Ask for a new one.'
		);
		expect(errorText(new ApiError(403, 'x', undefined, 'note_farmer_own_farm'))).toBe('You can add notes only to your own farm.');
	});

	it('says how long a sign-in lock lasts, in whole minutes', () => {
		const locked = (seconds: unknown) => errorText(new ApiError(429, 'x', undefined, 'signin_locked', { seconds: seconds as number }));
		expect(locked(45)).toBe('Too many sign-in attempts for this address. Try again in 1 minute, or reset your password.');
		expect(locked(61)).toBe('Too many sign-in attempts for this address. Try again in 2 minutes, or reset your password.');
		expect(locked(undefined)).toMatch(/Try again in 1 minute,/);
	});

	it('falls back to the status for an unknown or missing code, and never shows the server’s text', () => {
		expect(errorText(new ApiError(404, 'no such thing', undefined, 'something_new'))).toBe('That isn’t there any more.');
		expect(errorText(new ApiError(0, 'Could not reach the server'))).toBe('Couldn’t reach the server. Check your connection and try again.');
		expect(errorText(new ApiError(502, 'Bad gateway'))).toBe('Something went wrong on our side. Try again in a moment.');
		expect(errorText(new ApiError(400, 'invalid request (email: Invalid email)'))).toBe('That wasn’t accepted. Check what you entered and try again.');
		expect(errorText(new ApiError(401, 'not signed in'))).toBe('You’re not signed in. Sign in and try again.');
		expect(errorText(new ApiError(418, 'teapot'))).toBe('Something went wrong. Try again.');
		expect(errorText(new Error('boom'))).toBe('Something went wrong. Try again.');
	});
});
