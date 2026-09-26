// The session check (auth/session.ts readSessionClaims) runs on every
// authenticated request, so its cost is paid on each one: one statement on
// the pool, never a transaction of its own (BEGIN + SELECT + COMMIT was three
// round trips a request; issue #41). The watermark rules themselves are
// covered in email.db.test.ts. Needs Postgres (pnpm dev:db:up).
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { getPool } from '../db/pool.js';
import { readSessionClaims } from './session.js';

const probe = new Hono().get('/claims', async (c) => c.json({ claims: await readSessionClaims(c) }));
const claims = async (cookie: string) => ((await (await probe.request('/claims', { headers: { cookie } })).json()) as { claims: unknown }).claims;

afterEach(() => vi.restoreAllMocks());

describe('the session check', () => {
	it('reads the account in one statement, without taking a connection for a transaction', async () => {
		const u = await signUp('OneTrip');
		const pool = getPool();
		const query = vi.spyOn(pool, 'query');
		const connect = vi.spyOn(pool, 'connect');
		expect(await claims(u.cookie)).toEqual({ userId: u.id, scope: null });
		expect(query).toHaveBeenCalledTimes(1);
		// pool.query checks a client out through connect(callback) for its one
		// statement; a transaction (withoutUser/withUser) takes one with connect().
		expect(connect.mock.calls.filter((args) => (args as unknown[]).length === 0)).toEqual([]);
	});

	it('still refuses a session from before the watermark, and an account that is gone', async () => {
		const u = await signUp('Watermarked');
		expect(await claims(u.cookie)).toEqual({ userId: u.id, scope: null });
		await asOwner(`UPDATE app_user SET sessions_revoked_at = now() + interval '1 minute' WHERE id = $1`, [u.id]);
		expect(await claims(u.cookie)).toBeNull();
		const gone = await signUp('Deleted');
		await asOwner('DELETE FROM app_user WHERE id = $1', [gone.id]);
		expect(await claims(gone.cookie)).toBeNull();
	});
});
