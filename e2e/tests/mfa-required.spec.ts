// Two-step sign-in, opt-in per project, end to end (operator decision,
// 2026-10-08; docs/security.md § Two-step sign-in → The prompt). The e2e API
// runs with the requirement off (MFA_REQUIRED=false, playwright.config.ts); a
// second API on the same database runs with it on, as production does, and
// this spec sends the browser's API calls there (cookies don't depend on the
// port, so the session is the same).
//
// An owner without an authenticator works without a prompt. Turning on the
// Project page's "Require two-step sign-in" needs their own second factor, so
// the real server refuses it (403 mfa_required): the page shows the banner
// and the switch stays off. After setting up an authenticator (the session
// reissued with the code) the switch turns on and stays on. The codes are made
// from the secret the page shows, with the backend's own RFC 6238 code, as in
// two-step-signin.spec.ts. The requirement itself (who is refused what, with
// the setting on or off) is in backend/src/auth/stepUp.db.test.ts.
import { base32Decode, hotp, totpStep } from '../../backend/src/auth/totp.ts';
import { createProject, PASSWORD } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL, MFA_API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { openProject } from '../support/project.ts';

test('with the requirement on, turning on a project’s two-step requirement needs your own authenticator; once set up, the switch turns on', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Required farm');
	// Every API call the page makes goes to the API with the requirement on.
	await page.route(`${API_URL}/**`, async (route) => {
		const response = await route.fetch({ url: route.request().url().replace(API_URL, MFA_API_URL) });
		await route.fulfill({ response });
	});
	const saved = async () => (await (await page.request.get(`${API_URL}/projects/${project.id}`)).json()).project;

	// Working on the project needs nothing: no banner, no badge. The panel says what the switch does, off by default.
	await openProject(page, project.id);
	await expect(page.locator('[data-mfa-prompt]')).toHaveCount(0);
	await expect(page.locator('[data-mfa-badge]')).toHaveCount(0);
	// The project's panel; the workspace's banner is a region of the same name (data-mfa-prompt).
	const panel = page.getByRole('region', { name: 'Two-step sign-in' }).filter({ has: page.locator('[data-require-two-step]') });
	await expect(panel).toContainText('Members who manage this project need an authenticator app');
	const toggle = panel.getByRole('switch', { name: 'Require two-step sign-in' });
	await expect(toggle).not.toBeChecked();
	await expectNoViolations(page, { include: '[data-require-two-step]' });

	// Turning it on is refused by the server: the banner, the error, and the setting stays off.
	await toggle.click();
	const banner = page.locator('[data-mfa-prompt]');
	await expect(banner).toHaveAttribute('data-mfa-prompt', 'setup');
	await expect(panel.getByRole('alert')).toContainText('to require two-step sign-in here, you need it yourself');
	await expect(toggle).not.toBeChecked();
	expect((await saved()).requireMfa).toBe(false);

	// Set it up from the banner's link.
	await banner.getByRole('link', { name: 'Set up two-step sign-in' }).click();
	const account = page.locator('#two-step');
	await account.getByRole('button', { name: 'Set up two-step sign-in' }).click();
	await account.getByLabel('Current password').fill(PASSWORD);
	await account.getByRole('button', { name: 'Continue' }).click();
	const secret = (await account.locator('[data-totp-secret]').getAttribute('data-totp-secret'))!;
	await account.getByLabel('Enter the code the app shows').fill(hotp(base32Decode(secret)!, totpStep(Date.now())));
	await account.getByRole('button', { name: 'Turn on two-step sign-in' }).click();
	await account.getByRole('button', { name: 'I’ve saved them' }).click();
	await expect(account).toHaveAttribute('data-two-step', 'on');

	// Now the switch turns on, and the setting is saved.
	await openProject(page, project.id);
	await expect(page.locator('[data-mfa-prompt]')).toHaveCount(0);
	await toggle.click();
	await expect(panel.getByRole('status')).toHaveText('Saved. Two-step sign-in is now required.');
	await expect(toggle).toBeChecked();
	await expect(panel.locator('[data-require-two-step]')).toHaveAttribute('data-require-two-step', 'on');
	expect(await saved()).toMatchObject({ requireMfa: true, mfaRequired: true });
});
