// Afrikaans layouts at 360 px (WP-2.5, issue #49): Afrikaans runs 20–30 %
// longer than English, with long compound words, so every translated page is
// checked with a complete stand-in catalogue whose words are a third longer
// (support/stretched-af.ts, no Afrikaans written): no page scrolls sideways,
// no word is cut off in its box, and axe finds nothing, in light and dark.
// With the catalogue complete the page is lang="af", so this is also the
// language switch's full path (wordsLang, <html lang>) in a production build.
//
// When the translator's reviewed wording lands, the site's af catalogue is no
// longer empty, the stand-in stops being served, and the first assertion
// below fails until this spec checks the real words.
import type { Page } from '@playwright/test';
import { createRun, seedRunnableProject } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { FARMER1, seedExamplesOnce } from '../support/examples.ts';
import { expect, test } from '../support/fixtures.ts';
import { clippedText, expectNoSidewaysScroll } from '../support/reflow.ts';
import { stretch, withStretchedAfrikaans } from '../support/stretched-af.ts';

const PHONE = { width: 360, height: 740 };

test.use({ viewport: PHONE });

test.beforeEach(async ({ page }) => {
	// This device chose Afrikaans before signing in: the layout reads it without writing the account.
	await page.addInitScript(() => localStorage.setItem('wm.locale', 'af'));
	await withStretchedAfrikaans(page);
});

/** Open `path`, wait for its words to be the stand-in Afrikaans and for `ready`, then check the layout in light and dark. */
async function checkPage(page: Page, path: string, ready: (page: Page) => Promise<void>) {
	await page.goto(path);
	await expect(page.locator('html'), 'the stand-in catalogue was not served (has reviewed Afrikaans landed? see the header)').toHaveAttribute('lang', 'af');
	await ready(page);
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await expectNoSidewaysScroll(page);
		expect(await clippedText(page), `${path}: text cut off in its box`).toEqual([]);
		await expectNoViolations(page);
	}
	await page.emulateMedia({ colorScheme: 'light' });
}

const heading = (page: Page) => expect(page.getByRole('heading', { level: 1 })).toBeVisible();

test('the signed-out pages fit a phone in long Afrikaans', async ({ page }) => {
	await checkPage(page, '/login', async (p) => {
		await expect(p.getByRole('button', { name: stretch('Sign in') })).toBeVisible();
	});
	await checkPage(page, '/register', heading);
	await checkPage(page, '/forgot-password', heading);
});

test('a farmer’s pages fit a phone in long Afrikaans', async ({ page, playwright }) => {
	test.setTimeout(90_000);
	const api = await playwright.request.newContext();
	await seedExamplesOnce(api);
	await api.dispose();
	const login = await page.request.post(`${API_URL}/auth/login`, { data: FARMER1 });
	expect(login.status(), await login.text()).toBe(200);
	const { projects } = (await (await page.request.get(`${API_URL}/projects`)).json()) as { projects: { id: string; role: string }[] };
	const projectId = projects.find((p) => p.role === 'farmer')!.id;

	const settled = async (p: Page) => {
		await heading(p);
		await expect(p.locator('main[aria-busy]')).toHaveCount(0);
	};
	for (const path of [`/farm/${projectId}`, `/farm/${projectId}/why`, `/farm/${projectId}/dam`, '/farm/words']) {
		await checkPage(page, path, settled);
	}
	await checkPage(page, '/account', async (p) => {
		await expect(p.getByRole('region', { name: stretch('Language and units') })).toBeVisible();
	});
	await checkPage(page, '/account/alerts', async (p) => {
		await expect(p.locator('main[data-ready="true"]')).toBeVisible();
	});
});

test('a share link fits a phone in long Afrikaans', async ({ page, owner, browser }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Lang taal share');
	const runId = await createRun(page.request, project.id, 'Baseline');
	const pub = await page.request.post(`${API_URL}/projects/${project.id}/publication`, {
		data: { runId, restriction: { level: 'advisory', pct: 10, noticeEn: 'Water is short on the river.', noticeAf: null } }
	});
	expect(pub.status(), await pub.text()).toBe(201);
	const made = await page.request.post(`${API_URL}/projects/${project.id}/share-links`, { data: { label: 'Neighbours', expiresInDays: 7 } });
	expect(made.status(), await made.text()).toBe(201);
	const { link } = (await made.json()) as { link: { url: string } };

	const stranger = await browser.newContext({ viewport: PHONE });
	const shared = await stranger.newPage();
	await shared.addInitScript(() => localStorage.setItem('wm.locale', 'af'));
	await withStretchedAfrikaans(shared);
	await checkPage(shared, link.url, async (p) => {
		await expect(p.locator('main[data-share-state="ready"]')).toBeVisible();
	});
	await stranger.close();
});
