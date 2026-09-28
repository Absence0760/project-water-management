// The session check (auth/session.ts readSessionClaims) runs on every
// authenticated request, so its cost is paid on each one: one statement on
// the pool, never a transaction of its own (BEGIN + SELECT + COMMIT was three
// round trips a request; issue #41). The watermark rules themselves are
// covered in email.db.test.ts. Needs Postgres (pnpm dev:db:up).
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { anon, asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
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
		expect(await claims(u.cookie)).toMatchObject({ userId: u.id, scope: null });
		expect(query).toHaveBeenCalledTimes(1);
		// pool.query checks a client out through connect(callback) for its one
		// statement; a transaction (withoutUser/withUser) takes one with connect().
		expect(connect.mock.calls.filter((args) => (args as unknown[]).length === 0)).toEqual([]);
	});

	it('still refuses a session from before the watermark, and an account that is gone', async () => {
		const u = await signUp('Watermarked');
		expect(await claims(u.cookie)).toMatchObject({ userId: u.id, scope: null });
		await asOwner(`UPDATE app_user SET sessions_revoked_at = now() + interval '1 minute' WHERE id = $1`, [u.id]);
		expect(await claims(u.cookie)).toBeNull();
		const gone = await signUp('Deleted');
		await asOwner('DELETE FROM app_user WHERE id = $1', [gone.id]);
		expect(await claims(gone.cookie)).toBeNull();
	});
});

// Issue #51 (adversary finding 4): POST /auth/logout signed out only the
// browser that asked, by clearing its cookie; a copy of the cookie stayed
// valid for up to 7 days. The session's id (jti) is now revoked on the
// server (102_session_revocation).
describe('signing out', () => {
	it('ends the session on the server: the same cookie is refused afterwards (positive control: it worked before)', async () => {
		const u = await signUp('Logout');
		const copy = u.cookie;
		expect((await anon('GET', '/auth/me', undefined, copy)).status).toBe(200);
		const out = await anon('POST', '/auth/logout', undefined, copy);
		expect(out.status).toBe(204);
		expect(out.headers.get('set-cookie')).toMatch(/wm_session=;/);
		for (const path of ['/auth/me', '/projects']) expect((await anon('GET', path, undefined, copy)).status, path).toBe(401);
		expect(await claims(copy)).toBeNull();
		// Only that session: the account signs in again, and another of its sessions is untouched.
		const again = await anon('POST', '/auth/login', { email: u.email, password: 'correct horse' });
		expect(again.status).toBe(200);
		const fresh = again.headers.get('set-cookie')!.split(';')[0]!;
		expect((await anon('GET', '/auth/me', undefined, fresh)).status).toBe(200);
	});

	it('leaves the account’s other sessions signed in', async () => {
		const u = await signUp('LogoutOne');
		const second = (await anon('POST', '/auth/login', { email: u.email, password: 'correct horse' })).headers.get('set-cookie')!.split(';')[0]!;
		expect((await anon('POST', '/auth/logout', undefined, u.cookie)).status).toBe(204);
		expect((await anon('GET', '/auth/me', undefined, u.cookie)).status).toBe(401);
		expect((await anon('GET', '/auth/me', undefined, second)).status).toBe(200);
	});

	it('answers 204 without a session, and keeps a row only until the token would have expired', async () => {
		expect((await anon('POST', '/auth/logout')).status).toBe(204);
		const u = await signUp('LogoutExpiry');
		expect((await anon('POST', '/auth/logout', undefined, u.cookie)).status).toBe(204);
		const [row] = await asOwner('SELECT expires_at FROM revoked_session WHERE user_id = $1', [u.id]);
		const days = (new Date(row.expires_at).getTime() - Date.now()) / 86_400_000;
		expect(days).toBeGreaterThan(6.9);
		expect(days).toBeLessThanOrEqual(7);
		// Expired rows go at the next sign-out.
		await asOwner(`UPDATE revoked_session SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [u.id]);
		const other = await signUp('LogoutNext');
		expect((await anon('POST', '/auth/logout', undefined, other.cookie)).status).toBe(204);
		expect(await asOwner('SELECT 1 FROM revoked_session WHERE user_id = $1', [u.id])).toEqual([]);
	});

	it('lets nobody read or write the revoked ids directly, or revoke another account’s session', async () => {
		const u = await signUp('LogoutRls');
		const victim = await signUp('LogoutVictim');
		expect((await withUser(u.id, (db) => db.query('SELECT * FROM revoked_session'))).rows).toEqual([]);
		await expect(
			withUser(u.id, (db) => db.query(`INSERT INTO revoked_session (jti, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [crypto.randomUUID(), victim.id]))
		).rejects.toMatchObject({ code: '42501' });
		// app_revoke_session records under the caller's account only, so another account's session id revokes nothing,
		// and doesn't stop its owner signing it out.
		const jti = JSON.parse(Buffer.from(victim.cookie.split('=')[1]!.split('.')[1]!, 'base64url').toString()).jti as string;
		await withUser(u.id, (db) => db.query(`SELECT app_revoke_session($1, now() + interval '1 day')`, [jti]));
		expect((await anon('GET', '/auth/me', undefined, victim.cookie)).status).toBe(200);
		expect((await anon('POST', '/auth/logout', undefined, victim.cookie)).status).toBe(204);
		expect((await anon('GET', '/auth/me', undefined, victim.cookie)).status).toBe(401);
		await expect(withoutUser((db) => db.query(`SELECT app_revoke_session($1, now())`, [jti]))).rejects.toMatchObject({ code: '42501' });
	});
});
