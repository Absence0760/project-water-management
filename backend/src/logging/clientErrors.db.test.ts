// POST /client-errors (logging/clientErrors.ts): a signed-in browser's page
// crash becomes one `client_error` log line and a bare 204. Signed out it's a
// 401 before anything is logged; a body with an unknown key or an over-long
// field is a 400 that names neither. It has no database code; the mass-assignment
// sweep (http/mass-assignment.security.db.test.ts) checks it writes no row.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { anon, signUp } from '../__tests__/helpers.js';
import { CLIENT_ERROR_LIMITS } from './clientErrors.js';

type User = Awaited<ReturnType<typeof signUp>>;
let user: User;

const report = (over: Record<string, unknown> = {}) => ({
	id: '0a1b2c3d',
	status: 500,
	name: 'TypeError',
	message: "Cannot read properties of undefined (reading 'split')",
	stack: 'TypeError: Cannot read properties of undefined\n    at daysSince (freshness.ts:30:20)',
	path: '/projects/abc/calibration?tab=results',
	version: '1762400000000',
	...over
});

/** The `client_error` lines logged while `fn` ran (console.error, one JSON string each off Lambda). */
async function logged(fn: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
	const lines: unknown[] = [];
	vi.spyOn(console, 'error').mockImplementation((line: unknown) => void lines.push(line));
	await fn();
	return lines
		.map((l) => (typeof l === 'string' ? (JSON.parse(l) as Record<string, unknown>) : (l as Record<string, unknown>)))
		.filter((l) => l.event === 'client_error');
}

beforeAll(async () => {
	user = await signUp('ClientError');
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('POST /client-errors', () => {
	it('is a 401 signed out, and logs nothing', async () => {
		let status = 0;
		const lines = await logged(async () => {
			status = (await anon('POST', '/client-errors', report())).status;
		});
		expect(status).toBe(401);
		expect(lines).toEqual([]);
	});

	it('logs one client_error line with the signed-in user, and answers 204 with no body', async () => {
		let res = { status: 0, body: undefined as unknown };
		const lines = await logged(async () => {
			res = await user.call('POST', '/client-errors', report());
		});
		expect(res.status).toBe(204);
		expect(res.body).toBeNull();
		expect(lines).toEqual([{ event: 'client_error', userId: user.id, ...report() }]);
	});

	it.each([
		['an unknown key', { userId: '00000000-0000-4000-8000-000000000000' }],
		['an over-long message', { message: 'x'.repeat(CLIENT_ERROR_LIMITS.message + 1) }],
		['an over-long stack', { stack: 'x'.repeat(CLIENT_ERROR_LIMITS.stack + 1) }],
		['an over-long path', { path: '/'.repeat(CLIENT_ERROR_LIMITS.path + 1) }],
		['an id that is not 8 hex digits', { id: 'not-an-id' }],
		['a status that is not an integer', { status: 500.5 }],
		['a missing field', { stack: undefined }]
	])('refuses %s with a 400 that echoes nothing, and logs nothing', async (_, over) => {
		let res = { status: 0, body: undefined as unknown };
		const lines = await logged(async () => {
			res = await user.call('POST', '/client-errors', report(over));
		});
		expect(res.status).toBe(400);
		expect(res.body).toEqual({ error: 'invalid error report' });
		expect(lines).toEqual([]);
	});

	it('takes fields at their full length', async () => {
		const full = report({
			name: 'n'.repeat(CLIENT_ERROR_LIMITS.name),
			message: 'm'.repeat(CLIENT_ERROR_LIMITS.message),
			stack: 's'.repeat(CLIENT_ERROR_LIMITS.stack),
			path: '/'.repeat(CLIENT_ERROR_LIMITS.path),
			version: 'v'.repeat(CLIENT_ERROR_LIMITS.version)
		});
		let status = 0;
		const lines = await logged(async () => {
			status = (await user.call('POST', '/client-errors', full)).status;
		});
		expect(status).toBe(204);
		expect(lines).toHaveLength(1);
	});
});
