// Two-step sign-in required, end to end (issue #282; docs/security.md §
// Two-step sign-in → The prompt). The e2e API runs with the requirement off
// (MFA_REQUIRED=false, playwright.config.ts); a second API on the same
// database runs with it on, as production does, and this spec sends the
// browser's API calls there (cookies don't depend on the port, so the session
// is the same). An owner without an authenticator works without a prompt
// until an owner-only action: the real server refuses it with 403
// mfa_required, the page shows the banner, nothing was deleted; after setting
// up an authenticator (the session reissued with the code) the same action
// goes through. The codes are made from the secret the page shows, with the
// backend's own RFC 6238 code, as in two-step-signin.spec.ts.
import { base32Decode, hotp, totpStep } from '../../backend/src/auth/totp.ts';
import { createProject, PASSWORD } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { API_URL, MFA_API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { openRowMenu, row } from '../support/projects.ts';

test('with the requirement on, an owner is prompted only when the server refuses an owner action, and after setting up an authenticator it goes through', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Required farm');
	// Every API call the page makes goes to the API with the requirement on.
	await page.route(`${API_URL}/**`, async (route) => {
		const response = await route.fetch({ url: route.request().url().replace(API_URL, MFA_API_URL) });
		await route.fulfill({ response });
	});
	const stillThere = async () => (await page.request.get(`${API_URL}/projects/${project.id}`)).status();

	// Working on the project needs nothing: no banner, no badge.
	await page.goto('/');
	await expect(row(page, 'Required farm')).toBeVisible();
	await expect(page.locator('[data-mfa-prompt]')).toHaveCount(0);
	await expect(page.locator('[data-mfa-badge]')).toHaveCount(0);

	// Deleting the project (owner only) is refused by the server: the banner, and the project is still there.
	await openRowMenu(page, 'Required farm');
	await row(page, 'Required farm').getByRole('button', { name: 'Delete Required farm' }).click();
	await answerConfirm(page, true, 'Delete project “Required farm”?');
	const banner = page.getByRole('region', { name: 'Two-step sign-in' });
	await expect(banner).toHaveAttribute('data-mfa-prompt', 'setup');
	expect(await stillThere()).toBe(200);

	// Set it up from the banner's link.
	await banner.getByRole('link', { name: 'Set up two-step sign-in' }).click();
	const panel = page.getByRole('region', { name: 'Two-step sign-in' });
	await panel.getByRole('button', { name: 'Set up the app' }).click();
	await panel.getByLabel('Current password').fill(PASSWORD);
	await panel.getByRole('button', { name: 'Continue' }).click();
	const secret = (await panel.locator('[data-totp-secret]').getAttribute('data-totp-secret'))!;
	await panel.getByLabel('Enter the code the app shows').fill(hotp(base32Decode(secret)!, totpStep(Date.now())));
	await panel.getByRole('button', { name: 'Turn on the authenticator app' }).click();
	await panel.getByRole('button', { name: 'I’ve saved them' }).click();
	await expect(panel).toHaveAttribute('data-two-step', 'on');

	// The same delete now goes through on the requirement's server.
	await page.goto('/');
	await openRowMenu(page, 'Required farm');
	await row(page, 'Required farm').getByRole('button', { name: 'Delete Required farm' }).click();
	await answerConfirm(page, true, 'Delete project “Required farm”?');
	await expect(row(page, 'Required farm')).toHaveCount(0);
	await expect(page.locator('[data-mfa-prompt]')).toHaveCount(0);
	expect(await stillThere()).toBe(404);
});
