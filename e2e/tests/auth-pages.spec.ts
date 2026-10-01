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
import { words } from '../support/lang.ts';

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
/**
 * `long`: the sign-up form carries the Terms' main points above its button
 * (docs/legal-status.md). On a wide window they sit in their own scroll box,
 * which shrinks until the form fits (issue #162; the 1440×900 test below), and
 * past its minimum the page scrolls; on a phone the page scrolls. Its title
 * still starts on the same line as every other page's.
 */
const STATES: { name: string; path: string; settle: (page: Page) => Promise<void>; long?: boolean }[] = [
	{ name: 'sign in', path: '/login', settle: (p) => expect(p.getByLabel('Email')).toBeVisible() },
	{ name: 'create an account', path: '/register', settle: (p) => expect(p.getByLabel('Display name')).toBeVisible(), long: true },
	// The longest sign-up: the dead-invitation warning above the form.
	{ name: 'a dead invitation', path: `/register?invite=${DEAD_TOKEN}`, settle: (p) => expect(p.getByRole('alert')).toHaveText(/This invitation link has expired or was withdrawn/), long: true },
	{ name: 'forgot password', path: '/forgot-password', settle: (p) => expect(p.getByLabel('Email')).toBeVisible() },
	{ name: 'choose a new password', path: `/reset-password?token=${DEAD_TOKEN}`, settle: (p) => expect(p.getByLabel('New password', { exact: true })).toBeVisible() },
	{ name: 'a reset link without its token', path: '/reset-password', settle: (p) => expect(p.getByRole('alert')).toHaveText(/This reset link is invalid/) },
	{ name: 'a dead confirmation link', path: `/verify-email?token=${DEAD_TOKEN}`, settle: (p) => expect(p.getByRole('alert')).toHaveText(/This confirmation link is invalid/) },
	{ name: 'stop alert emails', path: `/alerts/unsubscribe#t=${DEAD_TOKEN}`, settle: (p) => expect(p.locator('[data-state="ask"]')).toBeVisible() },
	{ name: 'an unsubscribe link without its token', path: '/alerts/unsubscribe', settle: (p) => expect(p.locator('[data-state="incomplete"]')).toBeVisible() },
	{ name: 'was this alert useful', path: `/alerts/feedback#t=${DEAD_TOKEN}&a=yes`, settle: (p) => expect(p.locator('[data-state="ask"]')).toBeVisible() },
	{ name: 'a feedback link without its token', path: '/alerts/feedback', settle: (p) => expect(p.locator('[data-state="incomplete"]')).toBeVisible() }
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
					expect(m.sidewaysOverflow, `${s.name}: the page scrolls sideways`).toBeLessThanOrEqual(0);
					if (s.long) {
						// It scrolls no further than the form: the button that makes the account ends the page.
						const button = page.getByRole('button', { name: /^Create account/ });
						await button.scrollIntoViewIfNeeded();
						await expect(button).toBeInViewport();
						const end = await page.evaluate(() => document.documentElement.scrollHeight - (document.querySelector('.form-box')!.lastElementChild!.getBoundingClientRect().bottom + scrollY));
						// The form column's bottom padding (2.5rem, 35 px, at most), and no more.
						expect(end, `${s.name}: room below the form`).toBeLessThanOrEqual(36);
						await page.evaluate(() => scrollTo(0, 0));
					} else {
						expect(m.verticalOverflow, `${s.name}: the page scrolls`).toBeLessThanOrEqual(0);
						expect(m.boxBottom, `${s.name}: the form runs off the window`).toBeLessThanOrEqual(size.viewport.height);
					}
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

// Issue #162: on a laptop's window (1440×900, 1280×800) the sign-up page doesn't
// scroll, in English and Afrikaans, with or without a dead invitation's warning.
// The Terms' main points, which made it 1146 px tall, are their own scroll box
// above the tick and the button: named by its heading, never under one line of
// points, reached with Tab and scrolled with the keyboard, with a fade while
// there is more below and "Read the full terms" beside the heading. On a phone
// the page scrolls and the box stays contained.
for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
	for (const lang of ['en', 'af'] as const) {
		for (const invite of [false, true]) {
			const name = `${viewport.width}×${viewport.height}, ${lang}${invite ? ', a dead invitation' : ''}`;
			test(`the sign-up form fits the window, its terms summary a keyboard-scrollable box, ${name}`, async ({ page }) => {
				const w = lang === 'en' ? (english: string) => english : await words(lang);
				await page.addInitScript((code) => localStorage.setItem('wm.locale', code), lang);
				await page.setViewportSize(viewport);
				await page.goto(invite ? `/register?invite=${DEAD_TOKEN}` : '/register');
				if (invite) await expect(page.getByRole('alert')).toBeVisible();
				const box = page.getByRole('group', { name: w('The main things you agree to') });
				await expect(box).toBeVisible();
				expect(await page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight), 'the page scrolls').toBeLessThanOrEqual(0);
				const heading = page.getByRole('heading', { level: 2, name: w('The main things you agree to') });
				const agree = page.getByRole('checkbox');
				const button = page.getByRole('button', { name: w('Create account') });
				for (const el of [heading, box, agree, page.locator('label[for="agree"]'), button]) await expect(el).toBeInViewport({ ratio: 1 });
				// At least one line of the points shows, the fade and the link saying there is more.
				const lines = await box.evaluate((el) => el.clientHeight / parseFloat(getComputedStyle(el.querySelector('li')!).lineHeight));
				expect(lines, 'lines of points in view').toBeGreaterThanOrEqual(1);
				// "Read the full terms", beside the heading (by place: its words may not be translated yet).
				await expect(page.locator('[data-terms-summary]').getByRole('link')).toHaveAttribute('href', /\/terms$/);
				await expect(box).toHaveAttribute('tabindex', '0');
				if (invite) return;

				// Scrolled by the keyboard, the fade shown until the end.
				const fade = page.locator('[data-terms-summary] .scroll-wrap');
				await expect(fade).toHaveClass(/\bmore\b/);
				await agree.focus();
				await page.keyboard.press('Shift+Tab');
				await expect(box).toBeFocused();
				await page.keyboard.press('ArrowDown');
				await expect.poll(() => box.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
				await page.keyboard.press('End');
				await expect.poll(() => box.evaluate((el) => Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight)).toBe(true);
				await expect(fade).not.toHaveClass(/\bmore\b/);
				await expectNoViolations(page);
			});
		}
	}
}

test('on a phone the sign-up page scrolls, and the terms summary stays a contained, focusable box', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/register');
	const box = page.getByRole('group', { name: 'The main things you agree to' });
	await expect(box).toHaveAttribute('tabindex', '0');
	// At most 12rem (168 px at the 14 px root), with more in it to scroll.
	expect(await box.evaluate((el) => el.clientHeight)).toBeLessThanOrEqual(168);
	expect(await box.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
});

// Issue #162: the consent line's links read as links, not as the label's text
// (WCAG 1.4.1: colour alone isn't enough, so they are underlined too).
for (const colorScheme of ['light', 'dark'] as const) {
	test(`the sign-up form’s Terms and Privacy links are underlined in the link colour, ${colorScheme}`, async ({ page }) => {
		await page.emulateMedia({ colorScheme });
		await page.goto('/register');
		const label = page.locator('label[for="agree"]');
		for (const name of ['Terms of use', 'Privacy notice']) {
			const link = label.getByRole('link', { name });
			await expect(link).toHaveCSS('text-decoration-line', 'underline');
			const [linkColour, labelColour, accent] = await link.evaluate((a) => {
				const probe = document.createElement('a');
				probe.href = '#';
				document.body.append(probe);
				const out = [getComputedStyle(a).color, getComputedStyle(a.closest('label')!).color, getComputedStyle(probe).color];
				probe.remove();
				return out;
			});
			expect(linkColour).toBe(accent);
			expect(linkColour).not.toBe(labelColour);
		}
	});
}

// Issue #51 (the accessibility persona). The toggle sits beside the text, taking
// its own width, so a long word (Afrikaans "Versteek", 70 px) never covers the
// end of a revealed password (WCAG 1.4.4 / 1.4.10).
for (const lang of ['en', 'af'] as const) {
	test(`the password’s Show / Hide button never covers the field’s text, ${lang}`, async ({ page }) => {
		const w = lang === 'en' ? (english: string) => english : await words(lang);
		await page.addInitScript((code) => localStorage.setItem('wm.locale', code), lang);
		await page.setViewportSize({ width: 360, height: 740 });
		await page.goto('/login');
		const field = page.locator('#password');
		for (const name of ['Show password', 'Hide password']) {
			const toggle = page.getByRole('button', { name: w(name) });
			await expect(toggle).toBeVisible();
			const [input, button] = await Promise.all([field.boundingBox(), toggle.boundingBox()]);
			// The input's box (its text area and padding) ends before the button starts.
			expect(input!.x + input!.width, `${name}: the input runs under the button`).toBeLessThanOrEqual(button!.x + 0.5);
			await toggle.click();
		}
	});
}

// No text under 14 px on the sign-in pages (issue #51): they were the smallest
// text in the app (11–12 px labels, hints and links) on the first screen a
// reduced-vision farmer meets. Every visible text, at a phone's width.
for (const lang of ['en', 'af'] as const) {
	test(`the sign-in pages set no text under 14 px, ${lang}`, async ({ page }) => {
		await page.addInitScript((code) => localStorage.setItem('wm.locale', code), lang);
		await page.setViewportSize({ width: 390, height: 844 });
		const w = lang === 'en' ? (english: string) => english : await words(lang);
		for (const path of ['/login', '/register', '/forgot-password']) {
			await page.goto(path);
			// In the language's words (the Privacy notice link is on every one of them).
			await expect(page.getByRole('link', { name: w('Privacy notice') }).first()).toBeVisible();
			const small = await page.evaluate(() => {
				const out: string[] = [];
				const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
				for (let n = walk.nextNode(); n; n = walk.nextNode()) {
					const el = n.parentElement;
					if (!el || !n.textContent?.trim() || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
					if (el.closest('.visually-hidden')) continue;
					const size = Number.parseFloat(getComputedStyle(el).fontSize);
					if (size < 14) out.push(`${size}px: ${n.textContent.trim().slice(0, 40)}`);
				}
				return out;
			});
			expect(small, path).toEqual([]);
		}
	});
}

// WCAG 2.2.2 Pause, Stop, Hide (issue #51): the sign-in panel's catchment is
// decoration beside the form, so rather than a pause button it moves for under
// 5 s and then holds still.
test('the sign-in panel’s scene moves for under 5 s, then holds still', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.clock.install();
	await page.goto('/login');
	const scene = page.locator('.panel-brand svg.scene');
	await expect(scene).toHaveAttribute('data-still', 'no');
	const running = () => scene.evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length);
	expect(await running()).toBeGreaterThan(0);
	await page.clock.runFor(4_999);
	await expect(scene).toHaveAttribute('data-still', 'yes');
	expect(await running()).toBe(0);
});
