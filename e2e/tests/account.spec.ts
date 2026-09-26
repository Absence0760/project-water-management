// The account page (WP-1.9): reached from the header's account menu; rename
// the account, see the address and whether it's confirmed, and change the
// password while signed in (this device stays signed in, every other one is
// signed out).
import { register } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const PHONE = { width: 360, height: 740 };

async function openAccount(page: import('@playwright/test').Page, displayName: string) {
	await page.goto('/');
	await page.getByRole('button', { name: `Account menu for ${displayName}` }).click();
	await page.getByRole('link', { name: 'Account' }).click();
	await expect(page).toHaveURL('/account');
	await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
}

test('the account menu opens the account page, which renames the account', async ({ page, owner }) => {
	await openAccount(page, owner.displayName);
	await expect(page.getByRole('region', { name: 'Profile' })).toContainText(owner.email);
	await expect(page.getByRole('region', { name: 'Profile' })).toContainText('Confirmed');

	// Save is only offered once the name differs.
	const save = page.getByRole('button', { name: 'Save name' });
	await expect(save).toBeDisabled();
	await page.getByLabel('Display name').fill('  Dr Renamed  ');
	await save.click();
	await expect(page.getByRole('status').filter({ hasText: 'Name saved.' })).toBeVisible();
	await expect(page.getByLabel('Display name')).toHaveValue('Dr Renamed');
	// The header follows at once, and the name is really stored.
	await expect(page.getByRole('button', { name: 'Account menu for Dr Renamed' })).toBeVisible();
	await page.reload();
	await expect(page.getByLabel('Display name')).toHaveValue('Dr Renamed');

	// A blank name is refused without a request.
	await page.getByLabel('Display name').fill('   ');
	await page.getByRole('button', { name: 'Save name' }).click();
	await expect(page.getByRole('alert')).toHaveText('Enter a display name.');
	await expect(page.getByLabel('Display name')).toHaveAttribute('aria-invalid', 'true');
});

test('an unconfirmed address says so', async ({ page }) => {
	const user = await register(page.context().request, 'Unconfirmed', { verified: false });
	void user;
	await page.goto('/account');
	await expect(page.getByRole('region', { name: 'Profile' })).toContainText('Not confirmed');
});

test('changing the password keeps this device signed in and signs out another device', async ({ page, owner, browser }) => {
	// A second "device", signed in through the login form as the same account.
	const otherDevice = await browser.newContext();
	const otherPage = await otherDevice.newPage();
	await otherPage.goto('/login');
	await otherPage.getByLabel('Email').fill(owner.email);
	await otherPage.getByLabel('Password').fill(owner.password);
	await otherPage.getByRole('button', { name: 'Sign in' }).click();
	await expect(otherPage.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();

	await page.goto('/account');
	await page.getByLabel('Current password').fill(owner.password);
	await page.getByLabel('New password', { exact: true }).fill('a brand new password');
	await page.getByLabel('Repeat new password').fill('a brand new password');
	await page.getByRole('button', { name: 'Change password' }).click();
	await expect(
		page.getByRole('status').filter({ hasText: 'Password changed. Every other device has been signed out.' })
	).toBeVisible();
	await expect(page.getByLabel('Current password')).toHaveValue('');

	// This device is still signed in, with the re-issued cookie.
	await page.goto('/teams');
	await expect(page.getByRole('heading', { level: 1, name: 'Teams' })).toBeVisible();

	// The other device's next request is rejected.
	await otherPage.goto('/teams');
	await expect(otherPage).toHaveURL(/\/login\?next=/);
	await otherDevice.close();

	// The new password signs in; the old one doesn't.
	const api = await browser.newContext();
	const old = await api.request.post(`${API_URL}/auth/login`, { data: { email: owner.email, password: owner.password } });
	expect(old.status()).toBe(401);
	const fresh = await api.request.post(`${API_URL}/auth/login`, {
		data: { email: owner.email, password: 'a brand new password' }
	});
	expect(fresh.status()).toBe(200);
	await api.close();
});

test('a wrong current password and a too-short new password are shown as errors', async ({ page, owner }) => {
	await page.goto('/account');
	const current = page.getByLabel('Current password');

	await current.fill('not my password');
	await page.getByLabel('New password', { exact: true }).fill('a brand new password');
	await page.getByLabel('Repeat new password').fill('a brand new password');
	await page.getByRole('button', { name: 'Change password' }).click();
	await expect(page.getByRole('alert')).toHaveText('Your current password is wrong.');
	await expect(current).toHaveAttribute('aria-invalid', 'true');
	// A wrong guess doesn't sign this device out.
	await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();

	await current.fill(owner.password);
	await page.getByLabel('New password', { exact: true }).fill('short');
	await page.getByLabel('Repeat new password').fill('short');
	await page.getByRole('button', { name: 'Change password' }).click();
	await expect(page.getByRole('alert')).toHaveText('Use at least 8 characters.');
	await expect(page.getByLabel('New password', { exact: true })).toHaveAttribute('aria-invalid', 'true');
	await expect(page.getByLabel('Repeat new password')).toHaveAccessibleDescription('Use at least 8 characters.');
	await expect(current).not.toHaveAttribute('aria-invalid');
});

// axe on /account in both themes, at desktop and phone width, with the error state and the open menu.
for (const colorScheme of ['light', 'dark'] as const) {
	for (const [sizeName, viewport] of [
		['desktop', { width: 1280, height: 800 }],
		['phone', PHONE]
	] as const) {
		test.describe(`${colorScheme}, ${sizeName}`, () => {
			test.use({ colorScheme, viewport });

			test('/account has no WCAG 2.2 AA violations, with an error shown and with the menu open', async ({ page, owner }) => {
				await page.goto('/account');
				await expect(page.getByLabel('Display name')).toHaveValue(owner.displayName);
				await expectNoViolations(page);

				await page.getByLabel('Current password').fill('not my password');
				await page.getByLabel('New password', { exact: true }).fill('a brand new password');
				await page.getByLabel('Repeat new password').fill('a brand new password');
				await page.getByRole('button', { name: 'Change password' }).click();
				await expect(page.getByRole('alert')).toHaveText('Your current password is wrong.');
				await expectNoViolations(page);

				const trigger = page.getByRole('button', { name: `Account menu for ${owner.displayName}` });
				await trigger.click();
				await expect(page.getByRole('link', { name: 'Account' })).toHaveAttribute('aria-current', 'page');
				await expectNoViolations(page);
				// Escape closes the menu and returns focus to its button.
				await page.keyboard.press('Escape');
				await expect(page.getByRole('link', { name: 'Account' })).toBeHidden();
				await expect(trigger).toBeFocused();
			});
		});
	}
}
