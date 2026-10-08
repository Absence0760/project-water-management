// Recovering a lost second factor, end to end through the API (205_mfa_recovery,
// auth/mfaReset.ts, auth/mfa-reset-routes.ts, teams/mfa-reset-routes.ts;
// docs/security.md § Two-step sign-in → Recovery): asking at the sign-in's
// code step, the confirmation link, the 3-day wait and its reminders, the
// tick completing it, every way it is cancelled, the dead links, the cap, one
// reset at a time, RLS on the new tables, and a team admin's reset of a member.
//
// Time: the wait is moved in the database (the rows' timestamps backdated as
// the schema owner), never slept; the process clock (Date only) moves one
// 30-second step before each code, as in mfa.db.test.ts. The email dates are
// checked under a skewed TZ (CLAUDE.md rule 7): they are South African time
// whatever the server's zone.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { anon, asOwner, lastMailTo, mailCount, signUp, tokenIn } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { outbox } from '../mail/transport.js';
import { MFA_CHALLENGE_COOKIE, SESSION_COOKIE } from './session.js';
import { MFA_RESET_CAP, runMfaResets } from './mfaReset.js';
import { base32Decode, totp } from './totp.js';

type User = Awaited<ReturnType<typeof signUp>>;
const zone = process.env.TZ;

beforeAll(() => {
	vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
	// Far from South Africa: a date written in the server's zone instead of SAST would show.
	process.env.TZ = 'Pacific/Kiritimati';
});
afterAll(() => {
	vi.useRealTimers();
	process.env.TZ = zone;
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

function code(secret: string): string {
	vi.setSystemTime(Date.now() + 30_000);
	return totp(base32Decode(secret)!, Date.now());
}
const cookieOf = (h: Headers, name: string) => {
	const c = h.getSetCookie().find((x) => x.startsWith(`${name}=`));
	return c ? c.split(';')[0]! : undefined;
};

/** Sign up and add an authenticator: the user, the secret, and the two-step session the confirm gave. */
async function enrolled(name: string) {
	const u = await signUp(name);
	const { secret } = (await u.call('POST', '/auth/mfa/totp/enrol', { password: 'correct horse' })).body;
	const r = await anon('POST', '/auth/mfa/totp/confirm', { code: code(secret) }, u.cookie);
	expect(r.status).toBe(200);
	return { ...u, secret: secret as string, twoStep: cookieOf(r.headers, SESSION_COOKIE)! };
}

/** The sign-in challenge a right password buys. */
async function challenge(u: { email: string }): Promise<string> {
	const r = await anon('POST', '/auth/login', { email: u.email, password: 'correct horse' });
	expect(r.body).toEqual({ mfaRequired: true });
	return cookieOf(r.headers, MFA_CHALLENGE_COOKIE)!;
}

/** Ask for a reset with a fresh challenge; the confirmation link's token from the email. */
async function ask(u: { email: string }): Promise<string> {
	const r = await anon('POST', '/auth/mfa/reset', undefined, await challenge(u));
	expect(r).toMatchObject({ status: 202, body: { sent: true } });
	const mail = lastMailTo(u.email)!;
	expect(mail.kind).toBe('mfa_reset');
	expect(mail.text).toContain('/mfa-reset?token=');
	return tokenIn(mail);
}

/** Ask and confirm: the wait has started. The first cancel link's token. */
async function started(u: { email: string }): Promise<string> {
	const r = await anon('POST', '/auth/mfa/reset/confirm', { token: await ask(u) });
	expect(r.status).toBe(200);
	const mail = lastMailTo(u.email)!;
	expect(mail.text).toContain('/mfa-reset/cancel?token=');
	return tokenIn(mail);
}

const resets = (userId: string) =>
	asOwner('SELECT confirmed_at, effective_at, ended_at, end_reason FROM mfa_reset WHERE user_id = $1 ORDER BY requested_at', [userId]);
const events = async (userId: string) =>
	(await asOwner('SELECT kind FROM account_security_event WHERE user_id = $1 ORDER BY id', [userId])).map((r) => r.kind as string);
const hasFactor = async (userId: string) => (await asOwner('SELECT 1 FROM user_totp WHERE user_id = $1', [userId])).length > 0;
/** The wait is over: the reset's end moved into the past. */
const endWait = (userId: string) =>
	asOwner(`UPDATE mfa_reset SET effective_at = now() - interval '1 second' WHERE user_id = $1 AND ended_at IS NULL`, [userId]);

describe('the self-service reset', () => {
	it('asking changes nothing; the link starts a 3-day wait; the tick then removes every factor and signs every session out', async () => {
		const u = await enrolled('ResetLife');
		const token = await ask(u);
		// Nothing changed: the factor works, no wait has started.
		expect(await hasFactor(u.id)).toBe(true);
		expect(await resets(u.id)).toEqual([expect.objectContaining({ confirmed_at: null, ended_at: null })]);

		const before = Date.now();
		const r = await anon('POST', '/auth/mfa/reset/confirm', { token });
		expect(r.status).toBe(200);
		const effectiveAt = new Date(r.body.effectiveAt).getTime();
		// 72 hours from the database's now (the process clock may run a few code steps ahead).
		const [row] = await resets(u.id);
		expect(row.effective_at.getTime() - row.confirmed_at.getTime()).toBe(72 * 3600 * 1000);
		expect(effectiveAt).toBe(row.effective_at.getTime());
		expect(effectiveAt).toBeGreaterThan(before - 3600_000);

		// The "started" email: the date and time in South African time, and a cancel link.
		const mail = lastMailTo(u.email)!;
		const sast = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Africa/Johannesburg' }).format(row.effective_at);
		expect(mail.text).toContain(`${sast} SAST`);
		expect(mail.subject).toMatch(/^Two-step sign-in will be removed on \d{1,2} \w{3} \d{4} — Water Management$/);
		expect(mail.html).toContain('/mfa-reset/cancel?token=');

		// The Account page sees it; the factor still works through the wait.
		const status = await anon('GET', '/auth/mfa', undefined, u.twoStep);
		expect(status.body.pendingReset).toEqual({ effectiveAt: row.effective_at.toISOString() });
		expect(await hasFactor(u.id)).toBe(true);

		// Not due yet: the tick leaves it.
		await runMfaResets();
		expect(await hasFactor(u.id)).toBe(true);

		await endWait(u.id);
		const sent = mailCount(u.email);
		// The process clock is frozen (fake Date): move it on, as real time would, so the watermark is after the sessions.
		vi.setSystemTime(Date.now() + 1000);
		const tick = await runMfaResets();
		expect(tick.completed).toBeGreaterThanOrEqual(1);
		expect(await hasFactor(u.id)).toBe(false);
		expect(await asOwner('SELECT 1 FROM user_recovery_code WHERE user_id = $1', [u.id])).toEqual([]);
		expect((await resets(u.id)).at(-1)).toMatchObject({ end_reason: 'completed' });
		// Every session is signed out (the watermark), the two-step one included.
		expect((await anon('GET', '/auth/me', undefined, u.twoStep)).status).toBe(401);
		expect((await anon('GET', '/auth/me', undefined, u.cookie)).status).toBe(401);
		// The completion email, once.
		expect(mailCount(u.email)).toBe(sent + 1);
		expect(lastMailTo(u.email)!.subject).toBe('Two-step sign-in was removed — Water Management');
		// A second tick has nothing more to do for it.
		await runMfaResets();
		expect(mailCount(u.email)).toBe(sent + 1);
		// The password alone signs in now (positive control: the account works).
		const login = await anon('POST', '/auth/login', { email: u.email, password: 'correct horse' });
		expect(login.status).toBe(200);
		expect(login.body.user.id).toBe(u.id);
		expect(await events(u.id)).toEqual(['mfa.enrolled', 'mfa.reset_requested', 'mfa.reset_confirmed', 'mfa.reset_completed']);
	});

	it('sends a reminder a day after the last notice, each with its own cancel link, and every link works until the end', async () => {
		const u = await enrolled('ResetRemind');
		const first = await started(u);
		const sent = mailCount(u.email);
		// Not a day yet: no reminder.
		await runMfaResets();
		expect(mailCount(u.email)).toBe(sent);
		await asOwner(`UPDATE mfa_reset SET notified_at = notified_at - interval '25 hours' WHERE user_id = $1`, [u.id]);
		await runMfaResets();
		expect(mailCount(u.email)).toBe(sent + 1);
		const reminder = lastMailTo(u.email)!;
		expect(reminder.text).toContain('is still waiting');
		const second = tokenIn(reminder);
		expect(second).not.toBe(first);
		// Once a day: a second tick sends nothing.
		await runMfaResets();
		expect(mailCount(u.email)).toBe(sent + 1);
		// The first link still cancels (the reminder didn't void it) ...
		expect(await anon('POST', '/auth/mfa/reset/cancel', { token: first })).toMatchObject({ status: 200, body: { cancelled: true } });
		// ... and then neither link does anything more: the reset has ended.
		expect(await anon('POST', '/auth/mfa/reset/cancel', { token: second })).toMatchObject({ status: 400, body: { code: 'link_invalid' } });
		expect(await anon('POST', '/auth/mfa/reset/cancel', { token: first })).toMatchObject({ status: 400, body: { code: 'link_invalid' } });
	});

	it('skips the reminder when the end is near: the completion email says it', async () => {
		const u = await enrolled('ResetNear');
		await started(u);
		await asOwner(`UPDATE mfa_reset SET notified_at = now() - interval '25 hours', effective_at = now() + interval '1 hour' WHERE user_id = $1`, [u.id]);
		const sent = mailCount(u.email);
		await runMfaResets();
		expect(mailCount(u.email)).toBe(sent);
	});

	it('the cancel link ends the wait without signing in, and the tick then removes nothing', async () => {
		const u = await enrolled('ResetCancel');
		const cancel = await started(u);
		expect(await anon('POST', '/auth/mfa/reset/cancel', { token: cancel })).toMatchObject({ status: 200, body: { cancelled: true } });
		expect((await resets(u.id)).at(-1)).toMatchObject({ end_reason: 'cancel_link' });
		await asOwner(`UPDATE mfa_reset SET effective_at = now() - interval '1 second' WHERE user_id = $1`, [u.id]);
		await runMfaResets();
		expect(await hasFactor(u.id)).toBe(true);
		// Still signed in: nothing moved the watermark.
		expect((await anon('GET', '/auth/me', undefined, u.twoStep)).status).toBe(200);
		expect(await events(u.id)).toEqual(['mfa.enrolled', 'mfa.reset_requested', 'mfa.reset_confirmed', 'mfa.reset_cancelled']);
	});

	it('a sign-in with a code cancels a waiting reset (the owner has their factor)', async () => {
		const u = await enrolled('ResetCode');
		const cancel = await started(u);
		const ch = await challenge(u);
		expect((await anon('POST', '/auth/mfa/verify', { code: code(u.secret) }, ch)).status).toBe(200);
		expect((await resets(u.id)).at(-1)).toMatchObject({ end_reason: 'code_used' });
		// Its cancel links died with it.
		expect((await anon('POST', '/auth/mfa/reset/cancel', { token: cancel })).status).toBe(400);
		await endWait(u.id);
		await runMfaResets();
		expect(await hasFactor(u.id)).toBe(true);
	});

	it('a step-up with a code cancels it too, and so does turning the factor off', async () => {
		const a = await enrolled('ResetStepUp');
		await started(a);
		expect((await anon('POST', '/auth/mfa/step-up', { code: code(a.secret) }, a.twoStep)).status).toBe(200);
		expect((await resets(a.id)).at(-1)).toMatchObject({ end_reason: 'code_used' });

		const b = await enrolled('ResetOff');
		await started(b);
		expect((await anon('DELETE', '/auth/mfa/totp', { code: code(b.secret) }, b.twoStep)).status).toBe(204);
		expect((await resets(b.id)).at(-1)).toMatchObject({ end_reason: 'factor_removed' });
		expect(await events(b.id)).toEqual(['mfa.enrolled', 'mfa.reset_requested', 'mfa.reset_confirmed', 'mfa.reset_cancelled', 'mfa.disabled']);
	});

	it('a confirmation link works once, and not after its hour (positive control: a fresh one works)', async () => {
		const u = await enrolled('ResetLinks');
		const stale = await ask(u);
		await asOwner(`UPDATE mfa_reset SET confirm_expires_at = now() - interval '1 second' WHERE user_id = $1`, [u.id]);
		expect(await anon('POST', '/auth/mfa/reset/confirm', { token: stale })).toMatchObject({ status: 400, body: { code: 'link_invalid' } });
		const fresh = await ask(u);
		// Asking again voided nothing that worked, and ended the lapsed request.
		expect((await resets(u.id))[0]).toMatchObject({ end_reason: 'unconfirmed' });
		expect((await anon('POST', '/auth/mfa/reset/confirm', { token: fresh })).status).toBe(200);
		expect(await anon('POST', '/auth/mfa/reset/confirm', { token: fresh })).toMatchObject({ status: 400, body: { code: 'link_invalid' } });
		// Malformed, or another kind's token: refused before or at the lookup.
		expect((await anon('POST', '/auth/mfa/reset/confirm', { token: 'not-a-token' })).status).toBe(400);
		expect((await anon('POST', '/auth/mfa/reset/cancel', { token: fresh })).status).toBe(400);
	});

	it('a new request voids the earlier unused link: one link at a time', async () => {
		const u = await enrolled('ResetReplace');
		const first = await ask(u);
		const second = await ask(u);
		expect((await anon('POST', '/auth/mfa/reset/confirm', { token: first })).status).toBe(400);
		expect((await anon('POST', '/auth/mfa/reset/confirm', { token: second })).status).toBe(200);
	});

	it('one reset at a time: asking while one waits says when it ends and sends nothing', async () => {
		const u = await enrolled('ResetOne');
		await started(u);
		const sent = mailCount(u.email);
		const r = await anon('POST', '/auth/mfa/reset', undefined, await challenge(u));
		const [row] = await resets(u.id);
		expect(r).toMatchObject({ status: 200, body: { pending: true, effectiveAt: row.effective_at.toISOString() } });
		expect(mailCount(u.email)).toBe(sent);
		expect(await asOwner('SELECT count(*)::int AS n FROM mfa_reset WHERE user_id = $1 AND ended_at IS NULL', [u.id])).toEqual([{ n: 1 }]);
	});

	it('caps the emails: MFA_RESET_CAP requests a day, then 429 mfa_reset_limit with nothing sent, logged as login_failed', async () => {
		const u = await enrolled('ResetCap');
		for (let i = 0; i < MFA_RESET_CAP; i++) await ask(u);
		const sent = mailCount(u.email);
		const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const r = await anon('POST', '/auth/mfa/reset', undefined, await challenge(u));
		expect(r).toMatchObject({ status: 429, body: { code: 'mfa_reset_limit' } });
		expect(mailCount(u.email)).toBe(sent);
		const lines = log.mock.calls.map((c) => String(c[0]));
		expect(lines.some((l) => l.includes('"event":"login_failed"') && l.includes('"route":"/auth/mfa/reset"') && l.includes('"reason":"locked"'))).toBe(true);
		// A day later the count is forgotten (positive control).
		await asOwner(`UPDATE mfa_reset_quota SET sent_at = sent_at - interval '25 hours' WHERE user_id = $1`, [u.id]);
		await ask(u);
	});

	it('needs a live sign-in challenge: no cookie, a session cookie or a used challenge get 401', async () => {
		const u = await enrolled('ResetNoChallenge');
		expect(await anon('POST', '/auth/mfa/reset')).toMatchObject({ status: 401, body: { code: 'mfa_challenge_expired' } });
		expect((await anon('POST', '/auth/mfa/reset', undefined, u.twoStep)).status).toBe(401);
		const ch = await challenge(u);
		expect((await anon('POST', '/auth/mfa/verify', { code: code(u.secret) }, ch)).status).toBe(200);
		expect((await anon('POST', '/auth/mfa/reset', undefined, ch)).status).toBe(401);
		expect(await asOwner('SELECT 1 FROM mfa_reset WHERE user_id = $1', [u.id])).toEqual([]);
	});
});

describe('the self-service reset: edges', () => {
	it('a token of another kind is refused at each link, and refusing consumes nothing (positive control: each then works in its own place)', async () => {
		const u = await enrolled('ResetKinds');
		const confirm = await ask(u);
		expect((await anon('POST', '/auth/forgot-password', { email: u.email })).status).toBe(202);
		const passwordReset = tokenIn(lastMailTo(u.email));
		expect((await anon('POST', '/auth/mfa/reset/confirm', { token: passwordReset })).status).toBe(400);
		expect((await anon('POST', '/auth/mfa/reset/cancel', { token: passwordReset })).status).toBe(400);
		expect((await anon('POST', '/auth/mfa/reset/cancel', { token: confirm })).status).toBe(400);
		expect((await anon('POST', '/auth/reset-password', { token: confirm, password: 'a brand new password' })).status).toBe(400);
		expect((await anon('POST', '/auth/mfa/reset/confirm', { token: confirm })).status).toBe(200);
		const cancel = tokenIn(lastMailTo(u.email));
		expect((await anon('POST', '/auth/mfa/reset/confirm', { token: cancel })).status).toBe(400);
		expect((await anon('POST', '/auth/reset-password', { token: cancel, password: 'a brand new password' })).status).toBe(400);
		expect((await anon('POST', '/auth/mfa/reset/cancel', { token: cancel })).status).toBe(200);
		expect((await anon('POST', '/auth/reset-password', { token: passwordReset, password: 'a brand new password' })).status).toBe(204);
	});

	it('a link ends only its own account’s reset (positive control: the other account’s still waits, and its own link ends it)', async () => {
		const a = await enrolled('ResetOwnA');
		const b = await enrolled('ResetOwnB');
		const cancelA = await started(a);
		const cancelB = await started(b);
		expect((await anon('POST', '/auth/mfa/reset/cancel', { token: cancelA })).status).toBe(200);
		expect((await resets(a.id)).at(-1)).toMatchObject({ end_reason: 'cancel_link' });
		expect((await resets(b.id)).at(-1)).toMatchObject({ ended_at: null });
		expect((await anon('POST', '/auth/mfa/reset/cancel', { token: cancelB })).status).toBe(200);
		expect((await resets(b.id)).at(-1)).toMatchObject({ end_reason: 'cancel_link' });
	});

	it('the cap at its boundary: request N−1 and N are sent, N+1 is refused', async () => {
		const u = await enrolled('ResetBoundary');
		for (let i = 1; i <= MFA_RESET_CAP - 1; i++) await ask(u);
		const before = mailCount(u.email);
		// The Nth: still sent.
		await ask(u);
		expect(mailCount(u.email)).toBe(before + 1);
		// N+1: refused, nothing sent, and the Nth link still works.
		const n = tokenIn(lastMailTo(u.email));
		expect((await anon('POST', '/auth/mfa/reset', undefined, await challenge(u))).status).toBe(429);
		expect(mailCount(u.email)).toBe(before + 1);
		expect((await anon('POST', '/auth/mfa/reset/confirm', { token: n })).status).toBe(200);
		expect(await asOwner('SELECT count(*)::int AS n FROM mfa_reset_quota WHERE user_id = $1', [u.id])).toEqual([{ n: MFA_RESET_CAP }]);
	});

	it('requests at the same moment leave one open request, and the cap counts each', async () => {
		const u = await enrolled('ResetRace');
		const challenges = await Promise.all([challenge(u), challenge(u), challenge(u)]);
		const answers = await Promise.all(challenges.map((ch) => anon('POST', '/auth/mfa/reset', undefined, ch)));
		expect(answers.map((r) => r.status).sort()).toEqual([202, 202, 202]);
		expect(await asOwner('SELECT count(*)::int AS n FROM mfa_reset WHERE user_id = $1 AND ended_at IS NULL', [u.id])).toEqual([{ n: 1 }]);
		expect(await asOwner('SELECT count(*)::int AS n FROM mfa_reset_quota WHERE user_id = $1', [u.id])).toEqual([{ n: 3 }]);
		// Only the newest link works: one link at a time.
		const tokens = outbox.filter((m) => m.to === u.email && m.subject.startsWith('Confirm removing')).slice(-3).map((m) => tokenIn(m));
		const confirmed = await Promise.all(tokens.map((token) => anon('POST', '/auth/mfa/reset/confirm', { token })));
		expect(confirmed.filter((r) => r.status === 200)).toHaveLength(1);
		// And a second confirmed reset can't open while one waits.
		expect((await anon('POST', '/auth/mfa/reset', undefined, await challenge(u))).body).toMatchObject({ pending: true });
	});

	it('the tick does nothing before effective_at, whatever the process clock and zone say; at it, it completes once', async () => {
		const u = await enrolled('ResetBefore');
		await started(u);
		// The end two seconds away in the database, and the process clock four days ahead: the database clock decides.
		await asOwner(`UPDATE mfa_reset SET effective_at = now() + interval '2 seconds' WHERE user_id = $1 AND ended_at IS NULL`, [u.id]);
		const now = Date.now();
		vi.setSystemTime(now + 4 * 24 * 3600 * 1000);
		await runMfaResets();
		vi.setSystemTime(now + 1000);
		expect(await hasFactor(u.id)).toBe(true);
		expect((await resets(u.id)).at(-1)).toMatchObject({ ended_at: null });
		await endWait(u.id);
		const sent = mailCount(u.email);
		await runMfaResets();
		expect(await hasFactor(u.id)).toBe(false);
		expect(mailCount(u.email)).toBe(sent + 1);
	});

	it('the tick is idempotent: run again after completing, it removes nothing more and sends no second email', async () => {
		const u = await enrolled('ResetTwice');
		await started(u);
		await endWait(u.id);
		vi.setSystemTime(Date.now() + 1000);
		await runMfaResets();
		expect(await hasFactor(u.id)).toBe(false);
		const sent = mailCount(u.email);
		const eventsAfter = await events(u.id);
		// The person signs in with the password and sets an authenticator up again.
		const login = await anon('POST', '/auth/login', { email: u.email, password: 'correct horse' });
		expect(login.status).toBe(200);
		const session = cookieOf(login.headers, SESSION_COOKIE)!;
		const { secret } = (await anon('POST', '/auth/mfa/totp/enrol', { password: 'correct horse' }, session)).body;
		expect((await anon('POST', '/auth/mfa/totp/confirm', { code: code(secret) }, session)).status).toBe(200);
		await runMfaResets();
		await runMfaResets();
		expect(await hasFactor(u.id)).toBe(true);
		expect(mailCount(u.email)).toBe(sent);
		expect(await events(u.id)).toEqual([...eventsAfter, 'mfa.enrolled']);
		// A session from after the completion works (positive control for the watermark).
		expect((await anon('GET', '/auth/me', undefined, session)).status).toBe(200);
	});

	it('the emails: confirmation, start and reminder carry exactly one link each, to the site’s pages', async () => {
		const u = await enrolled('ResetLinksOut');
		await ask(u);
		const linksOf = (text: string) => [...text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]);
		const confirmMail = lastMailTo(u.email)!;
		expect(confirmMail.subject).toBe('Confirm removing two-step sign-in — Water Management');
		expect(linksOf(confirmMail.text)).toEqual([expect.stringMatching(/^http:\/\/localhost:7777\/mfa-reset\?token=[A-Za-z0-9_-]{43}$/)]);
		expect((await anon('POST', '/auth/mfa/reset/confirm', { token: tokenIn(confirmMail) })).status).toBe(200);
		const startMail = lastMailTo(u.email)!;
		expect(startMail.to).toBe(u.email);
		expect(linksOf(startMail.text)).toEqual([expect.stringMatching(/^http:\/\/localhost:7777\/mfa-reset\/cancel\?token=[A-Za-z0-9_-]{43}$/)]);
		await asOwner(`UPDATE mfa_reset SET notified_at = now() - interval '25 hours' WHERE user_id = $1 AND ended_at IS NULL`, [u.id]);
		await runMfaResets();
		const reminder = lastMailTo(u.email)!;
		expect(reminder.subject).toBe(startMail.subject);
		expect(linksOf(reminder.text)).toEqual([expect.stringMatching(/^http:\/\/localhost:7777\/mfa-reset\/cancel\?token=[A-Za-z0-9_-]{43}$/)]);
	});
});

describe('the tick’s housekeeping and failures', () => {
	it('purges an ended reset 90 days after it ended, keeps a recent one and never touches a waiting one; the request count goes after a day', async () => {
		const old = await enrolled('ResetPurgeOld');
		const recent = await enrolled('ResetPurgeRecent');
		const waiting = await enrolled('ResetPurgeWaiting');
		for (const u of [old, recent]) expect((await anon('POST', '/auth/mfa/reset/cancel', { token: await started(u) })).status).toBe(200);
		await started(waiting);
		await asOwner(`UPDATE mfa_reset SET ended_at = now() - interval '91 days', requested_at = now() - interval '92 days' WHERE user_id = $1`, [old.id]);
		await asOwner(`UPDATE mfa_reset SET ended_at = now() - interval '89 days' WHERE user_id = $1`, [recent.id]);
		await asOwner(`UPDATE mfa_reset SET requested_at = now() - interval '200 days' WHERE user_id = $1`, [waiting.id]);
		await asOwner(`UPDATE mfa_reset_quota SET sent_at = now() - interval '25 hours' WHERE user_id = $1`, [old.id]);
		const tick = await runMfaResets();
		expect(tick.purged).toBeGreaterThanOrEqual(1);
		expect(await resets(old.id)).toEqual([]);
		expect(await resets(recent.id)).toHaveLength(1);
		expect(await resets(waiting.id)).toEqual([expect.objectContaining({ ended_at: null })]);
		expect(await asOwner('SELECT 1 FROM mfa_reset_quota WHERE user_id = $1', [old.id])).toEqual([]);
		expect(await asOwner('SELECT 1 FROM mfa_reset_quota WHERE user_id = $1', [recent.id])).toHaveLength(1);
		// The security log keeps that it happened (positive control: it is the person's own, for good).
		expect(await events(old.id)).toContain('mfa.reset_cancelled');
	});

	it('a confirmation link that lapsed unused is ended by the purge, not left open', async () => {
		const u = await enrolled('ResetLapsed');
		await ask(u);
		await asOwner(`UPDATE mfa_reset SET confirm_expires_at = now() - interval '1 second' WHERE user_id = $1`, [u.id]);
		await runMfaResets();
		expect(await resets(u.id)).toEqual([expect.objectContaining({ end_reason: 'unconfirmed' })]);
	});

	describe('with a transport that fails (SMTP to a closed port)', () => {
		const failing = () => {
			vi.stubEnv('MAIL_TRANSPORT', 'smtp');
			vi.stubEnv('SMTP_HOST', '127.0.0.1');
			vi.stubEnv('SMTP_PORT', '1');
		};

		it('completes the reset anyway, counts the failure and logs mail_send_failed without the address', async () => {
			const u = await enrolled('ResetMailFails');
			await started(u);
			await endWait(u.id);
			vi.setSystemTime(Date.now() + 1000);
			const logs: string[] = [];
			vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
			failing();
			const tick = await runMfaResets();
			vi.unstubAllEnvs();
			expect(tick.failed).toBeGreaterThanOrEqual(1);
			expect(await hasFactor(u.id)).toBe(false);
			const line = logs.find((l) => l.includes('mail_send_failed') && l.includes('mfa_reset'));
			expect(line).toBeTruthy();
			expect(line).not.toContain(u.email);
		});

		it('an unsent start email brings the reminder forward to the next tick, with its own working cancel link', async () => {
			const u = await enrolled('ResetStartFails');
			const token = await ask(u);
			vi.spyOn(console, 'error').mockImplementation(() => undefined);
			failing();
			expect((await anon('POST', '/auth/mfa/reset/confirm', { token })).status).toBe(200);
			vi.unstubAllEnvs();
			expect(await asOwner('SELECT notified_at FROM mfa_reset WHERE user_id = $1 AND ended_at IS NULL', [u.id])).toEqual([{ notified_at: null }]);
			const sent = mailCount(u.email);
			await runMfaResets();
			expect(mailCount(u.email)).toBe(sent + 1);
			const reminder = lastMailTo(u.email)!;
			expect(reminder.text).toContain('is still waiting');
			expect((await anon('POST', '/auth/mfa/reset/cancel', { token: tokenIn(reminder) })).status).toBe(200);
		});
	});
});

describe('RLS on the reset tables', () => {
	let a: Awaited<ReturnType<typeof enrolled>>;
	let b: Awaited<ReturnType<typeof enrolled>>;

	beforeAll(async () => {
		a = await enrolled('ResetRlsA');
		b = await enrolled('ResetRlsB');
		await started(a);
		await started(b);
	});

	it('a person reads their own reset, never another’s (positive control: their own row)', async () => {
		const mine = await withUser(a.id, (db) => db.query('SELECT user_id FROM mfa_reset'));
		expect(mine.rows).toEqual([{ user_id: a.id }]);
		const theirs = await withUser(a.id, (db) => db.query('SELECT 1 FROM mfa_reset WHERE user_id = $1', [b.id]));
		expect(theirs.rows).toEqual([]);
		expect((await withoutUser((db) => db.query('SELECT 1 FROM mfa_reset'))).rows).toEqual([]);
	});

	it('nobody writes a reset row, not even its owner, so the wait can’t be skipped', async () => {
		for (const sql of [
			`UPDATE mfa_reset SET effective_at = now() WHERE user_id = $1`,
			`DELETE FROM mfa_reset WHERE user_id = $1`,
			`INSERT INTO mfa_reset (user_id, confirm_expires_at, confirmed_at, effective_at) VALUES ($1, now(), now(), now())`
		]) {
			await expect(withUser(a.id, (db) => db.query(sql, [a.id])), sql).rejects.toMatchObject({ code: '42501' });
		}
		for (const table of ['mfa_reset_cancel', 'mfa_reset_quota']) {
			await expect(withUser(a.id, (db) => db.query(`SELECT 1 FROM ${table}`)), table).rejects.toMatchObject({ code: '42501' });
		}
	});

	it('the person’s own functions refuse without a person', async () => {
		for (const sql of [
			'SELECT app_mfa_remove_own_factors()',
			'SELECT app_mfa_reset_cancel_own()',
			`SELECT * FROM app_mfa_reset_request('\\x00'::bytea, '1 hour', 3, '1 day')`,
			`SELECT * FROM app_mfa_team_reset(gen_random_uuid(), gen_random_uuid(), now())`
		]) {
			await expect(withoutUser((db) => db.query(sql)), sql).rejects.toMatchObject({ code: '42501' });
		}
		// The internal one is not water_app's to call at all.
		await expect(withUser(a.id, (db) => db.query('SELECT mfa_remove_factors($1)', [b.id]))).rejects.toMatchObject({ code: '42501' });
		expect(await hasFactor(b.id)).toBe(true);
	});

	it('completing is refused before the wait is over, whoever calls it', async () => {
		const [row] = await asOwner('SELECT id FROM mfa_reset WHERE user_id = $1 AND ended_at IS NULL', [a.id]);
		const r = await withoutUser((db) => db.query('SELECT * FROM app_mfa_reset_complete($1, now())', [row.id]));
		expect(r.rows).toEqual([]);
		expect(await hasFactor(a.id)).toBe(true);
	});
});

describe('a team admin resets a member’s second factor', () => {
	let admin: Awaited<ReturnType<typeof enrolled>>;
	let other: User;
	let outsider: User;
	let teamId: string;
	let projectId: string;

	beforeAll(async () => {
		admin = await enrolled('TeamResetAdmin');
		other = await signUp('TeamResetOther');
		outsider = await signUp('TeamResetOutsider');
		teamId = (await admin.call('POST', '/teams', { name: 'Reset WUA' })).body.team.id;
		projectId = (await admin.call('POST', '/projects', { name: 'Reset catchment', teamId })).body.project.id;
		expect((await admin.call('POST', `/teams/${teamId}/members`, { email: other.email, role: 'member' })).status).toBe(201);
	});

	/** A team member with an authenticator. */
	async function member(name: string) {
		const m = await enrolled(name);
		expect((await admin.call('POST', `/teams/${teamId}/members`, { email: m.email, role: 'member' })).status).toBe(201);
		return m;
	}
	const reset = (cookie: string, userId: string, team = teamId) => anon('POST', `/teams/${team}/members/${userId}/mfa-reset`, undefined, cookie);

	it('removes every factor at once, signs the member out everywhere, emails them and records it in both logs', async () => {
		const m = await member('TeamResetMember');
		const cancel = await started(m);
		vi.setSystemTime(Date.now() + 1000);
		expect((await reset(admin.twoStep, m.id)).status).toBe(204);
		expect(await hasFactor(m.id)).toBe(false);
		expect((await anon('GET', '/auth/me', undefined, m.twoStep)).status).toBe(401);
		// The member's own waiting reset ended with it (nothing left to remove), its link dead.
		expect((await resets(m.id)).at(-1)).toMatchObject({ end_reason: 'factor_removed' });
		expect((await anon('POST', '/auth/mfa/reset/cancel', { token: cancel })).status).toBe(400);
		const mail = lastMailTo(m.email)!;
		expect(mail).toMatchObject({ kind: 'mfa_reset', subject: 'Your two-step sign-in was removed — Water Management' });
		expect(mail.text).toContain('An admin of the team “Reset WUA” removed two-step sign-in');
		expect((await events(m.id)).at(-1)).toBe('mfa.reset_by_admin');
		const audit = await asOwner(`SELECT actor_user_id, subject FROM audit_event WHERE project_id = $1 AND kind = 'team_member.mfa_reset'`, [projectId]);
		expect(audit).toEqual([{ actor_user_id: admin.id, subject: expect.objectContaining({ userId: m.id, team: 'Reset WUA', teamRole: 'member' }) }]);
		// The member signs in with the password alone now (positive control: the account works).
		expect((await anon('POST', '/auth/login', { email: m.email, password: 'correct horse' })).status).toBe(200);
	});

	it('refuses a member, an outsider and the admin for themselves; 404s leak nothing', async () => {
		const m = await member('TeamResetTarget');
		const peer = await member('TeamResetPeer');
		// A member who isn't an admin: 403, as every admin action.
		expect((await reset(peer.twoStep, m.id)).status).toBe(403);
		// Someone outside the team: 404, whether or not the person is in it.
		expect((await reset(outsider.cookie, m.id)).status).toBe(404);
		expect((await reset(outsider.cookie, crypto.randomUUID())).status).toBe(404);
		// The admin, for someone not in the team or a made-up id: the same 404.
		expect((await reset(admin.twoStep, outsider.id)).status).toBe(404);
		expect((await reset(admin.twoStep, crypto.randomUUID())).status).toBe(404);
		expect((await reset(admin.twoStep, 'not-a-uuid')).status).toBe(404);
		// Themselves: the self-service reset is theirs.
		expect((await reset(admin.twoStep, admin.id)).status).toBe(409);
		expect(await hasFactor(admin.id)).toBe(true);
		// A member with no factor: nothing to remove.
		expect((await reset(admin.twoStep, other.id)).status).toBe(409);
		expect(await hasFactor(m.id)).toBe(true);
		expect(await hasFactor(peer.id)).toBe(true);
	});

	it('needs a code from the last 10 minutes when the requirement is on (positive control: after a step-up it goes through)', async () => {
		const m = await member('TeamResetFresh');
		vi.stubEnv('MFA_REQUIRED', 'true');
		// A password-only session of the admin: step up first.
		expect(await reset(admin.cookie, m.id)).toMatchObject({ status: 403, body: { code: 'mfa_step_up' } });
		vi.setSystemTime(Date.now() + 11 * 60_000);
		expect(await reset(admin.twoStep, m.id)).toMatchObject({ status: 401, body: { code: 'mfa_fresh_code' } });
		expect(await hasFactor(m.id)).toBe(true);
		const up = await anon('POST', '/auth/mfa/step-up', { code: code(admin.secret) }, admin.twoStep);
		expect(up.status).toBe(200);
		expect((await reset(cookieOf(up.headers, SESSION_COOKIE)!, m.id)).status).toBe(204);
		expect(await hasFactor(m.id)).toBe(false);
	});

	it('never mails anyone but the member', async () => {
		const m = await member('TeamResetMailTo');
		const before = outbox.length;
		expect((await reset(admin.twoStep, m.id)).status).toBe(204);
		expect(outbox.slice(before).map((x) => x.to)).toEqual([m.email]);
	});
});
