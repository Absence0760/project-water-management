// The account page (WP-1.9): reached from the header's account menu; rename
// the account, see the address and whether it's confirmed, and change the
// password while signed in (this device stays signed in, every other one is
// signed out), and download a copy of their data (GET /auth/me/export).
import { readFile } from 'node:fs/promises';
import { register, signInUnconfirmed } from '../support/api.ts';
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
	await expect(page.getByRole('region', { name: 'Account', exact: true })).toContainText(owner.email);
	await expect(page.getByRole('region', { name: 'Account', exact: true })).toContainText('Confirmed');

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

test('“Download my data” saves the account’s data export as a JSON file', async ({ page, owner }) => {
	await page.goto('/account');
	const panel = page.getByRole('region', { name: 'Your data' });
	const [download] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: 'Download my data' }).click()]);
	expect(download.suggestedFilename()).toMatch(/^my-data_\d{4}-\d{2}-\d{2}\.json$/);
	const doc = JSON.parse(await readFile(await download.path(), 'utf8'));
	expect(doc).toMatchObject({ format: 'water-management.subject-export', account: { email: owner.email } });
	await expect(panel.getByRole('status')).toHaveText('Your data has been downloaded.');
	// A second one within the minute is refused, worded from the error's code (export_throttled), not the server's English.
	await panel.getByRole('button', { name: 'Download my data' }).click();
	await expect(panel.getByRole('alert')).toHaveText('You downloaded your data a moment ago. Try again in 1 minute.');
});

test('an unconfirmed address says so', async ({ page }) => {
	const user = await register(page.context().request, 'Unconfirmed', { verified: false });
	await signInUnconfirmed(page.context(), user);
	await page.goto('/account');
	await expect(page.getByRole('region', { name: 'Account', exact: true })).toContainText('Not confirmed');
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

// Screen use (issue #17): the header says who you are; on a wide screen the
// cards sit in two columns (Profile + Password, then Language and units +
// Alert emails + Your data) and the page fits a 1440×960 window without
// scrolling; on a phone they stack in one column; never a sideways scroll.
test.describe('layout', () => {
	const box = async (page: import('@playwright/test').Page, name: string) => (await page.getByRole('region', { name, exact: true }).boundingBox())!;

	test('two columns at 1440 × 960 that fit the window', async ({ page, owner }) => {
		await page.setViewportSize({ width: 1440, height: 960 });
		await page.goto('/account');
		await expect(page.getByLabel('Display name')).toHaveValue(owner.displayName);
		const head = page.getByRole('region', { name: 'Account', exact: true });
		await expect(head).toContainText(owner.displayName);
		await expect(head).toContainText(owner.email);

		const profile = await box(page, 'Profile');
		const password = await box(page, 'Password');
		const prefs = await box(page, 'Language and units');
		const alerts = await box(page, 'Alert emails');
		const data = await box(page, 'Your data');
		// Left column: Profile over Password; right column: the other three.
		expect(Math.abs(password.x - profile.x)).toBeLessThan(1);
		expect(password.y).toBeGreaterThan(profile.y);
		expect(prefs.x).toBeGreaterThan(profile.x + profile.width);
		expect(Math.abs(prefs.y - profile.y)).toBeLessThan(1);
		expect(Math.abs(alerts.x - prefs.x)).toBeLessThan(1);
		expect(Math.abs(data.x - prefs.x)).toBeLessThan(1);
		// The two columns use the width: together they span most of the page beside the sidebar.
		expect(prefs.x + prefs.width - profile.x).toBeGreaterThan(1000);
		// The unit radios' rows are 32 px with a mouse (2rem was 28 px at the 14 px root).
		const m3 = (await page.locator('label.radio').filter({ hasText: 'Cubic metres (m³)' }).boundingBox())!;
		expect(m3.height).toBeGreaterThanOrEqual(32);
		// Everything in view: no page scroll at all.
		const { scrollH, innerH, scrollW, innerW } = await page.evaluate(() => ({
			scrollH: document.documentElement.scrollHeight,
			innerH: window.innerHeight,
			scrollW: document.documentElement.scrollWidth,
			innerW: window.innerWidth
		}));
		expect(scrollH).toBeLessThanOrEqual(innerH);
		expect(scrollW).toBeLessThanOrEqual(innerW);
	});

	test('one column on a phone, with no sideways scroll', async ({ page, owner }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/account');
		await expect(page.getByLabel('Display name')).toHaveValue(owner.displayName);
		const order = ['Profile', 'Password', 'Language and units', 'Alert emails', 'Your data'];
		const boxes = await Promise.all(order.map((n) => box(page, n)));
		for (let i = 1; i < boxes.length; i++) {
			expect(Math.abs(boxes[i]!.x - boxes[0]!.x)).toBeLessThan(1);
			expect(boxes[i]!.y).toBeGreaterThan(boxes[i - 1]!.y + boxes[i - 1]!.height - 1);
		}
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
		expect(overflow).toBeLessThanOrEqual(0);
	});
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
