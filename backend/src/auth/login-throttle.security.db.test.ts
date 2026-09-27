// Brute force and lockout boundaries the feature tests (auth.db.test.ts,
// email.db.test.ts) don't pin (docs/security.md § Authentication):
//   - the lockout is bounded: a stranger who keeps an address's shared
//     record locked can't keep its owner out, because a device that signed
//     in to the address (or reset its password) counts on its own record
//     (070_login_device_trust.sql, auth/device.ts);
//   - that trust is bound to the address, the account's session watermark
//     and the cookie's MAC, and a trusted device's own guesses still lock it;
//   - hammering during a lock never extends it, and a day without attempts
//     forgets the record;
//   - the reset-mail cooldown's boundary.
// Time is moved in the database (locked_until, last_attempt_at, created_at),
// never by sleeping. Every "cannot" has a positive control.
import { LEGAL_VERSION } from '@water-management/engine/legal';
import { describe, expect, it } from 'vitest';
import { anon, asOwner, lastMailTo, mailCount, signUp, tokenIn } from '../__tests__/helpers.js';
import { DEVICE_COOKIE, deviceCookieValue } from './device.js';

const login = (email: string, password: string, cookie?: string) => anon('POST', '/auth/login', { email, password }, cookie);

/** The `wm_device=…` pair a response set, or throws. */
function deviceOf(res: { headers: Headers }): string {
	const set = res.headers.getSetCookie().find((c) => c.startsWith(`${DEVICE_COOKIE}=`));
	const pair = set?.split(';')[0];
	if (!pair || pair === `${DEVICE_COOKIE}=`) throw new Error('no device cookie set');
	return pair;
}

/** Five wrong guesses from a browser with no device cookie: the shared record is locked. */
async function strangerLocks(email: string) {
	for (let i = 0; i < 5; i++) expect((await login(email, 'wrong guess')).status).toBe(401);
	expect((await login(email, 'correct horse')).status).toBe(429);
}

const lockedUntil = async (table: 'login_throttle' | 'login_device_throttle', email: string) =>
	(await asOwner(`SELECT locked_until FROM ${table} WHERE email = $1`, [email])).map((r) => (r.locked_until as Date).getTime());

describe('a stranger cannot keep an address locked against its owner', () => {
	it('a device that signed in before still signs in while the shared record is locked', async () => {
		const u = await signUp('Owner');
		const device = deviceOf(await login(u.email, 'correct horse'));
		await strangerLocks(u.email);

		const owner = await login(u.email, 'correct horse', device);
		expect(owner.status).toBe(200);
		// Positive control: the same request without the cookie is locked.
		expect((await login(u.email, 'correct horse')).status).toBe(429);
		// The owner's sign-in cleared only its own record: the stranger stays locked out.
		expect((await login(u.email, 'wrong guess')).status).toBe(429);
		expect(await lockedUntil('login_throttle', u.email)).toHaveLength(1);
	});

	it('a password reset trusts the browser that used the link, even if the stranger re-locks at once', async () => {
		const u = await signUp('Reset');
		await strangerLocks(u.email);
		await anon('POST', '/auth/forgot-password', { email: u.email });
		const reset = await anon('POST', '/auth/reset-password', { token: tokenIn(lastMailTo(u.email)), password: 'fresh password' });
		expect(reset.status).toBe(204);
		const device = deviceOf(reset);
		// The reset cleared the shared record; five more guesses lock it again before the owner signs in.
		await strangerLocks(u.email);
		expect((await login(u.email, 'fresh password', device)).status).toBe(200);
		// Positive control: a browser that didn't use the link is locked.
		expect((await login(u.email, 'fresh password')).status).toBe(429);
	});

	it('a new account trusts the browser that confirmed it (the link proved the inbox)', async () => {
		const email = `new-${crypto.randomUUID()}@example.com`;
		const made = await anon('POST', '/auth/register', { email, password: 'correct horse', displayName: 'New', acceptTerms: LEGAL_VERSION });
		expect(made.status).toBe(202);
		const confirmed = await anon('POST', '/auth/verify-email', { token: tokenIn(lastMailTo(email)) });
		expect(confirmed.status).toBe(200);
		await strangerLocks(email);
		expect((await login(email, 'correct horse', deviceOf(confirmed))).status).toBe(200);
		// Positive control: a browser that didn't open the link is locked.
		expect((await login(email, 'correct horse')).status).toBe(429);
	});

	it('a trusted device’s own guesses still lock it, doubling, capped at 15 minutes, never touching the shared record', async () => {
		const u = await signUp('Typo');
		const device = deviceOf(await login(u.email, 'correct horse'));
		for (let i = 0; i < 5; i++) expect((await login(u.email, 'wrong guess', device)).status).toBe(401);
		const locked = await login(u.email, 'correct horse', device);
		expect(locked.status).toBe(429);
		expect(locked.body.code).toBe('signin_locked');
		expect(Number(locked.headers.get('retry-after'))).toBeLessThanOrEqual(60);
		// Its guesses are its own: the shared record doesn't exist.
		expect(await asOwner('SELECT 1 FROM login_throttle WHERE email = $1', [u.email])).toHaveLength(0);

		// Lock over: one more wrong guess locks it for twice as long.
		await asOwner(`UPDATE login_device_throttle SET locked_until = now() - interval '1 second' WHERE email = $1`, [u.email]);
		expect((await login(u.email, 'wrong again', device)).status).toBe(401);
		const longer = await login(u.email, 'correct horse', device);
		expect(Number(longer.headers.get('retry-after'))).toBeGreaterThan(60);
		expect(Number(longer.headers.get('retry-after'))).toBeLessThanOrEqual(120);

		// The cap, as on the shared record.
		await asOwner(`UPDATE login_device_throttle SET failures = 40, locked_until = now() - interval '1 second' WHERE email = $1`, [u.email]);
		expect((await login(u.email, 'wrong again', device)).status).toBe(401);
		const capped = await login(u.email, 'correct horse', device);
		expect(Number(capped.headers.get('retry-after'))).toBeGreaterThan(14 * 60);
		expect(Number(capped.headers.get('retry-after'))).toBeLessThanOrEqual(15 * 60);

		// Positive control: once the lock passes, the right password works and clears the device's record.
		await asOwner(`UPDATE login_device_throttle SET locked_until = now() - interval '1 second' WHERE email = $1`, [u.email]);
		expect((await login(u.email, 'correct horse', device)).status).toBe(200);
		expect(await asOwner('SELECT 1 FROM login_device_throttle WHERE email = $1', [u.email])).toHaveLength(0);

		// A locked device doesn't lock the address for other browsers, and a
		// correct password on the shared record clears the devices' records too.
		for (let i = 0; i < 5; i++) await login(u.email, 'wrong guess', device);
		expect((await login(u.email, 'correct horse', device)).status).toBe(429);
		expect((await login(u.email, 'correct horse')).status).toBe(200);
		expect(await asOwner('SELECT 1 FROM login_device_throttle WHERE email = $1', [u.email])).toHaveLength(0);
	});

	it('the device table is closed to the app role (functions only)', async () => {
		const u = await signUp('Closed');
		const device = deviceOf(await login(u.email, 'correct horse'));
		await login(u.email, 'wrong guess', device);
		const { withUser } = await import('../db/tx.js');
		expect(await withUser(u.id, async (db) => (await db.query('SELECT * FROM login_device_throttle')).rowCount)).toBe(0);
		// Positive control: the row is there (as the owner).
		expect(await asOwner('SELECT failures FROM login_device_throttle WHERE email = $1', [u.email])).toEqual([{ failures: 1 }]);
	});
});

describe('device trust is bound to the address, the watermark and the MAC', () => {
	it('a device cookie for one address is a stranger on another', async () => {
		const mine = await signUp('Mine');
		const victim = await signUp('Victim');
		const device = deviceOf(await login(mine.email, 'correct horse'));
		await strangerLocks(victim.email);
		expect((await login(victim.email, 'correct horse', device)).status).toBe(429);
		// …and its guesses at the other address count on that address's shared record.
		await asOwner(`UPDATE login_throttle SET locked_until = now() - interval '1 second' WHERE email = $1`, [victim.email]);
		expect((await login(victim.email, 'wrong guess', device)).status).toBe(401);
		expect(await asOwner('SELECT failures FROM login_throttle WHERE email = $1', [victim.email])).toEqual([{ failures: 6 }]);
		expect(await asOwner('SELECT 1 FROM login_device_throttle WHERE email = $1', [victim.email])).toHaveLength(0);
		// Positive control: it is trusted on its own address.
		await strangerLocks(mine.email);
		expect((await login(mine.email, 'correct horse', device)).status).toBe(200);
	});

	it('a forged or tampered cookie is a stranger', async () => {
		const u = await signUp('Forged');
		const device = deviceOf(await login(u.email, 'correct horse'));
		await strangerLocks(u.email);
		const [, value] = device.split('=') as [string, string];
		const [id, mac] = value.split('.') as [string, string];
		const flipped = `${mac.slice(0, 10)}${mac[10] === 'A' ? 'B' : 'A'}${mac.slice(11)}`;
		for (const forged of [
			`${DEVICE_COOKIE}=${id}.${flipped}`,
			`${DEVICE_COOKIE}=${'A'.repeat(22)}.${mac}`,
			`${DEVICE_COOKIE}=${id}`,
			`${DEVICE_COOKIE}=${id}.${mac}x`,
			// Signed with another key.
			`${DEVICE_COOKIE}=${(() => {
				const saved = process.env.AUTH_JWT_SECRET;
				process.env.AUTH_JWT_SECRET = 'x'.repeat(40);
				try {
					return deviceCookieValue(u.email, null, id);
				} finally {
					process.env.AUTH_JWT_SECRET = saved;
				}
			})()}`
		]) {
			expect((await login(u.email, 'correct horse', forged)).status, forged).toBe(429);
		}
		// Positive control: the genuine cookie, and one minted with the right key.
		expect((await login(u.email, 'correct horse', device)).status).toBe(200);
		expect((await login(u.email, 'correct horse', `${DEVICE_COOKIE}=${deviceCookieValue(u.email, null, id)}`)).status).toBe(200);
	});

	it('signing out everywhere, a password change or a reset retires every older device', async () => {
		const u = await signUp('Retire');
		const old = deviceOf(await login(u.email, 'correct horse'));
		const session = (await login(u.email, 'correct horse', old)).headers.getSetCookie()[0]!.split(';')[0]!;

		// Sign out everywhere: the old cookie is a stranger now.
		const out = await anon('POST', '/auth/logout-everywhere', undefined, session);
		expect(out.status).toBe(204);
		expect(out.headers.getSetCookie().some((c) => c.startsWith(`${DEVICE_COOKIE}=;`))).toBe(true);
		await strangerLocks(u.email);
		expect((await login(u.email, 'correct horse', old)).status).toBe(429);

		// A reset (from another browser) trusts that browser only.
		await anon('POST', '/auth/forgot-password', { email: u.email });
		const reset = await anon('POST', '/auth/reset-password', { token: tokenIn(lastMailTo(u.email)), password: 'second password' });
		const fresh = deviceOf(reset);
		const signedIn = await login(u.email, 'second password', fresh);
		expect(signedIn.status).toBe(200);

		// A password change keeps the changing browser trusted, and retires the rest.
		const other = deviceOf(await login(u.email, 'second password'));
		const changed = await anon(
			'POST',
			'/auth/change-password',
			{ currentPassword: 'second password', newPassword: 'third password' },
			`${signedIn.headers.getSetCookie()[0]!.split(';')[0]!}; ${deviceOf(signedIn)}`
		);
		expect(changed.status).toBe(200);
		const kept = deviceOf(changed);
		await strangerLocks(u.email);
		expect((await login(u.email, 'third password', other)).status).toBe(429);
		expect((await login(u.email, 'third password', kept)).status).toBe(200);
	});
});

describe('lock boundaries', () => {
	it('attempts during a lock never extend it (shared record and device record)', async () => {
		const u = await signUp('Hammer');
		const device = deviceOf(await login(u.email, 'correct horse'));
		await strangerLocks(u.email);
		for (let i = 0; i < 5; i++) await login(u.email, 'wrong guess', device);
		const before = { shared: await lockedUntil('login_throttle', u.email), device: await lockedUntil('login_device_throttle', u.email) };
		expect(before.shared).toHaveLength(1);
		expect(before.device).toHaveLength(1);
		for (let i = 0; i < 10; i++) {
			expect((await login(u.email, 'wrong guess')).status).toBe(429);
			expect((await login(u.email, 'wrong guess', device)).status).toBe(429);
		}
		expect(await lockedUntil('login_throttle', u.email)).toEqual(before.shared);
		expect(await lockedUntil('login_device_throttle', u.email)).toEqual(before.device);
		// Positive control: an attempt after the lock ends does move it.
		await asOwner(`UPDATE login_throttle SET locked_until = now() - interval '1 second' WHERE email = $1`, [u.email]);
		expect((await login(u.email, 'wrong guess')).status).toBe(401);
		expect((await lockedUntil('login_throttle', u.email))[0]).toBeGreaterThan(Date.now() + 60_000);
	});

	it('a day without attempts forgets the record; less than a day does not', async () => {
		const u = await signUp('Forget');
		const device = deviceOf(await login(u.email, 'correct horse'));
		const seed = async (age: string) => {
			await asOwner(`DELETE FROM login_throttle WHERE email = $1`, [u.email]);
			await asOwner(`DELETE FROM login_device_throttle WHERE email = $1`, [u.email]);
			await asOwner(`INSERT INTO login_throttle (email, failures, last_attempt_at) VALUES ($1, 40, now() - $2::interval)`, [u.email, age]);
			await asOwner(
				`INSERT INTO login_device_throttle (email, device, failures, last_attempt_at) VALUES ($1, $2, 40, now() - $3::interval)`,
				[u.email, device.split('=')[1]!.split('.')[0], age]
			);
		};
		// 23 hours: remembered, so one more guess locks for the full 15 minutes.
		await seed('23 hours');
		expect((await login(u.email, 'wrong guess')).status).toBe(401);
		expect((await login(u.email, 'wrong guess', device)).status).toBe(401);
		expect((await login(u.email, 'correct horse')).status).toBe(429);
		expect((await login(u.email, 'correct horse', device)).status).toBe(429);
		// 25 hours: forgotten, so the count starts again at one.
		await seed('25 hours');
		expect((await login(u.email, 'wrong guess')).status).toBe(401);
		expect((await login(u.email, 'wrong guess', device)).status).toBe(401);
		expect(await asOwner('SELECT failures FROM login_throttle WHERE email = $1', [u.email])).toEqual([{ failures: 1 }]);
		expect(await asOwner('SELECT failures FROM login_device_throttle WHERE email = $1', [u.email])).toEqual([{ failures: 1 }]);
	});

	it('the reset-mail cooldown holds for a minute and not longer, answering 202 either way', async () => {
		const u = await signUp('Cooldown');
		const before = mailCount(u.email);
		expect((await anon('POST', '/auth/forgot-password', { email: u.email })).status).toBe(202);
		expect(mailCount(u.email)).toBe(before + 1);
		const age = (a: string) => asOwner(`UPDATE email_token SET created_at = now() - $2::interval WHERE user_id = $1 AND purpose = 'reset'`, [u.id, a]);
		await age('50 seconds');
		const held = await anon('POST', '/auth/forgot-password', { email: u.email });
		expect(held).toMatchObject({ status: 202, body: { ok: true } });
		expect(mailCount(u.email)).toBe(before + 1);
		await age('70 seconds');
		expect((await anon('POST', '/auth/forgot-password', { email: u.email })).status).toBe(202);
		expect(mailCount(u.email)).toBe(before + 2);
	});
});
