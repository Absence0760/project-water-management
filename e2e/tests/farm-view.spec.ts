// The phone-first farmer view (WP-2.6, docs/design/farmer-view.md) as the
// seeded farmers see it: farmer1@ is linked to Vaalbank on Sandspruit, whose
// run `seed:examples` publishes with an advisory notice (WP-2.3); farmer2@ is
// linked to Rietspruit (Sandspruit) and Kareebos (Droëvlei).
//
// The figures are the synthetic Sandspruit example's (docs/design/farmer-view.md
// §3). Needs the farm API (GET /projects/:id/farm…, WP-2.3/2.6) and the seeded
// publication.
import type { BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../support/env.ts';
import { ANALYST, FARMER1, FARMER2, seedExamplesOnce } from '../support/examples.ts';
import { expect, test } from '../support/fixtures.ts';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }) => {
	test.setTimeout(90_000);
	const api = await playwright.request.newContext();
	await seedExamplesOnce(api);
	await api.dispose();
});

const PHONE = { width: 360, height: 740 };
const DESKTOP = { width: 1280, height: 800 };

async function signIn(page: Page, who: { email: string; password: string }) {
	await page.goto('/login');
	await page.getByLabel('Email').fill(who.email);
	await page.getByLabel('Password').fill(who.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	// Signed in once the app has moved off the sign-in page (the session cookie is set by then).
	await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

/** The farmer's one project (their catchment) and farm, from the API as they see it. */
async function farmOf(context: BrowserContext) {
	const { projects } = (await (await context.request.get(`${API_URL}/projects`)).json()) as { projects: { id: string; name: string; role: string }[] };
	const project = projects.find((p) => p.role === 'farmer')!;
	const index = (await (await context.request.get(`${API_URL}/projects/${project.id}/farm`)).json()) as {
		farms: { nodeId: string; name: string }[];
		publication: unknown;
	};
	return { projectId: project.id, index };
}

async function expectNoSidewaysScroll(page: Page) {
	const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
	expect(scroll).toBeLessThanOrEqual(inner);
}

test('a farmer with one farm lands on it: the notice first, then their water and dam', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await signIn(page, FARMER1);
	const { projectId } = await farmOf(page.context());
	await expect(page).toHaveURL(new RegExp(`/farm/${projectId}$`));
	await expect(page.getByRole('heading', { level: 1, name: /^Vaalbank/ })).toBeVisible();
	await expect(page.getByText(/^Published by the WUA on \d{1,2} \w{3} \d{4}\. Data up to \d{1,2} \w{3} \d{4}/)).toBeVisible();

	// The WUA's answer comes first, in its own words, marked as a notice.
	const regions = page.getByRole('main').getByRole('region');
	await expect(regions.first()).toContainText('Notice from the WUA · Advisory');
	const supply = page.getByRole('region', { name: 'Water you received this season' });
	await expect(supply).toContainText('86 %');
	await expect(supply).toContainText('of what you needed');
	await expect(page.getByRole('region', { name: 'Your dam' })).toContainText(/\d+ % full/);
	await expect(page.getByRole('region', { name: /^Looking back/ })).toContainText('Model:');

	// The unit switch rewrites the volumes and is remembered on the phone.
	await supply.getByRole('button', { name: 'ML' }).click();
	await expect(supply).toContainText(/ ML of [\d.\s]+ ML since 1 Oct/);
	await page.reload();
	await expect(page.getByRole('region', { name: 'Water you received this season' }).getByRole('button', { name: 'ML' })).toHaveAttribute('aria-pressed', 'true');

	// Why? and the dam page, and back.
	await page.getByRole('link', { name: /^Why .*What can I do\?$/ }).click();
	await expect(page.getByRole('heading', { level: 1, name: /^Why about \d+ %\?$/ })).toBeVisible();
	for (const h of ['1. Was water shared fairly?', '2. Did the river keep flowing?', 'What the WUA decided', 'What this is not']) {
		await expect(page.getByRole('heading', { level: 2, name: h })).toBeVisible();
	}
	await page.getByRole('link', { name: 'My farm' }).click();
	await page.getByRole('link', { name: 'Dam details' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Your dam' })).toBeVisible();
	await expect(page.getByRole('heading', { level: 2, name: 'Where these figures come from' })).toBeVisible();
	await page.getByText('Show the numbers', { exact: true }).click();
	await expect(page.getByRole('table')).toContainText('Dam full');
});

test('no page scrolls sideways at 360 px or on a desktop, in light and dark', async ({ page }) => {
	await signIn(page, FARMER1);
	const { projectId } = await farmOf(page.context());
	await expect(page).toHaveURL(new RegExp(`/farm/${projectId}$`));
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		for (const size of [PHONE, DESKTOP]) {
			await page.setViewportSize(size);
			for (const path of ['', '/why', '/dam']) {
				await page.goto(`/farm/${projectId}${path}`);
				await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
				await expectNoSidewaysScroll(page);
			}
		}
	}
});

test('the workspace URL sends a farmer to their farm view', async ({ page }) => {
	await signIn(page, FARMER1);
	const { projectId } = await farmOf(page.context());
	await expect(page).toHaveURL(new RegExp(`/farm/${projectId}$`));
	await page.goto(`/projects/${projectId}?tab=network`);
	await expect(page).toHaveURL(new RegExp(`/farm/${projectId}$`));
	await expect(page.getByRole('heading', { level: 1, name: /^Vaalbank/ })).toBeVisible();
});

test('a dropped signal keeps the saved figures on screen under the offline strip', async ({ page, context }) => {
	await page.setViewportSize(PHONE);
	await signIn(page, FARMER1);
	await expect(page.getByRole('region', { name: 'Water you received this season' })).toContainText('86 %');
	await context.setOffline(true);
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await expect(page.getByRole('status').filter({ hasText: /^No signal\. These are the figures saved on this phone at/ })).toBeVisible();
	await expect(page.getByRole('region', { name: 'At a glance' })).toContainText('86 %');
	await expect(page.getByText('Charts, “Why?” and downloads need a connection.')).toBeVisible();
	await context.setOffline(false);
});

test('WUA staff preview a farm as its farmer sees it, under a banner', async ({ page, browser }) => {
	const farmerContext = await browser.newContext();
	const farmer = await farmerContext.newPage();
	await signIn(farmer, FARMER1);
	const { projectId, index } = await farmOf(farmerContext);
	await farmerContext.close();

	await signIn(page, ANALYST);
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	await page.goto(`/farm/${projectId}?node=${index.farms[0]!.nodeId}`);
	await expect(page.getByRole('note').filter({ hasText: /^You’re previewing Vaalbank.* as its farmer sees it/ })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Back to the workspace' })).toBeVisible();
});

test.describe('a farmer with farms in two catchments', () => {
	test('lists them, and a catchment with nothing published says so', async ({ page }) => {
		await page.setViewportSize(PHONE);
		await signIn(page, FARMER2);
		await expect(page).toHaveURL(/\/farm$/);
		await expect(page.getByRole('heading', { level: 1, name: 'Your farms' })).toBeVisible();
		const rietspruit = page.getByRole('link', { name: /Rietspruit/ });
		const kareebos = page.getByRole('link', { name: /Kareebos/ });
		await expect(rietspruit).toContainText('% of water needed');
		// Only the Sandspruit run is published by the seed; Droëvlei has nothing yet.
		await expect(kareebos).toContainText('Not published yet');
		await kareebos.click();
		await expect(page.getByRole('heading', { level: 2, name: 'Your WUA hasn’t published figures yet' })).toBeVisible();
		await expectNoSidewaysScroll(page);
	});
});
