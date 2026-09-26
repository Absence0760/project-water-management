import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from './client';
import { isPublicPath } from '../auth/session.svelte';
import { emailAuthApi, linkToken, passwordProblem } from './emailAuth';

function mockFetch(status: number, body?: unknown) {
	return vi.fn(
		async () =>
			new Response(status === 204 ? null : body === undefined ? '' : JSON.stringify(body), {
				status,
				headers: { 'Content-Type': 'application/json' }
			})
	);
}
const call = (f: ReturnType<typeof mockFetch>, i = 0) => {
	const [url, init] = f.mock.calls[i] as unknown as [string, RequestInit];
	return { url, method: init.method, body: init.body ? JSON.parse(init.body as string) : undefined };
};

const TOKEN = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF1234';

describe('emailAuthApi', () => {
	it('posts the auth flows to the right endpoints', async () => {
		const f = mockFetch(202, { ok: true });
		const a = emailAuthApi(createApi('http://x', f));
		await a.forgotPassword('a@b.c');
		await a.verifyEmail(TOKEN);
		await a.resendVerification();
		expect(call(f, 0)).toEqual({ url: 'http://x/auth/forgot-password', method: 'POST', body: { email: 'a@b.c' } });
		expect(call(f, 1)).toEqual({ url: 'http://x/auth/verify-email', method: 'POST', body: { token: TOKEN } });
		expect(call(f, 2)).toEqual({ url: 'http://x/auth/resend-verification', method: 'POST', body: undefined });
	});

	it('resetPassword resolves on 204 and surfaces an invalid link as ApiError 400', async () => {
		await expect(emailAuthApi(createApi('', mockFetch(204))).resetPassword(TOKEN, 'longenough')).resolves.toBeUndefined();
		const err = await emailAuthApi(createApi('', mockFetch(400, { error: 'this link is invalid or has expired' })))
			.resetPassword(TOKEN, 'longenough')
			.catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.status).toBe(400);
	});

	it('unwraps invite info and invite lists; revokes by id', async () => {
		const info = { email: 'a@b.c', projectName: 'P', teamName: null, invitedBy: 'Ann' };
		expect(await emailAuthApi(createApi('', mockFetch(200, { invite: info }))).inviteInfo(TOKEN)).toEqual(info);

		const f = mockFetch(200, { invites: [{ id: 'i1' }] });
		const a = emailAuthApi(createApi('', f));
		expect(await a.projectInvites.list('p/1')).toEqual([{ id: 'i1' }]);
		expect(call(f).url).toBe('/projects/p%2F1/invites');
		await a.teamInvites.list('t1');
		expect(call(f, 1).url).toBe('/teams/t1/invites');

		const d = mockFetch(204);
		await emailAuthApi(createApi('', d)).projectInvites.revoke('p1', 'i1');
		expect(call(d)).toMatchObject({ url: '/projects/p1/invites/i1', method: 'DELETE' });
	});

	it('add returns either a member or an invite', async () => {
		const invite = { invited: true, invite: { id: 'i', email: 'new@b.c', role: 'viewer' } };
		const r = await emailAuthApi(createApi('', mockFetch(201, invite))).projectInvites.add('p1', 'new@b.c', 'viewer');
		expect(r.invited).toBe(true);
		const m = await emailAuthApi(createApi('', mockFetch(201, { member: { userId: 'u' } }))).teamInvites.add('t', 'x@b.c', 'member');
		expect(m.member).toEqual({ userId: 'u' });
	});
});

describe('linkToken', () => {
	it('reads a well-formed token and rejects anything else', () => {
		expect(linkToken(new URL(`http://x/reset-password?token=${TOKEN}`))).toBe(TOKEN);
		expect(linkToken(new URL(`http://x/register?invite=${TOKEN}`), 'invite')).toBe(TOKEN);
		expect(linkToken(new URL('http://x/reset-password'))).toBeNull();
		expect(linkToken(new URL('http://x/reset-password?token=short'))).toBeNull();
		expect(linkToken(new URL(`http://x/reset-password?token=${TOKEN}%3Cx`))).toBeNull();
	});
});

describe('signed-out access', () => {
	it('forgot/reset/verify links work signed out', () => {
		expect(isPublicPath('/forgot-password')).toBe(true);
		expect(isPublicPath('/reset-password')).toBe(true);
		expect(isPublicPath('/verify-email')).toBe(true);
	});
});

describe('passwordProblem', () => {
	it('checks length and confirmation like the server', () => {
		expect(passwordProblem('short', 'short')).toBe('Use at least 8 characters.');
		expect(passwordProblem('x'.repeat(201), 'x'.repeat(201))).toBe('Use at most 200 characters.');
		expect(passwordProblem('longenough', 'longenougH')).toBe('The two passwords don’t match.');
		expect(passwordProblem('longenough', 'longenough')).toBeNull();
	});
});
