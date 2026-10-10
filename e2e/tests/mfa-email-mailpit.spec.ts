// Codes by email (206; docs/security.md § Two-step sign-in → Code by email,
// docs/ui.md § Account and § Sign-in pages) end to end, with the emails
// really sent: the browser's API calls go to the second e2e API
// (MFA_API_URL: the requirement on, as production, and mail through Mailpit,
// playwright.config.ts), and every code is read from the email in Mailpit's
// API, whose recipient, subject and code format are checked each time.
//   1. Turn codes by email on from the Account page: the password, the code
//      email, the recovery codes.
//   2. Sign in by an emailed code: a wrong code says so; "Send again" waits
//      out its countdown, sends a new email, and the old code is refused.
//   3. A fresh code for signing an evidence pack: the dialog's "Email me a
//      code instead" (the app is on too), the email, and the sign-off goes
//      through.
//   4. Both ways on: the sign-in offers both, and the app's code still works.
//   5. Turning codes by email off with an emailed code.
//
// Needs Mailpit (`pnpm dev:mail:up`; CI starts it). Locally, without it the
// spec is skipped and says why; in CI it never skips (alerts-mailpit.spec.ts's
// rule). two-step-signin.spec.ts covers the screens without Mailpit.
import type { APIRequestContext, Page } from '@playwright/test';
import { base32Decode, hotp, totpStep } from '../../backend/src/auth/totp.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { createRun, nominateRun, PASSWORD, seedRunnableProject, updateSettings } from '../support/api.ts';
import { ageEmailCodeSends } from '../support/db.ts';
import { API_URL, MFA_API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { viaMfaApi } from '../support/mfaApi.ts';
import { sessionToken } from '../support/session.ts';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8026';
const reachable = (url: string) =>
	fetch(url, { signal: AbortSignal.timeout(1500) })
		.then((r) => r.ok)
		.catch(() => false);

test.beforeAll(async () => {
	test.skip(!(await reachable(`${MAILPIT}/api/v1/info`)) && !process.env.CI, 'needs Mailpit: pnpm dev:mail:up');
});

/** Every Mailpit message id to `to`, newest first. */
async function mailIds(to: string): Promise<string[]> {
	const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=50`);
	expect(res.ok, 'Mailpit search').toBe(true);
	return ((await res.json()) as { messages: { ID: string }[] }).messages.map((m) => m.ID);
}

/**
 * The code in the next email to `to`, once more than `seen` have arrived: to
 * that one address, the code email's subject, and six digits on a line of
 * their own, never in the subject, with no link in the email.
 */
async function nextCode(to: string, seen: number): Promise<string> {
	await expect.poll(async () => (await mailIds(to)).length, { message: `a new email to ${to}` }).toBeGreaterThan(seen);
	const [id] = await mailIds(to);
	const m = (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as { Subject: string; Text: string; To: { Address: string }[] };
	expect(m.To.map((a) => a.Address)).toEqual([to]);
	expect(m.Subject).toBe('Your sign-in code — Water Management');
	const code = m.Text.match(/^(\d{6})$/m)?.[1];
	expect(code, 'a six-digit code on its own line').toMatch(/^\d{6}$/);
	expect(m.Subject).not.toContain(code!);
	expect(m.Text).not.toMatch(/https?:\/\//);
	return code!;
}

/** A code that isn't `code`. */
const not = (code: string) => (code === '000000' ? '000001' : '000000');

/** Turn codes by email on through the API, the code read from Mailpit (the screens are test 1). */
async function emailOn(request: APIRequestContext, email: string): Promise<void> {
	const seen = (await mailIds(email)).length;
	expect((await request.post(`${MFA_API_URL}/auth/mfa/email/enrol`, { data: { password: PASSWORD } })).status()).toBe(202);
	const r = await request.post(`${MFA_API_URL}/auth/mfa/email/confirm`, { data: { code: await nextCode(email, seen) } });
	expect(r.status(), await r.text()).toBe(200);
}

/** Add an authenticator through the API: its secret and the last step used. */
async function appOn(request: APIRequestContext): Promise<{ secret: string; step: number }> {
	const { secret } = (await (await request.post(`${MFA_API_URL}/auth/mfa/totp/enrol`, { data: { password: PASSWORD } })).json()) as { secret: string };
	const step = totpStep(Date.now());
	const r = await request.post(`${MFA_API_URL}/auth/mfa/totp/confirm`, { data: { code: hotp(base32Decode(secret)!, step) } });
	expect(r.status(), await r.text()).toBe(200);
	return { secret, step };
}

async function signOut(page: Page, displayName: string) {
	await page.getByRole('button', { name: `Account menu for ${displayName}` }).click();
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	await expect(page).toHaveURL('/login');
}

async function password(page: Page, email: string) {
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { name: 'Two-step sign-in' })).toBeVisible();
}

test('1. turn codes by email on from the Account page: the password, the emailed code, the recovery codes', async ({ page, owner }) => {
	await viaMfaApi(page);
	await page.goto('/account');
	const panel = page.getByRole('region', { name: 'Two-step sign-in' });
	const row = panel.locator('[data-method="email"]');
	await expect(row).toContainText('whoever can read your email can also reset your password');
	await row.getByRole('button', { name: 'Turn on', exact: true }).click();
	await panel.getByLabel('Current password').fill(PASSWORD);
	const seen = (await mailIds(owner.email)).length;
	await panel.getByRole('button', { name: 'Continue' }).click();
	await expect(panel.getByLabel('Code from the email')).toBeFocused();
	await expect(panel.getByRole('button', { name: /^Send again \(in \d+ s\)$/ })).toBeDisabled();
	await panel.getByLabel('Code from the email').fill(await nextCode(owner.email, seen));
	await panel.getByRole('button', { name: 'Turn on codes by email' }).click();

	await expect(panel.getByRole('heading', { name: 'Your recovery codes' })).toBeFocused();
	const codes = await panel.locator('.code-list li').allTextContents();
	expect(codes).toHaveLength(10);
	for (const c of codes) expect(c).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
	await panel.getByRole('button', { name: 'I’ve saved them' }).click();
	await expect(panel).toHaveAttribute('data-two-step', 'on');
	await expect(row).toHaveAttribute('data-on', 'true');
	await expect(panel).toContainText('10 recovery codes left.');
	await expectNoViolations(page);
});

test('2. sign in by an emailed code: a wrong code is refused, and “Send again” waits, sends a new email and voids the old code', async ({ page, owner }) => {
	await emailOn(page.request, owner.email);
	await ageEmailCodeSends(owner.email);
	// The page's clock, so the minute's countdown can be moved on instead of waited out.
	await page.clock.install();
	await viaMfaApi(page);
	await page.goto('/');
	await signOut(page, owner.displayName);
	await password(page, owner.email);
	// Codes by email only: no app to offer, and the recovery link says so.
	await expect(page.getByRole('button', { name: 'Use a code from the app instead' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Can’t get the email? Use a recovery code' })).toBeVisible();

	let seen = (await mailIds(owner.email)).length;
	await page.getByRole('button', { name: 'Send code' }).click();
	const first = await nextCode(owner.email, seen);
	const again = page.getByRole('button', { name: /^Send again/ });
	await expect(again).toHaveText(/^Send again \(in \d+ s\)$/);
	await expect(again).toBeDisabled();
	await expect(page.getByLabel('Code from the email')).toBeFocused();
	await expectNoViolations(page);

	// A wrong code says so, and signs nobody in.
	await page.getByLabel('Code from the email').fill(not(first));
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('alert')).toHaveText('That code isn’t right. Enter the newest code from your authenticator app or your email, or one of your recovery codes.');

	// A minute on (the server's send log and the page's clock), Send again sends a new email.
	await ageEmailCodeSends(owner.email);
	await page.clock.fastForward(61_000);
	await expect(again).toHaveText('Send again');
	await expect(again).toBeEnabled();
	seen = (await mailIds(owner.email)).length;
	await again.click();
	const second = await nextCode(owner.email, seen);
	await expect(again).toBeDisabled();

	// The old code no longer works (unless the new one happens to be the same six digits).
	if (second !== first) {
		await page.getByLabel('Code from the email').fill(first);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page.getByRole('alert')).toContainText('That code isn’t right.');
	}
	await page.getByLabel('Code from the email').fill(second);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	await expect(page).toHaveURL('/');
});

// The pack's evidence, as evidence-pack.spec.ts makes it: a nominated baseline with the declared rule, and its ensemble.
const POINTS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 99];
const RULE = { members: 30, bounds: 'typical', panOffset: 0.1, thresholds: { objective: 'kgePrime', minSkill: -10, wr2012MaxLevel: 'unusable', maxLowFlowBiasPct: null } };
const TABLE = {
	siteNodeId: null,
	source: 'Invented rule table for tests',
	category: 'B/C',
	component: 'total',
	unit: 'mcm',
	points: POINTS,
	ewr: Array.from({ length: 12 }, () => POINTS.map((_, i) => 0.5 - i * 0.04)),
	naturalSource: 'run',
	natural: null,
	scale: 1
};

test('3. signing an evidence pack with a code over 10 minutes old: “Email me a code instead”, and the sign-off goes through', async ({ page, owner }) => {
	const project = await seedRunnableProject(page.request, 'Email fresh-code catchment');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j', ewrRules: [TABLE], evidenceUncertaintyRule: RULE });
	const baseline = await createRun(page.request, project.id, 'Baseline');
	await nominateRun(page.request, project.id, baseline, 'Calibrated baseline for the fresh-code test');
	await page.goto(`/projects/${project.id}?tab=river&run=${baseline}`);
	const ensemble = page.getByTestId('uncertainty-panel');
	await ensemble.getByRole('button', { name: 'Run…' }).click();
	await ensemble.getByLabel('Parameter sets').fill('30');
	await ensemble.getByLabel(/^Lowest skill kept/).fill('-10');
	await ensemble.getByLabel('Worst WR2012 flag kept').selectOption('unusable');
	await ensemble.getByRole('checkbox', { name: 'Check the low-flow bias' }).uncheck();
	await ensemble.getByRole('button', { name: 'Run ensemble' }).click();
	await expect(ensemble.getByTestId('kept')).toHaveText(/^\d+ of 31$/);
	const created = await page.request.post(`${API_URL}/projects/${project.id}/packs`, { data: { runId: baseline } });
	expect(created.status(), await created.text()).toBe(201);
	const packId = ((await created.json()) as { pack: { id: string } }).pack.id;

	// Both ways on, then a session that signed in with a code 11 minutes ago: two-step, but not fresh enough to sign.
	await appOn(page.request);
	await emailOn(page.request, owner.email);
	await ageEmailCodeSends(owner.email);
	await page.context().addCookies([
		{ name: 'wm_session', value: sessionToken(owner.id, { amr: ['pwd', 'otp'], otp_at: Date.now() - 11 * 60_000 }), url: API_URL, httpOnly: true, sameSite: 'Lax' }
	]);
	await viaMfaApi(page);

	await page.goto(`/projects/${project.id}/packs/${packId}`);
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	await page.getByRole('button', { name: 'Sign off this evidence pack…' }).click();
	const dialog = page.getByRole('dialog', { name: 'Sign off this evidence pack' });
	await dialog.getByLabel('Full name', { exact: true }).fill('Dr E. Mailed');
	await dialog.getByLabel('Registration category', { exact: true }).selectOption('pr_sci_nat');
	await dialog.getByLabel('Field of practice', { exact: true }).selectOption('water_resources');
	await dialog.getByLabel('Registration number', { exact: true }).fill('400998/20');
	await dialog.getByLabel('What this sign-off covers', { exact: true }).fill('Hydrology of a synthetic WULA');
	for (const box of await dialog.getByRole('checkbox').all()) await box.check();
	await dialog.getByRole('region', { name: /^Known limitations/ }).evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
	await dialog.getByRole('button', { name: 'Sign off', exact: true }).click();

	// 401 mfa_fresh_code: the dialog asks for a code, the app's or one by email.
	const fresh = page.getByRole('dialog', { name: 'Enter a code from your authenticator' });
	await expect(fresh).toBeVisible();
	await expect(fresh).toContainText('from your authenticator app or by email');
	const seen = (await mailIds(owner.email)).length;
	await fresh.getByRole('button', { name: 'Email me a code instead' }).click();
	const code = await nextCode(owner.email, seen);
	await expect(fresh.getByRole('button', { name: /^Send again \(in \d+ s\)$/ })).toBeDisabled();
	await expectNoViolations(page, { include: 'dialog[open]' });
	await fresh.getByLabel('Code', { exact: true }).fill(code);
	await fresh.getByRole('button', { name: 'Continue' }).click();

	await expect(fresh).toBeHidden();
	await expect(dialog).toBeHidden();
	await expect(page.getByTestId('pack-checklist').locator('li.fail')).toHaveCount(0);
	const signoffs = (await (await page.request.get(`${API_URL}/projects/${project.id}/packs/${packId}/signoffs`)).json()) as { signoffs: unknown[] };
	expect(signoffs.signoffs).toHaveLength(1);
	expect(JSON.stringify(signoffs.signoffs)).toContain('Dr E. Mailed');
});

test('4. with both ways on, the sign-in offers both, and the app’s code still works', async ({ page, owner }) => {
	const { secret, step } = await appOn(page.request);
	await emailOn(page.request, owner.email);
	await viaMfaApi(page);
	await page.goto('/');
	await signOut(page, owner.displayName);
	await password(page, owner.email);
	// The app first, the email offered beside it.
	await expect(page.getByLabel('Code from your authenticator app')).toBeFocused();
	await page.getByRole('button', { name: 'Email me a code instead' }).click();
	await expect(page.getByRole('button', { name: 'Send code' })).toBeVisible();
	await page.getByRole('button', { name: 'Use a code from the app instead' }).click();
	await page.getByLabel('Code from your authenticator app').fill(hotp(base32Decode(secret)!, Math.max(step + 1, totpStep(Date.now()))));
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	await page.goto('/account');
	const panel = page.getByRole('region', { name: 'Two-step sign-in' });
	await expect(panel.locator('[data-method="totp"]')).toHaveAttribute('data-on', 'true');
	await expect(panel.locator('[data-method="email"]')).toHaveAttribute('data-on', 'true');
});

test('5. turning codes by email off with an emailed code', async ({ page, owner }) => {
	await emailOn(page.request, owner.email);
	await ageEmailCodeSends(owner.email);
	await viaMfaApi(page);
	await page.goto('/account');
	const panel = page.getByRole('region', { name: 'Two-step sign-in' });
	const row = panel.locator('[data-method="email"]');
	await expect(row).toHaveAttribute('data-on', 'true');
	await row.getByRole('button', { name: 'Turn off', exact: true }).click();
	const seen = (await mailIds(owner.email)).length;
	await panel.getByRole('button', { name: 'Email me a code' }).click();
	const code = await nextCode(owner.email, seen);
	await expect(panel.getByRole('button', { name: /^Send again \(in \d+ s\)$/ })).toBeDisabled();
	await panel.getByLabel('Code from your authenticator app or your email, or a recovery code').fill(code);
	await panel.getByRole('button', { name: 'Turn off codes by email' }).click();
	await expect(panel.getByRole('status')).toHaveText('Two-step sign-in is off.');
	await expect(panel).toHaveAttribute('data-two-step', 'off');
	await expect(row).toHaveAttribute('data-on', 'false');

	// Signing in is one step again.
	await signOut(page, owner.displayName);
	await page.getByLabel('Email').fill(owner.email);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
});
