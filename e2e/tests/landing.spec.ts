// The public landing page (issue #57; docs/ui.md § Landing page): a signed-out
// visitor to `/` sees it instead of a sign-in redirect, /welcome is the same
// page prerendered for crawlers and link previews, and a signed-in `/` is still
// the projects list. Every other signed-out route still goes to /login?next=.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { words } from '../support/lang.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { expect, test } from '../support/fixtures.ts';

const HEADLINE = 'Every drop in the catchment, accounted for.';
const PHONE = { width: 390, height: 844 };

// The what-if's figures, from the generated module the page reads (by URL, so
// the e2e typecheck doesn't pull in the frontend's modules).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
type Cell = { reserveDays: number; supplied: number };
const { DATA } = (await import(pathToFileURL(path.join(ROOT, 'frontend/src/lib/components/landing/data.generated.ts')).href)) as {
	DATA: { whatIf: { farm: string; extraHa: number[]; damScale: number[]; grid: Cell[][] } };
};

const headline = (page: Page) => page.getByRole('heading', { level: 1, name: HEADLINE });

/** Scroll the whole page so lazy pictures and in-view reveals have all run. */
async function scrollThrough(page: Page) {
	const height = await page.evaluate(() => document.documentElement.scrollHeight);
	for (let y = 0; y < height; y += 600) await page.evaluate((top) => window.scrollTo(0, top), y);
	await page.evaluate(() => window.scrollTo(0, 0));
}

test('a signed-out visitor to / sees the landing page, and its buttons lead to sign-in and sign-up', async ({ page }) => {
	await page.goto('/');
	await expect(headline(page)).toBeVisible();
	await expect(page).toHaveURL('/');
	await expect(page).toHaveTitle('Water Management: daily water balance for a catchment');

	await page.getByRole('link', { name: 'Create an account' }).first().click();
	await expect(page).toHaveURL('/register');
	await page.goBack();
	await expect(headline(page)).toBeVisible();

	await page.getByRole('main').getByRole('link', { name: 'Sign in' }).first().click();
	await expect(page).toHaveURL('/login');
	await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
});

test('a signed-in / is still the projects list, and /welcome still shows the landing page', async ({ page, owner }) => {
	void owner;
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	await expect(headline(page)).toHaveCount(0);
	await page.goto('/welcome');
	await expect(headline(page)).toBeVisible();
});

test('every other signed-out route still goes to /login, remembering where', async ({ page }) => {
	for (const route of ['/teams', '/account', '/projects/00000000-0000-4000-8000-000000000000']) {
		await page.goto(route);
		await expect(page).toHaveURL(`/login?next=${encodeURIComponent(route)}`);
	}
});

test('/welcome is prerendered HTML with its link-preview tags, before any script runs', async ({ request }) => {
	const res = await request.get('/welcome');
	expect(res.status()).toBe(200);
	const html = await res.text();
	// The content is in the HTML itself, not rendered by the client.
	expect(html).toContain(HEADLINE);
	expect(html).toContain('From rainfall to river');
	expect(html).toMatch(/<meta name="description" content="Model a catchment day by day/);
	expect(html).toMatch(/<meta property="og:title" content="Water Management: daily water balance for a catchment"/);
	expect(html).toMatch(/<meta name="twitter:card" content="summary_large_image"/);
	const image = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1];
	expect(image, 'og:image').toMatch(/^https?:\/\/[^/]+\/landing\/og\.jpg$/);
	expect(html).toMatch(/<link rel="canonical" href="https?:\/\/[^/"]+\/welcome"/);
	// The social card itself is served.
	const card = await request.get('/landing/og.jpg');
	expect(card.status()).toBe(200);
	expect(card.headers()['content-type']).toBe('image/jpeg');
});

test('the what-if answers from the precomputed runs, in words and figures', async ({ page }) => {
	const w = DATA.whatIf;
	const today = w.grid[0]![0]!;
	await page.goto('/');
	const card = page.getByRole('region', { name: 'Try a what-if' });
	await card.scrollIntoViewIfNeeded();
	await expect(card.getByText('This is the farm as it is today. Move a slider to change it.')).toBeVisible();

	// The most apples, today's dam.
	const apples = card.getByRole('slider', { name: /More apples/ });
	await apples.focus();
	await page.keyboard.press('End');
	await expect(apples).toHaveAttribute('aria-valuetext', `${w.extraHa.at(-1)} more hectares`);
	const most = w.grid[w.extraHa.length - 1]![0]!;
	await expect(card.getByText(`${Math.round(most.supplied)} % of what the farm needs`)).toBeVisible();
	const days = Math.round(most.reserveDays - today.reserveDays);
	const points = Math.round(today.supplied - most.supplied);
	await expect(card.getByText(`It costs the river ${days} more days a year below the reserve, and the farm gets ${points} points less of what it needs.`)).toBeVisible();

	// A dam twice the size gives the farm back much of it.
	const dam = card.getByRole('slider', { name: /Dam size/ });
	await dam.focus();
	await page.keyboard.press('End');
	const both = w.grid[w.extraHa.length - 1]![w.damScale.length - 1]!;
	await expect(card.getByText(`${Math.round(both.supplied)} % of what the farm needs`)).toBeVisible();
	await expect(card.getByText(`${Math.round(both.reserveDays)} days a year`)).toBeVisible();
});

test('the hero moves only when motion is allowed, and rests on its last frame otherwise', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/');
	const scene = page.locator('.hero .scene');
	await expect(scene).toHaveAttribute('data-motion', 'off');
	// The still frame shows the gauge's tag.
	await expect(page.getByText(/Reserve met on \d+ % of days/)).toBeVisible();

	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.reload();
	await expect(scene).toHaveAttribute('data-motion', 'on');
	await expect(scene).toHaveAttribute('data-playing', 'yes');
	// Scrolled out of view, the loop pauses.
	await page.getByRole('heading', { level: 2, name: 'Why trust it' }).scrollIntoViewIfNeeded();
	await expect(scene).toHaveAttribute('data-playing', 'no');
});

for (const scheme of ['light', 'dark'] as const) {
	test(`the landing page has no a11y violations at desktop and phone size, ${scheme}`, async ({ page }) => {
		test.setTimeout(60_000);
		await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
		await page.setViewportSize({ width: 1440, height: 960 });
		await page.goto('/');
		await expect(headline(page)).toBeVisible();
		await scrollThrough(page);
		await expectNoViolations(page);

		await page.setViewportSize(PHONE);
		await page.goto('/welcome');
		await expect(headline(page)).toBeVisible();
		await scrollThrough(page);
		await expectNoViolations(page);
		await expectNoSidewaysScroll(page);
	});
}

test('the landing page switches to Afrikaans', async ({ page }) => {
	const af = await words('af');
	await page.goto('/');
	await expect(headline(page)).toBeVisible();
	await page.getByRole('button', { name: 'Afrikaans' }).click();
	await expect(page.getByRole('heading', { level: 1, name: af(HEADLINE) })).toBeVisible();
	await expect(page.locator('html')).toHaveAttribute('lang', 'af');
	await expect(page.getByRole('heading', { level: 2, name: af('From rainfall to river') })).toBeVisible();
});
