// The landing page once per language (issue #137; docs/ui.md § Landing page):
// /welcome is prerendered in English and /welcome/<code> in each other
// language of the table, each with its own <html lang>, canonical and
// hreflang links, and a language switch that is a pair of links between the
// addresses. /welcome also sends a visitor whose choice is another language
// on to that language's address. The words are read from the catalogues
// (support/lang.ts), against the production e2e build.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { languages, words } from '../support/lang.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { expect, test } from '../support/fixtures.ts';

const HEADLINE = 'Every drop in the catchment, accounted for.';
const TITLE = 'Water Management: daily water balance for a catchment';
const OTHER = (await languages()).filter((l) => l.code !== 'en');

const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });
const storedChoice = (page: Page) => page.evaluate(() => localStorage.getItem('wm.locale'));

test('/welcome is English in its HTML, and points at every language', async ({ request }) => {
	const html = await (await request.get('/welcome')).text();
	expect(html).toMatch(/<html lang="en">/);
	expect(html).toContain(HEADLINE);
	expect(/<title>([^<]*)<\/title>/.exec(html)?.[1]).toBe(TITLE);
	expect(html).toMatch(/<link rel="canonical" href="https?:\/\/[^/"]+\/welcome"/);
	expect(html).toMatch(/<link rel="alternate" hreflang="x-default" href="https?:\/\/[^/"]+\/welcome"/);
	expect(html).toMatch(/<link rel="alternate" hreflang="en" href="https?:\/\/[^/"]+\/welcome"/);
	for (const l of OTHER) expect(html).toMatch(new RegExp(`<link rel="alternate" hreflang="${l.code}" href="https?://[^/"]+/welcome/${l.code}"`));
});

for (const l of OTHER) {
	test(`/welcome/${l.code} is prerendered in ${l.name}, with lang="${l.code}", before any script runs`, async ({ request, browser }) => {
		const w = await words(l.code);
		const res = await request.get(`/welcome/${l.code}`);
		expect(res.status()).toBe(200);
		const html = await res.text();
		expect(html).toMatch(new RegExp(`<html lang="${l.code}">`));
		expect(html).toContain(w(HEADLINE));
		expect(html).toContain(w('From rainfall to river'));
		expect(html).not.toContain(HEADLINE);
		expect(/<title>([^<]*)<\/title>/.exec(html)?.[1]).toBe(w(TITLE));
		expect(html).toMatch(new RegExp(`<link rel="canonical" href="https?://[^/"]+/welcome/${l.code}"`));
		expect(html).toMatch(/<link rel="alternate" hreflang="x-default" href="https?:\/\/[^/"]+\/welcome"/);
		expect(html).toMatch(new RegExp(`<meta property="og:url" content="https?://[^/"]+/welcome/${l.code}"`));

		// Without script: the page is that language's, and the switch's English link leads to /welcome.
		const noScript = await browser.newContext({ javaScriptEnabled: false });
		const page = await noScript.newPage();
		await page.goto(`/welcome/${l.code}`);
		await expect(page.locator('html')).toHaveAttribute('lang', l.code);
		await expect(h1(page, w(HEADLINE))).toBeVisible();
		const current = page.getByRole('link', { name: l.name, exact: true });
		await expect(current).toHaveAttribute('aria-current', 'true');
		await page.getByRole('link', { name: 'English', exact: true }).click();
		await expect(page).toHaveURL('/welcome');
		await expect(page.locator('html')).toHaveAttribute('lang', 'en');
		await expect(h1(page, HEADLINE)).toBeVisible();
		await noScript.close();
	});

	test(`/welcome/${l.code} stays ${l.name} once the app runs, and the switch moves between the addresses`, async ({ page }) => {
		const w = await words(l.code);
		// The e2e browser's own language is English (en-ZA): the address wins.
		await page.goto(`/welcome/${l.code}`);
		await expect(h1(page, w(HEADLINE))).toBeVisible();
		// Reading it there becomes this device's choice (it had none): the app has run its language step.
		await expect.poll(() => storedChoice(page)).toBe(l.code);
		await expect(page.locator('html')).toHaveAttribute('lang', l.code);
		await expect(page).toHaveURL(`/welcome/${l.code}`);

		await page.getByRole('link', { name: 'English', exact: true }).click();
		await expect(page).toHaveURL('/welcome');
		await expect(h1(page, HEADLINE)).toBeVisible();
		await expect(page.locator('html')).toHaveAttribute('lang', 'en');
		await expect(page.getByRole('link', { name: 'English', exact: true })).toHaveAttribute('aria-current', 'true');
		expect(await storedChoice(page)).toBe('en');

		await page.getByRole('link', { name: l.name, exact: true }).click();
		await expect(page).toHaveURL(`/welcome/${l.code}`);
		await expect(h1(page, w(HEADLINE))).toBeVisible();
		await expect(page.locator('html')).toHaveAttribute('lang', l.code);
		expect(await storedChoice(page)).toBe(l.code);

		// The sign-in page it leads to carries on in that language.
		await page.getByRole('main').getByRole('link', { name: w('Sign in') }).first().click();
		await expect(page).toHaveURL('/login');
		await expect(page.locator('html')).toHaveAttribute('lang', l.code);
	});

	test(`/welcome sends a visitor who chose ${l.name}, or whose browser asks for it, to /welcome/${l.code}`, async ({ page, browser }) => {
		const w = await words(l.code);
		await page.addInitScript((code) => localStorage.setItem('wm.locale', code), l.code);
		await page.goto('/welcome');
		await expect(page).toHaveURL(`/welcome/${l.code}`);
		await expect(h1(page, w(HEADLINE))).toBeVisible();
		await expect(page.locator('html')).toHaveAttribute('lang', l.code);

		const theirs = await browser.newContext({ locale: l.code });
		const fresh = await theirs.newPage();
		await fresh.goto('/welcome');
		await expect(fresh).toHaveURL(`/welcome/${l.code}`);
		await expect(h1(fresh, w(HEADLINE))).toBeVisible();
		await theirs.close();
	});

	for (const scheme of ['light', 'dark'] as const) {
		test(`/welcome/${l.code} has no a11y violations and fits a phone, ${scheme}`, async ({ page }) => {
			const w = await words(l.code);
			await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
			await page.setViewportSize({ width: 360, height: 740 });
			await page.goto(`/welcome/${l.code}`);
			await expect(h1(page, w(HEADLINE))).toBeVisible();
			await expect.poll(() => storedChoice(page)).toBe(l.code);
			await expectNoViolations(page);
			await expectNoSidewaysScroll(page);
		});
	}
}

test('an English visitor stays on /welcome, in English', async ({ page }) => {
	await page.goto('/welcome');
	await expect(h1(page, HEADLINE)).toBeVisible();
	// The app has run: the landing's lazy art is armed once it has hydrated.
	await expect(page.locator('.audiences')).toHaveAttribute('data-armed', 'yes');
	await expect(page).toHaveURL('/welcome');
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	expect(await storedChoice(page)).toBeNull();
});
