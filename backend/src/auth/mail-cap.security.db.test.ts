// The daily cap on reset and verification emails per address
// (078_account_mail_cap.sql, auth/email-routes.ts; docs/security.md
// § Password reset, email verification and invites):
//   - at most ACCOUNT_MAIL_CAP in a rolling 24 hours on the address's shared
//     count, so a distributed sender can't mail one inbox all day;
//   - the window's edge: an email 24 hours old no longer counts;
//   - a browser holding a valid `wm_device` cookie for the address counts on
//     its own allowance, so a stranger who used up the shared count can't
//     block the owner's reset (and that allowance is capped too);
//   - forgot-password answers the same 202 whether the cap held the email
//     back, the address has an account or not.
// Time is moved in the database (email_token.created_at for the one-minute
// cooldown, account_mail_quota.sent_at for the window), never by sleeping.
// Every "cannot" has a positive control: under the cap the email goes out.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { anon, asOwner, lastMailTo, mailCount, signUp, tokenIn } from '../__tests__/helpers.js';
import { DEVICE_COOKIE, deviceCookieValue } from './device.js';
import { ACCOUNT_MAIL_CAP } from './tokens.js';
import { withUser } from '../db/tx.js';

const forgot = (email: string, cookie?: string) => anon('POST', '/auth/forgot-password', { email }, cookie);

/** The `wm_device=…` pair a response set, or throws. */
function deviceOf(res: { headers: Headers }): string {
	const set = res.headers.getSetCookie().find((c) => c.startsWith(`${DEVICE_COOKIE}=`));
	const pair = set?.split(';')[0];
	if (!pair || pair === `${DEVICE_COOKIE}=`) throw new Error('no device cookie set');
	return pair;
}
/** The device id inside a `wm_device=<id>.<mac>` pair. */
const deviceId = (pair: string) => pair.slice(DEVICE_COOKIE.length + 1).split('.')[0]!;

/** Past the one-minute cooldown, so only the cap decides. */
const pastCooldown = (userId: string) =>
	asOwner(`UPDATE email_token SET created_at = now() - interval '2 minutes' WHERE user_id = $1`, [userId]);

/** Emails on the account's count: the shared one (device null) or a device's. */
const counted = async (userId: string, device: string | null = null) =>
	Number(
		(
			await asOwner('SELECT count(*) AS n FROM account_mail_quota WHERE user_id = $1 AND device IS NOT DISTINCT FROM $2', [
				userId,
				device
			])
		)[0]!.n
	);

/** Fill a count up to the cap with emails sent `ago` (as if a stranger had asked). */
async function fill(userId: string, ago = '1 hour', device: string | null = null) {
	const have = await counted(userId, device);
	await asOwner(
		`INSERT INTO account_mail_quota (user_id, device, sent_at)
		 SELECT $1, $2, now() - $3::interval FROM generate_series(1, $4)`,
		[userId, device, ago, ACCOUNT_MAIL_CAP - have]
	);
	expect(await counted(userId, device)).toBe(ACCOUNT_MAIL_CAP);
}

describe('the daily cap on reset and verification emails', () => {
	it('sends up to the cap in a day, then no more, answering 202 like an unknown address', async () => {
		const u = await signUp('Cap');
		// The sign-up's verification email is on the shared count.
		expect(await counted(u.id)).toBe(1);
		const before = mailCount(u.email);
		// Positive control: every request under the cap is mailed.
		for (let i = 1; i < ACCOUNT_MAIL_CAP; i++) {
			await pastCooldown(u.id);
			expect(await forgot(u.email)).toMatchObject({ status: 202, body: { ok: true } });
			expect(mailCount(u.email)).toBe(before + i);
		}
		expect(await counted(u.id)).toBe(ACCOUNT_MAIL_CAP);
		const token = tokenIn(lastMailTo(u.email));

		await pastCooldown(u.id);
		const capped = await forgot(u.email);
		const unknown = await forgot(`nobody-${crypto.randomUUID()}@example.com`);
		expect(mailCount(u.email)).toBe(before + ACCOUNT_MAIL_CAP - 1);
		// No enumeration: the same answer as an address with no account.
		expect(capped.status).toBe(202);
		expect(capped).toMatchObject({ status: unknown.status, body: unknown.body });
		// Refused before the token table: the last link mailed still works.
		expect((await anon('POST', '/auth/reset-password', { token, password: 'brand new password' })).status).toBe(204);
	});

	it('an email 24 hours old stops counting; one a minute younger still counts', async () => {
		const u = await signUp('Window');
		await pastCooldown(u.id);
		await fill(u.id, '23 hours 59 minutes');
		const before = mailCount(u.email);
		expect((await forgot(u.email)).status).toBe(202);
		expect(mailCount(u.email)).toBe(before);

		// The oldest one reaches the window's edge: one email is free again.
		await asOwner(
			`UPDATE account_mail_quota SET sent_at = now() - interval '24 hours'
			 WHERE ctid = (SELECT ctid FROM account_mail_quota WHERE user_id = $1 ORDER BY sent_at LIMIT 1)`,
			[u.id]
		);
		expect((await forgot(u.email)).status).toBe(202);
		expect(mailCount(u.email)).toBe(before + 1);
		// …and only one: that email filled the count again.
		await pastCooldown(u.id);
		expect((await forgot(u.email)).status).toBe(202);
		expect(mailCount(u.email)).toBe(before + 1);
		expect(await counted(u.id)).toBe(ACCOUNT_MAIL_CAP);
	});

	it('a browser trusted for the address still gets its reset link once a stranger used up the shared count', async () => {
		const u = await signUp('Owner');
		const device = deviceOf(await anon('POST', '/auth/login', { email: u.email, password: 'correct horse' }));
		await pastCooldown(u.id);
		await fill(u.id);
		const before = mailCount(u.email);
		// Positive control: the stranger's request (no cookie) is held back.
		expect((await forgot(u.email)).status).toBe(202);
		expect(mailCount(u.email)).toBe(before);

		const owner = await forgot(u.email, device);
		expect(owner).toMatchObject({ status: 202, body: { ok: true } });
		expect(mailCount(u.email)).toBe(before + 1);
		// It counted on the device's own allowance, not the shared count.
		expect(await counted(u.id, deviceId(device))).toBe(1);
		expect(await counted(u.id)).toBe(ACCOUNT_MAIL_CAP);
		// The link works.
		expect((await anon('POST', '/auth/reset-password', { token: tokenIn(lastMailTo(u.email)), password: 'fresh password' })).status).toBe(204);
	});

	it('a device’s own allowance is capped too, and a cookie for another address counts on the shared count', async () => {
		const u = await signUp('Device');
		const other = await signUp('Other');
		const device = deviceOf(await anon('POST', '/auth/login', { email: u.email, password: 'correct horse' }));
		const otherDevice = deviceOf(await anon('POST', '/auth/login', { email: other.email, password: 'correct horse' }));
		await pastCooldown(u.id);
		await fill(u.id);
		await fill(u.id, '1 hour', deviceId(device));
		const before = mailCount(u.email);
		expect((await forgot(u.email, device)).status).toBe(202);
		// Another address's device is no device of this one's: the shared count, full.
		expect((await forgot(u.email, otherDevice)).status).toBe(202);
		expect(mailCount(u.email)).toBe(before);

		// Positive control: once one of the device's emails leaves the window, it is mailed again.
		await asOwner(
			`UPDATE account_mail_quota SET sent_at = now() - interval '25 hours'
			 WHERE ctid = (SELECT ctid FROM account_mail_quota WHERE user_id = $1 AND device = $2 LIMIT 1)`,
			[u.id, deviceId(device)]
		);
		expect((await forgot(u.email, device)).status).toBe(202);
		expect(mailCount(u.email)).toBe(before + 1);
	});

	it('resend-verification says the day’s limit is reached (not “a moment ago”), and a trusted browser still gets one', async () => {
		// A signed-in, unconfirmed account (a session from before confirmation
		// was required, issue #57) on a browser trusted for its address.
		const u = await signUp('Resend', { verified: false });
		const { email, id } = u;
		const session = u.cookie;
		const device = `${DEVICE_COOKIE}=${deviceCookieValue(email, null, randomBytes(16).toString('base64url'))}`;
		await pastCooldown(id);
		await fill(id);
		const before = mailCount(email);

		const capped = await anon('POST', '/auth/resend-verification', undefined, session);
		expect(capped.status).toBe(429);
		expect(capped.body.code).toBe('verification_limit');
		expect(mailCount(email)).toBe(before);

		// Positive control: the trusted browser still gets one.
		const resent = await anon('POST', '/auth/resend-verification', undefined, `${session}; ${device}`);
		expect(resent.status).toBe(202);
		expect(mailCount(email)).toBe(before + 1);
		expect(lastMailTo(email)?.subject).toMatch(/Confirm your email/);
		// Right after, the cooldown answers first.
		const again = await anon('POST', '/auth/resend-verification', undefined, `${session}; ${device}`);
		expect(again).toMatchObject({ status: 429, body: { code: 'verification_sent_recently' } });
	});

	it('the count is closed to water_app outside the function', async () => {
		const u = await signUp('Closed');
		expect(await withUser(u.id, async (db) => (await db.query('SELECT * FROM account_mail_quota')).rowCount)).toBe(0);
		// Positive control: the owner sees the sign-up's row.
		expect(await counted(u.id)).toBe(1);
	});
});
