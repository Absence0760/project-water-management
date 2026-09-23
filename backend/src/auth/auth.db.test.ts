import { describe, expect, it } from 'vitest';
import { app, signUp } from '../__tests__/helpers.js';

const json = (body: unknown) => ({
	method: 'POST',
	headers: { 'content-type': 'application/json', origin: 'http://localhost:7777' },
	body: JSON.stringify(body)
});

describe('auth', () => {
	it('registers, reads /me from the cookie, and never returns the hash', async () => {
		const u = await signUp('Ann');
		const me = await u.call('GET', '/auth/me');
		expect(me.status).toBe(200);
		expect(me.body.user).toEqual({ id: u.id, email: u.email, displayName: 'Ann' });
		expect(JSON.stringify(me.body)).not.toContain('password');
	});

	it('sets an httpOnly SameSite=Lax session cookie', async () => {
		const res = await app.request('/auth/register', json({ email: `c-${crypto.randomUUID()}@x.io`, password: 'longenough', displayName: 'C' }));
		const cookie = res.headers.get('set-cookie')!;
		expect(cookie).toMatch(/wm_session=/);
		expect(cookie).toMatch(/HttpOnly/i);
		expect(cookie).toMatch(/SameSite=Lax/i);
	});

	it('rejects duplicate emails case-insensitively', async () => {
		const u = await signUp('Dup');
		const res = await app.request('/auth/register', json({ email: u.email.toUpperCase(), password: 'longenough', displayName: 'X' }));
		expect(res.status).toBe(409);
	});

	it('logs in with the right password and not with a wrong one or unknown email', async () => {
		const u = await signUp('Log');
		expect((await app.request('/auth/login', json({ email: u.email, password: 'correct horse' }))).status).toBe(200);
		expect((await app.request('/auth/login', json({ email: u.email, password: 'wrong' }))).status).toBe(401);
		expect((await app.request('/auth/login', json({ email: 'nobody@example.com', password: 'wrong' }))).status).toBe(401);
	});

	it('requires a valid session for project routes', async () => {
		expect((await app.request('/projects')).status).toBe(401);
		const res = await app.request('/projects', { headers: { cookie: 'wm_session=forged.token.here' } });
		expect(res.status).toBe(401);
	});

	it('validates register input', async () => {
		const res = await app.request('/auth/register', json({ email: 'not-an-email', password: 'short', displayName: '' }));
		expect(res.status).toBe(400);
	});
});
