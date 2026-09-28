import { LEGAL_VERSION } from '@water-management/engine/legal';
import { describe, expect, it } from 'vitest';
import { anon, app, asOwner, lastMailTo, signUp, tokenIn } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { SESSION_COOKIE, signSession } from './session.js';

const json = (body: unknown) => ({
	method: 'POST',
	headers: { 'content-type': 'application/json', origin: 'http://localhost:7777' },
	body: JSON.stringify(body)
});

describe('auth', () => {
	it('registers, reads /me from the cookie, and never returns the hash', async () => {
		const u = await signUp('Ann', { verified: false });
		const me = await u.call('GET', '/auth/me');
		expect(me.status).toBe(200);
		expect(me.body.user).toEqual({ id: u.id, email: u.email, displayName: 'Ann', emailVerified: false, locale: null, volumeUnit: 'm3', mailSuppressed: null, preferences: { hiddenTabs: [] }, termsCurrent: true });
		expect(JSON.stringify(me.body)).not.toContain('password');
	});

	it('the test helper verifies by default', async () => {
		expect((await (await signUp('Bea')).call('GET', '/auth/me')).body.user.emailVerified).toBe(true);
	});

	it('a sign-in sets an httpOnly SameSite=Lax session cookie', async () => {
		const u = await signUp('C');
		const res = await app.request('/auth/login', json({ email: u.email, password: 'correct horse' }));
		const cookie = res.headers.get('set-cookie')!;
		expect(cookie).toMatch(/wm_session=/);
		expect(cookie).toMatch(/HttpOnly/i);
		expect(cookie).toMatch(/SameSite=Lax/i);
	});

	// Sign-up (issue #57): the account is made and a confirmation link mailed,
	// but nobody is signed in until the address is confirmed.
	it('a sign-up signs nobody in: it mails a confirmation link and answers 202', async () => {
		const email = `n-${crypto.randomUUID()}@x.io`;
		const res = await app.request('/auth/register', json({ email, password: 'longenough', displayName: 'N', acceptTerms: LEGAL_VERSION }));
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ confirm: true, email });
		expect(res.headers.get('set-cookie')).toBeNull();
		expect(lastMailTo(email)?.subject).toMatch(/Confirm your email address/);
	});

	it('an unconfirmed account can’t sign in, and can once the emailed link confirms it', async () => {
		const email = `u-${crypto.randomUUID()}@x.io`;
		await app.request('/auth/register', json({ email, password: 'longenough', displayName: 'U', acceptTerms: LEGAL_VERSION }));
		const refused = await anon('POST', '/auth/login', { email, password: 'longenough' });
		expect(refused.status).toBe(403);
		expect(refused.body.code).toBe('email_unconfirmed');
		expect(refused.headers.get('set-cookie')).toBeNull();
		// Only a correct password learns it: a wrong one is the ordinary 401.
		expect((await anon('POST', '/auth/login', { email, password: 'wrong guess' })).body.code).toBe('wrong_credentials');
		expect((await anon('POST', '/auth/verify-email', { token: tokenIn(lastMailTo(email)) })).status).toBe(200);
		const ok = await anon('POST', '/auth/login', { email, password: 'longenough' });
		expect(ok.status).toBe(200);
		expect(ok.body.user.emailVerified).toBe(true);
	});

	it('answers a taken address exactly like a free one, and mails its owner instead', async () => {
		const u = await signUp('Dup');
		const free = await app.request('/auth/register', json({ email: `f-${crypto.randomUUID()}@x.io`, password: 'longenough', displayName: 'X', acceptTerms: LEGAL_VERSION }));
		const taken = await app.request('/auth/register', json({ email: u.email.toUpperCase(), password: 'longenough', displayName: 'X', acceptTerms: LEGAL_VERSION }));
		expect(taken.status).toBe(free.status);
		expect(Object.keys((await taken.json()) as object)).toEqual(Object.keys((await free.json()) as object));
		expect(taken.headers.get('set-cookie')).toBeNull();
		// The owner hears about it, with a way back in if they forgot the password.
		const mail = lastMailTo(u.email);
		expect(mail?.subject).toMatch(/You already have an account/);
		expect(mail?.text).toMatch(/\/reset-password\?token=/);
		// The owner's password is untouched.
		expect((await anon('POST', '/auth/login', { email: u.email, password: 'correct horse' })).status).toBe(200);
	});

	it('a taken but never-confirmed address gets a fresh confirmation link', async () => {
		const u = await signUp('Pending', { verified: false });
		await app.request('/auth/register', json({ email: u.email, password: 'longenough', displayName: 'X', acceptTerms: LEGAL_VERSION }));
		expect(lastMailTo(u.email)?.subject).toMatch(/Confirm your email address/);
	});

	it('“send the link again” answers the same for any address, and mails only an unconfirmed account', async () => {
		const pending = `p-${crypto.randomUUID()}@x.io`;
		await app.request('/auth/register', json({ email: pending, password: 'longenough', displayName: 'P', acceptTerms: LEGAL_VERSION }));
		const confirmed = await signUp('Confirmed');
		const before = { pending: lastMailTo(pending), confirmed: lastMailTo(confirmed.email) };
		// Within the cooldown of the sign-up's own mail: nothing new yet, the same answer.
		const answers = await Promise.all(
			[pending, confirmed.email, `nobody-${crypto.randomUUID()}@x.io`].map((email) => anon('POST', '/auth/resend-confirmation', { email }))
		);
		for (const a of answers) expect([a.status, a.body]).toEqual([202, { ok: true }]);
		expect(lastMailTo(confirmed.email)).toBe(before.confirmed);
		expect(lastMailTo(pending)).toBe(before.pending);
		// After the cooldown, the unconfirmed account gets a new link.
		await asOwner("UPDATE email_token SET created_at = created_at - interval '2 hours' WHERE user_id = (SELECT id FROM app_user WHERE email = $1)", [pending]);
		expect((await anon('POST', '/auth/resend-confirmation', { email: pending })).status).toBe(202);
		expect(lastMailTo(pending)).not.toBe(before.pending);
		expect(lastMailTo(pending)?.subject).toMatch(/Confirm your email address/);
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
		const res = await app.request('/auth/register', json({ email: 'not-an-email', password: 'short', displayName: '', acceptTerms: LEGAL_VERSION }));
		expect(res.status).toBe(400);
	});
});

// Which terms each account accepted (087, docs/legal-status.md): the form
// says "By signing up, you accept the Terms of use and Privacy notice" and
// sends the version it showed; the server refuses any other and stores it.
describe('terms acceptance', () => {
	const register = (email: string, extra: Record<string, unknown>) => anon('POST', '/auth/register', { email, password: 'correct horse', displayName: 'Terms', ...extra });
	const record = async (email: string) =>
		(await asOwner('SELECT terms_version, terms_accepted_at FROM app_user WHERE email = $1', [email])) as { terms_version: string | null; terms_accepted_at: Date | null }[];

	it('refuses a sign-up without the current version (400 terms_not_accepted) and makes no account', async () => {
		for (const extra of [{}, { acceptTerms: '2020-01-01' }, { acceptTerms: '' }]) {
			const email = `t-${crypto.randomUUID()}@x.io`;
			const res = await register(email, extra);
			expect(res.status).toBe(400);
			expect(res.body).toMatchObject({ code: 'terms_not_accepted', params: { version: LEGAL_VERSION } });
			expect(await record(email)).toEqual([]);
			expect(lastMailTo(email)).toBeUndefined();
		}
	});

	it('stores the version and the database’s time with the account (positive control)', async () => {
		const email = `t-${crypto.randomUUID()}@x.io`;
		const before = Date.now();
		expect((await register(email, { acceptTerms: LEGAL_VERSION })).status).toBe(202);
		const [row] = await record(email);
		expect(row!.terms_version).toBe(LEGAL_VERSION);
		expect(row!.terms_accepted_at!.getTime()).toBeGreaterThanOrEqual(before - 5_000);
		expect(row!.terms_accepted_at!.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
	});

	it('a sign-up through an invite records it too', async () => {
		const owner = await signUp('Inviter');
		const project = await owner.call('POST', '/projects', { name: 'Terms invite' });
		const email = `t-${crypto.randomUUID()}@x.io`;
		expect((await owner.call('POST', `/projects/${project.body.project.id}/members`, { email, role: 'viewer' })).status).toBe(201);
		const res = await register(email, { acceptTerms: LEGAL_VERSION, inviteToken: tokenIn(lastMailTo(email)) });
		expect(res.status).toBe(201);
		expect(res.body.user.termsCurrent).toBe(true);
		expect((await record(email))[0]!.terms_version).toBe(LEGAL_VERSION);
	});

	it('/auth/me says termsCurrent false for an account that accepted an older version, or none', async () => {
		const u = await signUp('Olderterms');
		expect((await u.call('GET', '/auth/me')).body.user.termsCurrent).toBe(true);
		await asOwner('UPDATE app_user SET terms_version = $2 WHERE id = $1', [u.id, '2020-01-01']);
		expect((await u.call('GET', '/auth/me')).body.user.termsCurrent).toBe(false);
		// Made by a script (seed:examples, import:project): app_register without a version accepted nothing.
		const email = `script-${crypto.randomUUID()}@x.io`;
		const [made] = (await asOwner("SELECT app_register($1, 'Script', 'x', NULL) AS id", [email])) as { id: string }[];
		expect(await record(email)).toEqual([{ terms_version: null, terms_accepted_at: null }]);
		const me = await anon('GET', '/auth/me', undefined, `${SESSION_COOKIE}=${await signSession(made!.id)}`);
		expect(me.body.user.termsCurrent).toBe(false);
	});

	it('the acceptance time is the database’s: an account can’t backdate or clear its own record', async () => {
		const u = await signUp('Backdater');
		const [before] = await record(u.email);
		await withUser(u.id, (db) => db.query("UPDATE app_user SET terms_accepted_at = '2000-01-01' WHERE id = $1", [u.id]));
		await withUser(u.id, (db) => db.query('UPDATE app_user SET terms_version = NULL WHERE id = $1', [u.id]));
		expect(await record(u.email)).toEqual([before]);
		// A new version is stamped now, whatever time was sent with it.
		await withUser(u.id, (db) => db.query("UPDATE app_user SET terms_version = '2099-01-01', terms_accepted_at = '2000-01-01' WHERE id = $1", [u.id]));
		const [after] = await record(u.email);
		expect(after!.terms_version).toBe('2099-01-01');
		expect(after!.terms_accepted_at!.getTime()).toBeGreaterThan(before!.terms_accepted_at!.getTime() - 1);
		expect(after!.terms_accepted_at!.getFullYear()).toBeGreaterThan(2020);
	});
});

describe('sign-in lockout', () => {
	const login = (email: string, password: string) => anon('POST', '/auth/login', { email, password });

	it('locks an address after 5 attempts without the right password, then backs off', async () => {
		const u = await signUp('Locked');
		for (let i = 0; i < 5; i++) {
			const wrong = await login(u.email, 'wrong guess');
			expect(wrong.status).toBe(401);
			expect(wrong.body.code).toBe('wrong_credentials');
		}
		// Even the right password is refused while locked — and the password isn't checked.
		const locked = await login(u.email, 'correct horse');
		expect(locked.status).toBe(429);
		expect(locked.body.error).toMatch(/too many sign-in attempts for this address — try again in a minute/);
		// The translated sign-in page words it from the code, with the wait in seconds (docs/api.md § Errors).
		expect(locked.body.code).toBe('signin_locked');
		expect(locked.body.params.seconds).toBe(Number(locked.headers.get('retry-after')));
		expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
		expect(Number(locked.headers.get('retry-after'))).toBeLessThanOrEqual(60);
		// Same address in another case is the same lock.
		expect((await login(u.email.toUpperCase(), 'correct horse')).status).toBe(429);
		// An existing session is unaffected.
		expect((await u.call('GET', '/auth/me')).status).toBe(200);

		// Lock over: one more wrong guess locks again, for twice as long.
		await asOwner(`UPDATE login_throttle SET locked_until = now() - interval '1 second' WHERE email = $1`, [u.email]);
		expect((await login(u.email, 'wrong again')).status).toBe(401);
		const longer = await login(u.email, 'correct horse');
		expect(longer.status).toBe(429);
		expect(Number(longer.headers.get('retry-after'))).toBeGreaterThan(60);
		expect(Number(longer.headers.get('retry-after'))).toBeLessThanOrEqual(120);

		// Positive control: once the lock passes, the right password works and clears the record.
		await asOwner(`UPDATE login_throttle SET locked_until = now() - interval '1 second' WHERE email = $1`, [u.email]);
		expect((await login(u.email, 'correct horse')).status).toBe(200);
		expect(await asOwner('SELECT 1 FROM login_throttle WHERE email = $1', [u.email])).toHaveLength(0);
	});

	it('caps the lock at 15 minutes', async () => {
		const u = await signUp('Capped');
		await asOwner(`INSERT INTO login_throttle (email, failures) VALUES ($1, 40)`, [u.email]);
		const res = await login(u.email, 'wrong guess');
		expect(res.status).toBe(401);
		const locked = await login(u.email, 'wrong guess');
		expect(locked.status).toBe(429);
		expect(Number(locked.headers.get('retry-after'))).toBeLessThanOrEqual(15 * 60);
		expect(locked.body.error).toMatch(/15 minutes/);
	});

	it('a correct password before the limit resets the count', async () => {
		const u = await signUp('Recount');
		for (let i = 0; i < 4; i++) expect((await login(u.email, 'wrong guess')).status).toBe(401);
		expect((await login(u.email, 'correct horse')).status).toBe(200);
		for (let i = 0; i < 4; i++) expect((await login(u.email, 'wrong guess')).status).toBe(401);
		expect((await login(u.email, 'correct horse')).status).toBe(200);
	});

	it('locks an address with no account exactly like one with an account (no enumeration)', async () => {
		const u = await signUp('Known');
		const unknown = `nobody-${crypto.randomUUID()}@example.com`;
		const known: { status: number; body: unknown }[] = [];
		const missing: { status: number; body: unknown }[] = [];
		for (let i = 0; i < 6; i++) {
			const a = await login(u.email, 'wrong guess');
			const b = await login(unknown, 'wrong guess');
			known.push({ status: a.status, body: a.body });
			missing.push({ status: b.status, body: b.body });
		}
		expect(missing).toEqual(known);
		expect(known.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 429]);
	});

	it('counts parallel guesses one by one', async () => {
		const u = await signUp('Parallel');
		const statuses = (await Promise.all(Array.from({ length: 12 }, () => login(u.email, 'wrong guess')))).map((r) => r.status);
		expect(statuses.filter((s) => s === 401)).toHaveLength(5);
		expect(statuses.filter((s) => s === 429)).toHaveLength(7);
	});

	it('a password reset lifts the lock', async () => {
		const u = await signUp('Unlock');
		for (let i = 0; i < 5; i++) await login(u.email, 'wrong guess');
		expect((await login(u.email, 'correct horse')).status).toBe(429);
		await anon('POST', '/auth/forgot-password', { email: u.email });
		expect((await anon('POST', '/auth/reset-password', { token: tokenIn(lastMailTo(u.email)), password: 'fresh password' })).status).toBe(204);
		expect((await login(u.email, 'fresh password')).status).toBe(200);
	});

	it('the throttle table is closed to the app role (functions only)', async () => {
		const u = await signUp('Closed');
		await login(u.email, 'wrong guess');
		const { withUser } = await import('../db/tx.js');
		const seen = await withUser(u.id, async (db) => (await db.query('SELECT * FROM login_throttle')).rowCount);
		expect(seen).toBe(0);
		// Positive control: the row is there (as the owner).
		expect(await asOwner('SELECT failures FROM login_throttle WHERE email = $1', [u.email])).toEqual([{ failures: 1 }]);
	});
});

describe('account: display name and password change (WP-1.9)', () => {
	const login = (email: string, password: string) => anon('POST', '/auth/login', { email, password });
	const cookieOf = (res: { headers: Headers }) => res.headers.get('set-cookie')?.split(';')[0] ?? '';
	const change = (cookie: string, currentPassword: string, newPassword: string) =>
		anon('POST', '/auth/change-password', { currentPassword, newPassword }, cookie);

	it('PATCH /auth/me renames the account (trimmed), validates the name, and never changes the email', async () => {
		const u = await signUp('Renamed');
		const res = await u.call('PATCH', '/auth/me', { displayName: '  Dr Renamed  ' });
		expect(res.status).toBe(200);
		expect(res.body.user).toEqual({ id: u.id, email: u.email, displayName: 'Dr Renamed', emailVerified: true, locale: null, volumeUnit: 'm3', mailSuppressed: null, preferences: { hiddenTabs: [] }, termsCurrent: true });
		expect((await u.call('GET', '/auth/me')).body.user.displayName).toBe('Dr Renamed');
		expect((await u.call('PATCH', '/auth/me', { displayName: '   ' })).status).toBe(400);
		expect((await u.call('PATCH', '/auth/me', { displayName: 'x'.repeat(101) })).status).toBe(400);
		// Unknown keys are ignored: the address isn't editable here.
		expect((await u.call('PATCH', '/auth/me', { displayName: 'Still me', email: 'hijack@example.com' })).status).toBe(200);
		expect((await u.call('GET', '/auth/me')).body.user).toMatchObject({ email: u.email, displayName: 'Still me' });
	});

	it('changing the password keeps this device signed in and gives every other session 401', async () => {
		const u = await signUp('Changer');
		const bystander = await signUp('Bystander');
		// A second device.
		const second = cookieOf(await login(u.email, 'correct horse'));
		expect((await anon('GET', '/auth/me', undefined, second)).status).toBe(200);

		const res = await change(u.cookie, 'correct horse', 'battery staple');
		expect(res.status).toBe(200);
		expect(res.body.user).toEqual({ id: u.id, email: u.email, displayName: 'Changer', emailVerified: true, locale: null, volumeUnit: 'm3', mailSuppressed: null, preferences: { hiddenTabs: [] }, termsCurrent: true });
		const fresh = cookieOf(res);
		expect(fresh).toMatch(/^wm_session=.+/);

		// Positive control: this device, with its re-issued cookie, stays signed in.
		expect((await anon('GET', '/auth/me', undefined, fresh)).status).toBe(200);
		expect((await anon('GET', '/projects', undefined, fresh)).status).toBe(200);
		// The other device's next request gets 401, and so does this device's old cookie.
		expect((await anon('GET', '/auth/me', undefined, second)).status).toBe(401);
		expect((await u.call('GET', '/auth/me')).status).toBe(401);
		// Other accounts are untouched.
		expect((await bystander.call('GET', '/auth/me')).status).toBe(200);
		// The new password signs in; the old one doesn't.
		expect((await login(u.email, 'correct horse')).status).toBe(401);
		expect((await login(u.email, 'battery staple')).status).toBe(200);
	});

	it('a wrong current password changes nothing and counts towards the sign-in lockout', async () => {
		const u = await signUp('Guesser');
		for (let i = 0; i < 4; i++) {
			const res = await change(u.cookie, 'wrong guess', 'battery staple');
			expect(res.status).toBe(403);
			expect(res.body).toEqual({ error: 'your current password is wrong', code: 'wrong_current_password' });
		}
		// A wrong guess doesn't end the session.
		expect((await u.call('GET', '/auth/me')).status).toBe(200);
		// The 5th attempt, through the login form, is counted in the same lockout...
		expect((await login(u.email, 'wrong guess')).status).toBe(401);
		// ...so the address is now locked for both, and the password isn't checked.
		expect((await login(u.email, 'correct horse')).status).toBe(429);
		const locked = await change(u.cookie, 'correct horse', 'battery staple');
		expect(locked.status).toBe(429);
		expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
		expect(locked.body.error).toMatch(/too many sign-in attempts/);
		expect((await login(u.email, 'battery staple')).status).toBe(429);

		// Positive control: once the lock passes, the right password changes it and clears the count.
		await asOwner(`UPDATE login_throttle SET locked_until = now() - interval '1 second' WHERE email = $1`, [u.email]);
		expect((await change(u.cookie, 'correct horse', 'battery staple')).status).toBe(200);
		expect(await asOwner('SELECT 1 FROM login_throttle WHERE email = $1', [u.email])).toHaveLength(0);
	});

	it('refuses a new password that is too short, without counting an attempt or changing anything', async () => {
		const u = await signUp('Short');
		const res = await change(u.cookie, 'correct horse', 'short');
		expect(res.status).toBe(400);
		expect(JSON.stringify(res.body)).not.toMatch(/correct horse/);
		expect(await asOwner('SELECT 1 FROM login_throttle WHERE email = $1', [u.email])).toHaveLength(0);
		expect((await u.call('GET', '/auth/me')).status).toBe(200);
		expect((await login(u.email, 'correct horse')).status).toBe(200);
	});

	it('kills an outstanding password-reset link', async () => {
		const u = await signUp('Resetter');
		await anon('POST', '/auth/forgot-password', { email: u.email });
		const token = tokenIn(lastMailTo(u.email));
		expect((await change(u.cookie, 'correct horse', 'battery staple')).status).toBe(200);
		expect((await anon('POST', '/auth/reset-password', { token, password: 'someone else' })).status).toBe(400);
		expect((await login(u.email, 'battery staple')).status).toBe(200);
	});

	it('both routes need a session', async () => {
		expect((await anon('PATCH', '/auth/me', { displayName: 'X' })).status).toBe(401);
		expect((await anon('POST', '/auth/change-password', { currentPassword: 'a', newPassword: 'longenough' })).status).toBe(401);
	});
});
