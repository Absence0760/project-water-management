// Layouts at 360 px, once per non-English language in the table (WP-2.5,
// issue #58; started as af-layout.spec.ts for Afrikaans alone, issue #49).
// A translated language can run 20–30 % longer than English, with long
// compound words, so every translated page is opened in each language on a
// phone: no page scrolls sideways, no word is cut off in its box, and axe
// finds nothing, in light and dark. The page carries that language's
// `lang` once its catalogue is complete, so this is also the language
// switch's full path (wordsLang, <html lang>) in a production build.
import type { Page } from '@playwright/test';
import { createRun, seedRunnableProject } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { FARMER1, seedExamplesOnce } from '../support/examples.ts';
import { expect, test } from '../support/fixtures.ts';
import { languages, words as siteWords } from '../support/lang.ts';
import { clippedText, expectNoSidewaysScroll } from '../support/reflow.ts';

const PHONE = { width: 360, height: 740 };

const LANGS = (await languages()).filter((l) => l.code !== 'en');

for (const lang of LANGS) {
	const words = await siteWords(lang.code);

	test.describe(`${lang.name} (${lang.code})`, () => {
		test.use({ viewport: PHONE });

		test.beforeEach(async ({ page }) => {
			// This device chose the language before signing in: the layout reads it without writing the account.
			await page.addInitScript((code) => localStorage.setItem('wm.locale', code), lang.code);
		});

		/** Open `path`, wait for it to be in this language and for `ready`, then check the layout in light and dark. */
		async function checkPage(page: Page, path: string, ready: (page: Page) => Promise<void>) {
			await page.goto(path);
			await expect(page.locator('html'), `the ${lang.name} catalogue is incomplete (pnpm check:i18n ${lang.code})`).toHaveAttribute('lang', lang.code);
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

		test('the signed-out pages fit a phone', async ({ page }) => {
			await checkPage(page, '/login', async (p) => {
				await expect(p.getByRole('button', { name: words('Sign in') })).toBeVisible();
			});
			await checkPage(page, '/register', heading);
			await checkPage(page, '/forgot-password', heading);
		});

		test('a farmer’s pages fit a phone', async ({ page, playwright }) => {
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
				await expect(p.getByRole('region', { name: words('Language and units') })).toBeVisible();
			});
			await checkPage(page, '/account/alerts', async (p) => {
				await expect(p.locator('main[data-ready="true"]')).toBeVisible();
			});
		});

		test('a share link fits a phone', async ({ page, owner, browser }) => {
			void owner;
			const project = await seedRunnableProject(page.request, `Lang taal share ${lang.code}`);
			const runId = await createRun(page.request, project.id, 'Baseline');
			const pub = await page.request.post(`${API_URL}/projects/${project.id}/publication`, {
				data: { runId, restriction: { level: 'advisory', pct: 10, notice: { en: 'Water is short on the river.' } } }
			});
			expect(pub.status(), await pub.text()).toBe(201);
			const made = await page.request.post(`${API_URL}/projects/${project.id}/share-links`, { data: { label: 'Neighbours', expiresInDays: 7 } });
			expect(made.status(), await made.text()).toBe(201);
			const { link } = (await made.json()) as { link: { url: string } };

			const stranger = await browser.newContext({ viewport: PHONE });
			const shared = await stranger.newPage();
			await shared.addInitScript((code) => localStorage.setItem('wm.locale', code), lang.code);
			await checkPage(shared, link.url, async (p) => {
				await expect(p.locator('main[data-share-state="ready"]')).toBeVisible();
			});
			await stranger.close();
		});
	});
}

// At 320 px (WCAG 1.4.10, issue #51) the EN | AF pair stays on one row, in
// English and every language: it stacked, and the sticky farm header grew from
// 56 to 93 px, a third of a 320 px screen and more than the scroll padding
// (--header-h) clears for a focused control.
for (const code of ['en', ...LANGS.map((l) => l.code)]) {
	test(`the headers keep one row at 320 px, ${code}`, async ({ page, playwright }) => {
		test.setTimeout(60_000);
		await page.setViewportSize({ width: 320, height: 640 });
		await page.addInitScript((c) => localStorage.setItem('wm.locale', c), code);
		/** The language pair's buttons all sit on one row. */
		const oneRow = () =>
			page.locator('.lang.compact').evaluate((el) => new Set([...el.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().top))).size);

		for (const path of ['/login', '/welcome']) {
			await page.goto(path);
			await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
			expect(await oneRow(), path).toBe(1);
			await expectNoSidewaysScroll(page);
		}

		const api = await playwright.request.newContext();
		await seedExamplesOnce(api);
		await api.dispose();
		const login = await page.request.post(`${API_URL}/auth/login`, { data: FARMER1 });
		expect(login.status(), await login.text()).toBe(200);
		const { projects } = (await (await page.request.get(`${API_URL}/projects`)).json()) as { projects: { id: string; role: string }[] };
		const projectId = projects.find((p) => p.role === 'farmer')!.id;
		for (const path of ['/farm', `/farm/${projectId}`, `/farm/${projectId}/why`, `/farm/${projectId}/dam`]) {
			await page.goto(path);
			await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
			expect(await oneRow(), path).toBe(1);
			const header = await page.locator('.farm-header').evaluate((el) => el.getBoundingClientRect().height);
			expect(header, `${path}: the header's height`).toBe(56);
			await expectNoSidewaysScroll(page);
		}
	});
}
