// Recovering a lost second factor end to end, with the emails really sent
// (205_mfa_recovery; docs/ui.md § Sign-in pages, § Teams; docs/security.md
// § Two-step sign-in → Recovery). The browser's API calls go to the second e2e
// API (MFA_API_URL: the requirement on, as in production, and its mail sent
// through Mailpit, playwright.config.ts); each email is read from Mailpit's
// API and its real link followed. The 3-day wait is ended in the database
// (support/db.ts endMfaResetWait, never slept) and one worker tick
// (support/jobs.ts) completes it, sending its email through Mailpit too.
//
// Needs Mailpit (`pnpm dev:mail:up`; CI starts it). Locally, without it the
// spec is skipped and says why; in CI it never skips.
import { request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { base32Decode, hotp, totpStep } from '../../backend/src/auth/totp.ts';
import { acceptInvites, PASSWORD } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { answerConfirm } from '../support/confirm.ts';
import { ageEmailCodeSends, endMfaResetWait, mfaResetState } from '../support/db.ts';
import { API_URL, MFA_API_URL, WEB_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { viaMfaApi } from '../support/mfaApi.ts';
import { runJobsTick } from '../support/jobs.ts';
import { emailIds, linkIn, mailpitUp, waitForEmail } from '../support/mailpit.ts';
import { sessionToken } from '../support/session.ts';

test.beforeAll(async () => {
	test.skip(!(await mailpitUp()) && !process.env.CI, 'needs Mailpit: pnpm dev:mail:up');
});

const CONFIRM_SUBJECT = 'Confirm removing two-step sign-in — Water Management';
const STARTED_SUBJECT = /^Two-step sign-in will be removed on \d{1,2} \w{3} \d{4} — Water Management$/;
const DONE_SUBJECT = 'Two-step sign-in was removed — Water Management';

/** An authenticator for the signed-in page's account, from the Account page; its codes come from `next()`, a later step each time. */
async function enrol(page: Page) {
	await page.goto('/account');
	const panel = page.getByRole('region', { name: 'Two-step sign-in' });
	await panel.getByRole('button', { name: 'Set up the app' }).click();
	await panel.getByLabel('Current password').fill(PASSWORD);
	await panel.getByRole('button', { name: 'Continue' }).click();
	const secret = (await panel.locator('[data-totp-secret]').getAttribute('data-totp-secret'))!;
	let step = totpStep(Date.now());
	const next = () => {
		step = Math.max(step + 1, totpStep(Date.now()));
		return hotp(base32Decode(secret)!, step);
	};
	await panel.getByLabel('Enter the code the app shows').fill(hotp(base32Decode(secret)!, step));
	await panel.getByRole('button', { name: 'Turn on the authenticator app' }).click();
	await panel.getByRole('button', { name: 'I’ve saved them' }).click();
	await expect(panel).toHaveAttribute('data-two-step', 'on');
	return next;
}

async function signOut(page: Page, displayName: string) {
	await page.getByRole('button', { name: `Account menu for ${displayName}` }).click();
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	await expect(page).toHaveURL('/login');
}

/** The password, up to the code step. */
async function toCodeStep(page: Page, email: string) {
	await page.goto('/login');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { name: 'Two-step sign-in' })).toBeVisible();
}

/** The six-digit code in the newest code email to `to` that isn't among `seen` (206). */
async function emailedCode(to: string, seen: readonly string[]): Promise<string> {
	const m = await waitForEmail(to, 'Your sign-in code — Water Management', seen);
	const code = m.text.match(/^(\d{6})$/m)?.[1];
	expect(code, 'a six-digit code on its own line').toMatch(/^\d{6}$/);
	return code!;
}

/** Codes by email on, through the API (as the page's account), the code read from Mailpit (206). */
async function emailOn(request: APIRequestContext, email: string) {
	const seen = await emailIds(email);
	expect((await request.post(`${MFA_API_URL}/auth/mfa/email/enrol`, { data: { password: PASSWORD } })).status()).toBe(202);
	const r = await request.post(`${MFA_API_URL}/auth/mfa/email/confirm`, { data: { code: await emailedCode(email, seen) } });
	expect(r.status(), await r.text()).toBe(200);
}

/**
 * Signed out: ask at the code step, follow the emailed link, start the wait. The start email. `factor`: the
 * account's only factor, which words the links (the app: "Lost your phone…"; codes by email alone: "Can’t get
 * the email…").
 */
async function startReset(page: Page, email: string, factor: 'totp' | 'email' = 'totp') {
	await toCodeStep(page, email);
	if (factor === 'totp') {
		await page.getByRole('button', { name: 'Lost your phone? Use a recovery code' }).click();
		await page.getByRole('button', { name: 'Lost your phone and your recovery codes?' }).click();
	} else {
		await page.getByRole('button', { name: 'Can’t get the email? Use a recovery code' }).click();
		await page.getByRole('button', { name: 'Can’t get the email and lost your recovery codes?' }).click();
	}
	await page.getByRole('button', { name: 'Email me a link' }).click();
	await expect(page.locator('[data-reset-sent]')).toContainText('Check your email');

	const confirm = await waitForEmail(email, CONFIRM_SUBJECT);
	expect(confirm.to).toEqual([email]);
	expect(confirm.text).toContain('3-day wait');
	expect(confirm.text).toContain('This link expires in 1 hour and works once.');
	const link = linkIn(confirm, `${WEB_URL}/mfa-reset?token=`);
	expect(link.pathname).toBe('/mfa-reset');
	// Nothing changes until the link is followed, and opening it alone starts nothing.
	expect(await mfaResetState(email)).toEqual({ waiting: false, endReason: null });
	await page.goto(link.href);
	await expect(page.getByRole('heading', { name: 'Remove two-step sign-in' })).toBeVisible();
	expect(await mfaResetState(email)).toEqual({ waiting: false, endReason: null });
	await page.getByRole('button', { name: 'Start the 3-day wait' }).click();
	await expect(page.locator('[data-reset-started]')).toContainText('The 3-day wait has started.');
	expect(await mfaResetState(email)).toEqual({ waiting: true, endReason: null });

	const started = await waitForEmail(email, STARTED_SUBJECT);
	expect(started.to).toEqual([email]);
	expect(started.text).toMatch(/Two-step sign-in will be removed from your account on \d{1,2} \w{3} \d{4} at \d{2}:\d{2} SAST/);
	expect(linkIn(started, `${WEB_URL}/mfa-reset/cancel?token=`).pathname).toBe('/mfa-reset/cancel');
	return started;
}

/** A second device: signed in with the password and a code, through the API. */
async function secondDevice(email: string, code: string): Promise<APIRequestContext> {
	const device = await apiRequest.newContext();
	expect((await device.post(`${MFA_API_URL}/auth/login`, { data: { email, password: PASSWORD } })).status()).toBe(200);
	expect((await device.post(`${MFA_API_URL}/auth/mfa/verify`, { data: { code } })).status()).toBe(200);
	expect((await device.get(`${MFA_API_URL}/auth/me`)).status()).toBe(200);
	return device;
}

test('lost phone and codes: the emailed link starts the wait, and when it is over the factor is gone, every session signed out, and the password alone signs in', async ({ page, owner }) => {
	await viaMfaApi(page);
	const next = await enrol(page);
	const device = await secondDevice(owner.email, next());
	await signOut(page, owner.displayName);
	await startReset(page, owner.email);
	// The factor keeps working through the wait: the other device stays signed in.
	expect((await device.get(`${MFA_API_URL}/auth/me`)).status()).toBe(200);
	// Signed in again with a code, the Account page would show the waiting reset; here the code ends it, so the
	// page is read through the other device's session instead (a browser that was already signed in).
	const pending = (await (await device.get(`${MFA_API_URL}/auth/mfa`)).json()) as { pendingReset: { effectiveAt: string } | null };
	expect(pending.pendingReset).not.toBeNull();
	const deviceCookie = (await device.storageState()).cookies.find((c) => c.name === 'wm_session')!;
	const watcher = await page.context().browser()!.newContext();
	await watcher.addCookies([{ name: 'wm_session', value: deviceCookie.value, domain: 'localhost', path: '/' }]);
	const account = await watcher.newPage();
	await viaMfaApi(account);
	await account.goto('/account');
	await expect(account.locator('[data-pending-reset]')).toContainText('Someone asked to remove two-step sign-in from your account');
	await expect(account.locator('[data-pending-reset]').getByRole('button', { name: 'Cancel the removal' })).toBeVisible();
	await expectNoViolations(account);
	await watcher.close();

	await endMfaResetWait(owner.email);
	const seen = await emailIds(owner.email);
	await runJobsTick({ projects: [crypto.randomUUID()], schedule: false });
	const done = await waitForEmail(owner.email, DONE_SUBJECT, seen);
	expect(done.to).toEqual([owner.email]);
	expect(done.text).toContain('every device was signed out');
	expect(linkIn(done, `${WEB_URL}/login`).pathname).toBe('/login');
	expect(await mfaResetState(owner.email)).toEqual({ waiting: false, endReason: 'completed' });
	// The old session is signed out.
	expect((await device.get(`${MFA_API_URL}/auth/me`)).status()).toBe(401);
	await device.dispose();
	// A second tick sends nothing more.
	await runJobsTick({ projects: [crypto.randomUUID()], schedule: false });
	expect((await emailIds(owner.email)).length).toBe(seen.length + 1);

	// The password alone signs in now, and the Account page says it is off.
	await page.goto('/login');
	await page.getByLabel('Email').fill(owner.email);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	await page.goto('/account');
	await expect(page.getByRole('region', { name: 'Two-step sign-in' })).toHaveAttribute('data-two-step', 'off');
});

test('the cancel link in the start email ends the wait, signed out, and the factor still works', async ({ page, owner, browser }) => {
	await viaMfaApi(page);
	const next = await enrol(page);
	await signOut(page, owner.displayName);
	const started = await startReset(page, owner.email);
	const cancel = linkIn(started, `${WEB_URL}/mfa-reset/cancel?token=`);

	// Another browser, signed in to nothing.
	const stranger = await browser.newContext();
	const other = await stranger.newPage();
	await other.goto(cancel.href);
	await expect(other.getByRole('heading', { name: 'Keep two-step sign-in' })).toBeVisible();
	await other.getByRole('button', { name: 'Cancel the removal' }).click();
	await expect(other.locator('[data-reset-cancelled]')).toContainText('Cancelled. Two-step sign-in stays on your account.');
	expect(await mfaResetState(owner.email)).toEqual({ waiting: false, endReason: 'cancel_link' });
	// The link works once.
	await other.goto(cancel.href);
	await other.getByRole('button', { name: 'Cancel the removal' }).click();
	await expect(other.getByRole('alert')).toContainText('This link no longer works');
	await stranger.close();

	// The factor still works: a code signs in.
	await toCodeStep(page, owner.email);
	await page.getByLabel('Code from your authenticator app').fill(next());
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
});

test('signing in with a code cancels a waiting reset, and its emailed cancel link then does nothing', async ({ page, owner }) => {
	await viaMfaApi(page);
	const next = await enrol(page);
	await signOut(page, owner.displayName);
	const started = await startReset(page, owner.email);

	await toCodeStep(page, owner.email);
	await page.getByLabel('Code from your authenticator app').fill(next());
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	expect(await mfaResetState(owner.email)).toEqual({ waiting: false, endReason: 'code_used' });

	await page.goto(linkIn(started, `${WEB_URL}/mfa-reset/cancel?token=`).href);
	await page.getByRole('button', { name: 'Cancel the removal' }).click();
	await expect(page.getByRole('alert')).toContainText('This link no longer works');
	// The wait being over changes nothing either: the tick has nothing to complete.
	await runJobsTick({ projects: [crypto.randomUUID()], schedule: false });
	await page.goto('/account');
	await expect(page.getByRole('region', { name: 'Two-step sign-in' })).toHaveAttribute('data-two-step', 'on');
});

test('a team admin removes a member’s two-step sign-in: a fresh code, the confirm, the member’s email, and the member signs in with the password alone', async ({ page, owner, signIn, context }) => {
	await viaMfaApi(page);
	const next = await enrol(page);
	const member = await signIn('Phone Loser');
	const created = await page.request.post(`${API_URL}/teams`, { data: { name: 'Reset WUA' } });
	expect(created.status()).toBe(201);
	const teamId = ((await created.json()) as { team: { id: string } }).team.id;
	expect((await page.request.post(`${API_URL}/teams/${teamId}/members`, { data: { email: member.user.email, role: 'member' } })).status()).toBe(201);
	expect(await acceptInvites(member.user.email, teamId)).toBe(1);
	// Another admin, whose factor this admin may never remove (2026-10-08): no button on their row.
	const coAdmin = await signIn('Co Admin');
	expect((await page.request.post(`${API_URL}/teams/${teamId}/members`, { data: { email: coAdmin.user.email, role: 'admin' } })).status()).toBe(201);
	expect(await acceptInvites(coAdmin.user.email, teamId)).toBe(1);
	const { secret } = (await (await member.context.request.post(`${API_URL}/auth/mfa/totp/enrol`, { data: { password: PASSWORD } })).json()) as { secret: string };
	expect((await member.context.request.post(`${API_URL}/auth/mfa/totp/confirm`, { data: { code: hotp(base32Decode(secret)!, totpStep(Date.now())) } })).status()).toBe(200);
	expect((await member.context.request.get(`${API_URL}/auth/me`)).status()).toBe(200);

	// The admin's session gave its code 11 minutes ago: the action asks for a fresh one.
	await context.addCookies([{ name: 'wm_session', value: sessionToken(owner.id, { amr: ['pwd', 'otp'], otp_at: Date.now() - 11 * 60_000 }), domain: 'localhost', path: '/' }]);
	await page.goto(`/teams/${teamId}`);
	await expect(page.getByRole('button', { name: 'Remove Co Admin' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Reset two-step sign-in for Co Admin' })).toHaveCount(0);
	const action = page.getByRole('button', { name: 'Reset two-step sign-in for Phone Loser' });
	await action.click();
	await answerConfirm(page, true, "Do this only when you're sure it's them asking");
	const dialog = page.getByRole('dialog', { name: 'Enter a code from your authenticator' });
	await expect(dialog).toBeVisible();
	await dialog.getByLabel('Code').fill(next());
	await dialog.getByRole('button', { name: 'Continue' }).click();
	await expect(page.locator('[data-reset-done]')).toHaveText('Two-step sign-in was removed from Phone Loser. They can sign in with their password and set it up again.');

	const mail = await waitForEmail(member.user.email, 'Your two-step sign-in was removed — Water Management');
	expect(mail.to).toEqual([member.user.email]);
	expect(mail.text).toContain('An admin of the team “Reset WUA” removed two-step sign-in');
	expect(linkIn(mail, `${WEB_URL}/login`).pathname).toBe('/login');
	// The member was signed out everywhere, and the password alone signs them in.
	expect((await member.context.request.get(`${API_URL}/auth/me`)).status()).toBe(401);
	await member.page.goto('/login');
	await member.page.getByLabel('Email').fill(member.user.email);
	await member.page.getByLabel('Password').fill(PASSWORD);
	await member.page.getByRole('button', { name: 'Sign in' }).click();
	await expect(member.page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
});

test('codes by email alone: “Can’t get the email…”, the emailed link, the wait, and when it is over the password alone signs in', async ({ page, owner }) => {
	await viaMfaApi(page);
	await emailOn(page.request, owner.email);
	await page.goto('/');
	await signOut(page, owner.displayName);
	await startReset(page, owner.email, 'email');

	await endMfaResetWait(owner.email);
	const seen = await emailIds(owner.email);
	await runJobsTick({ projects: [crypto.randomUUID()], schedule: false });
	const done = await waitForEmail(owner.email, DONE_SUBJECT, seen);
	expect(done.to).toEqual([owner.email]);
	expect(done.text).toContain('every device was signed out');
	expect(await mfaResetState(owner.email)).toEqual({ waiting: false, endReason: 'completed' });

	// The emailed factor is gone: the password alone signs in, and the Account page says both ways are off.
	await page.goto('/login');
	await page.getByLabel('Email').fill(owner.email);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	await page.goto('/account');
	const panel = page.getByRole('region', { name: 'Two-step sign-in' });
	await expect(panel).toHaveAttribute('data-two-step', 'off');
	await expect(panel.locator('[data-method="email"]')).toHaveAttribute('data-on', 'false');
});

test('signing in with an emailed code cancels a waiting reset', async ({ page, owner }) => {
	await viaMfaApi(page);
	await emailOn(page.request, owner.email);
	await page.goto('/');
	await signOut(page, owner.displayName);
	await startReset(page, owner.email, 'email');
	expect(await mfaResetState(owner.email)).toEqual({ waiting: true, endReason: null });

	// The send limit allows one a minute; the enrolment's was moments ago.
	await ageEmailCodeSends(owner.email);
	await toCodeStep(page, owner.email);
	const seen = await emailIds(owner.email);
	await page.getByRole('button', { name: 'Send code' }).click();
	await page.getByLabel('Code from the email').fill(await emailedCode(owner.email, seen));
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	expect(await mfaResetState(owner.email)).toEqual({ waiting: false, endReason: 'code_used' });
	await page.goto('/account');
	await expect(page.locator('[data-pending-reset]')).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Two-step sign-in' })).toHaveAttribute('data-two-step', 'on');
});

test('dead links: the confirmation and cancel pages say so, and pass an a11y scan', async ({ browser }) => {
	const stranger = await browser.newContext();
	const page = await stranger.newPage();
	await page.goto('/mfa-reset?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
	await expect(page.getByRole('heading', { name: 'Remove two-step sign-in' })).toBeVisible();
	await expectNoViolations(page);
	await page.getByRole('button', { name: 'Start the 3-day wait' }).click();
	await expect(page.getByRole('alert')).toHaveText('This link is invalid, already used, or older than 1 hour. Sign in again and ask for a new one.');
	await expectNoViolations(page);

	await page.goto('/mfa-reset/cancel?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
	await expect(page.getByRole('heading', { name: 'Keep two-step sign-in' })).toBeVisible();
	await expectNoViolations(page);
	await page.getByRole('button', { name: 'Cancel the removal' }).click();
	await expect(page.getByRole('alert')).toContainText('This link no longer works');
	await stranger.close();
});
