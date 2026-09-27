// The sign-in and emailed-link pages on their shared frame (AuthCard): every
// page and state at 1440×960, 1280×800 and 390×844, light and dark. They fit
// the window with no page scroll and no sideways scroll, have one title, and
// the title sits in the same place on every page (the form starts on the
// brand copy's top line rather than being centred, so it doesn't jump from
// page to page or when a message appears). Plus an axe scan of each at
// desktop and phone size, focus after a state replaces the focused control,
// and the password field's Show / Hide button.
// (auth-layout.spec.ts checks the frame beside a space-taking scrollbar;
// a11y.spec.ts scans the signed-out pages at its default size.)
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { register } from '../support/api.ts';
import { plantEmailToken } from '../support/db.ts';
import { expect, test } from '../support/fixtures.ts';

/** Well-formed, but no such token: the server answers "this link is no good". */
const DEAD_TOKEN = 'q'.repeat(43);

const SIZES = [
	{ name: '1440×960', viewport: { width: 1440, height: 960 }, phone: false },
	{ name: '1280×800', viewport: { width: 1280, height: 800 }, phone: false },
	{ name: '390×844', viewport: { width: 390, height: 844 }, phone: true }
] as const;

/**
 * Each page in each state a signed-out visitor can reach without a real link,
 * and what shows it has settled: the page's own message, never any alert (the
 * layout's "Could not reach the API" is one too).
 */
const STATES: { name: string; path: string; settle: (page: Page) => Promise<void> }[] = [
	{ name: 'sign in', path: '/login', settle: (p) => expect(p.getByLabel('Email')).toBeVisible() },
	{ name: 'create an account', path: '/register', settle: (p) => expect(p.getByLabel('Display name')).toBeVisible() },
	// The longest sign-up: the dead-invitation warning above the form.
	{ name: 'a dead invitation', path: `/register?invite=${DEAD_TOKEN}`, settle: (p) => expect(p.getByRole('alert')).toHaveText(/This invitation link has expired or was withdrawn/) },
	{ name: 'forgot password', path: '/forgot-password', settle: (p) => expect(p.getByLabel('Email')).toBeVisible() },
	{ name: 'choose a new password', path: `/reset-password?token=${DEAD_TOKEN}`, settle: (p) => expect(p.getByLabel('New password', { exact: true })).toBeVisible() },
	{ name: 'a reset link without its token', path: '/reset-password', settle: (p) => expect(p.getByRole('alert')).toHaveText(/This reset link is invalid/) },
	{ name: 'a dead confirmation link', path: `/verify-email?token=${DEAD_TOKEN}`, settle: (p) => expect(p.getByRole('alert')).toHaveText(/This confirmation link is invalid/) },
	{ name: 'stop alert emails', path: `/alerts/unsubscribe#t=${DEAD_TOKEN}`, settle: (p) => expect(p.locator('[data-state="ask"]')).toBeVisible() },
	{ name: 'an unsubscribe link without its token', path: '/alerts/unsubscribe', settle: (p) => expect(p.locator('[data-state="incomplete"]')).toBeVisible() }
];

/** Where the page's title and form sit, and whether the page scrolls either way. */
function measure(page: Page) {
	return page.evaluate(() => {
		const html = document.documentElement;
		const h1 = document.querySelectorAll('h1');
		const box = document.querySelector('.form-box')!.getBoundingClientRect();
		return {
			h1Count: h1.length,
			h1Top: h1[0]!.getBoundingClientRect().top,
			boxBottom: box.bottom,
			verticalOverflow: html.scrollHeight - innerHeight,
			sidewaysOverflow: html.scrollWidth - html.clientWidth
		};
	});
}

for (const size of SIZES) {
	for (const colorScheme of ['light', 'dark'] as const) {
		test.describe(`${size.name}, ${colorScheme}`, () => {
			test.use({ viewport: size.viewport, colorScheme });

			test('every page fits the window, with its title in the same place', async ({ page }) => {
				let titleTop: number | null = null;
				for (const s of STATES) {
					await page.goto(s.path);
					await s.settle(page);
					const m = await measure(page);
					expect(m.h1Count, s.name).toBe(1);
					expect(m.verticalOverflow, `${s.name}: the page scrolls`).toBeLessThanOrEqual(0);
					expect(m.sidewaysOverflow, `${s.name}: the page scrolls sideways`).toBeLessThanOrEqual(0);
					expect(m.boxBottom, `${s.name}: the form runs off the window`).toBeLessThanOrEqual(size.viewport.height);
					titleTop ??= m.h1Top;
					expect(Math.abs(m.h1Top - titleTop), `${s.name}: the title moved`).toBeLessThanOrEqual(1);
				}
				// Near the top: the first screen of a phone keeps the title and first field above the keyboard.
				expect(titleTop!).toBeLessThan(size.phone ? 220 : 160);
			});

			test('a wrong password shows its message without moving the title', async ({ page }, testInfo) => {
				await page.goto('/login');
				await expect(page.getByLabel('Email')).toBeVisible();
				const before = await measure(page);
				// An address of its own: repeated failures on one address lock it for a minute.
				await page.getByLabel('Email').fill(`nobody-${testInfo.testId}-${testInfo.repeatEachIndex}@example.com`);
				await page.getByLabel('Password').fill('wrong password');
				await page.getByRole('button', { name: 'Sign in' }).click();
				await expect(page.getByRole('alert')).toHaveText('Wrong email or password.');
				const after = await measure(page);
				expect(after.h1Top).toBe(before.h1Top);
				expect(after.verticalOverflow).toBeLessThanOrEqual(0);
			});
		});
	}
}

// axe at a desktop and a phone size, both themes, every state.
for (const size of [SIZES[0], SIZES[2]]) {
	for (const colorScheme of ['light', 'dark'] as const) {
		test.describe(`a11y ${size.name}, ${colorScheme}`, () => {
			test.use({ viewport: size.viewport, colorScheme });
			for (const s of STATES) {
				test(`${s.name} has no WCAG 2.2 AA violations`, async ({ page }) => {
					await page.goto(s.path);
					await s.settle(page);
					await expectNoViolations(page);
				});
			}

			test('the already-signed-in invitation view has no violations', async ({ page, owner }) => {
				void owner;
				await page.goto(`/register?invite=${DEAD_TOKEN}`);
				await expect(page.getByRole('heading', { name: 'You’re already signed in' })).toBeVisible();
				await expect(page.getByRole('alert')).toHaveText(/This invitation link is invalid/);
				await expectNoViolations(page);
			});
		});
	}
}

test.describe('focus follows the page when its content is replaced', () => {
	test('forgot password: sent, then a different address', async ({ page }) => {
		await page.goto('/forgot-password?email=someone@example.com');
		await page.getByRole('button', { name: 'Send reset link' }).click();
		const title = page.getByRole('heading', { level: 1 });
		await expect(title).toHaveText('Check your email');
		await expect(title).toBeFocused();
		await page.getByRole('button', { name: 'Use a different address' }).click();
		await expect(title).toHaveText('Reset your password');
		await expect(title).toBeFocused();
		// The next Tab reaches the form again.
		await expect(page.getByLabel('Email')).toHaveValue('someone@example.com');
	});

	test('choose a new password: done, and a dead link', async ({ page, browser }) => {
		const other = await browser.newContext();
		const user = await register(other.request, 'Focus reset');
		await other.close();
		const token = await plantEmailToken(user.email, 'reset');
		await page.goto(`/reset-password?token=${token}`);
		await page.getByLabel('New password', { exact: true }).fill('another-password-1');
		await page.getByLabel('Repeat new password').fill('another-password-1');
		await page.getByRole('button', { name: 'Set new password' }).click();
		await expect(page.getByRole('status').filter({ hasText: 'Your password has been changed' })).toBeVisible();
		await expect(page.getByRole('heading', { level: 1 })).toBeFocused();

		// The same link again: already used.
		await page.goto(`/reset-password?token=${token}`);
		await page.getByLabel('New password', { exact: true }).fill('another-password-2');
		await page.getByLabel('Repeat new password').fill('another-password-2');
		await page.getByRole('button', { name: 'Set new password' }).click();
		await expect(page.getByRole('alert')).toHaveText(/This reset link is invalid/);
		await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
	});

	test('stop alert emails with a dead link: focus on the title, and Manage alerts once', async ({ page }) => {
		await page.goto(`/alerts/unsubscribe#t=${DEAD_TOKEN}`);
		// Asking: the footer offers Manage alerts.
		await expect(page.getByRole('link', { name: 'Manage alerts' })).toHaveCount(1);
		await page.getByRole('button', { name: 'Stop these emails' }).click();
		await expect(page.getByRole('alert')).toHaveText(/This link doesn’t work any more/);
		await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
		// The answer's button is the one Manage alerts; the footer doesn't repeat it.
		await expect(page.getByRole('link', { name: 'Manage alerts' })).toHaveCount(1);
	});
});

test('the password field’s Show / Hide button is named for what it does, and the field keeps the only “Password” label', async ({ page }) => {
	await page.goto('/login');
	const field = page.getByLabel('Password');
	await expect(field).toHaveAttribute('type', 'password');
	await page.getByRole('button', { name: 'Show password' }).click();
	await expect(field).toHaveAttribute('type', 'text');
	await expect(page.getByRole('button', { name: 'Hide password' })).toBeVisible();
	await page.getByRole('button', { name: 'Hide password' }).click();
	await expect(field).toHaveAttribute('type', 'password');
});
