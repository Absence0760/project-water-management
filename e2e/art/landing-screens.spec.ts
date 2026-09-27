// Captures the app screens the landing page shows (issue #57): a catchment's
// Summary, its Network and River & reserve at 1440 × 900 as the demo
// hydrologist, and the farm view on a 390 × 844 phone as the demo farmer, in
// light and dark. Invented example catchments only (`pnpm seed:examples`),
// never client data. bin/gen-landing-art.sh frames and converts them.
import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { DEMO, FARMER1, KLEINBERG, seedExamplesOnce } from '../support/examples.ts';
import { expect, test } from '../support/fixtures.ts';

const out = process.env.LANDING_SHOTS_DIR;
test.skip(!out, 'LANDING_SHOTS_DIR is set by bin/gen-landing-art.sh');

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ playwright }) => {
	test.setTimeout(120_000);
	mkdirSync(out!, { recursive: true });
	const api = await playwright.request.newContext();
	await seedExamplesOnce(api);
	await api.dispose();
});

async function signInAs(page: Page, who: { email: string; password: string }) {
	await page.goto('/login');
	await page.getByLabel('Email').fill(who.email);
	await page.getByLabel('Password').fill(who.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).not.toHaveURL(/\/login/);
}

/** The page settled: fonts in, nothing still loading, the pointer out of the way. */
async function settled(page: Page) {
	await page.evaluate(() => document.fonts.ready);
	await expect(page.getByText('Loading…')).toHaveCount(0);
	await page.mouse.move(0, 0);
}

for (const scheme of ['light', 'dark'] as const) {
	test(`the hydrologist's screens, ${scheme}`, async ({ page }) => {
		test.setTimeout(90_000);
		await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
		await page.setViewportSize({ width: 1440, height: 900 });
		await signInAs(page, DEMO);
		await page.locator('table.projects').getByRole('link', { name: KLEINBERG, exact: true }).click();
		await expect(page.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible();
		const project = page.url();

		await settled(page);
		await page.screenshot({ path: `${out}/summary-${scheme}.png` });

		await page.goto(`${project}?tab=network`);
		await expect(page.getByRole('heading', { level: 1, name: 'Network' })).toBeVisible();
		await settled(page);
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.screenshot({ path: `${out}/network-${scheme}.png` });

		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto(`${project}?tab=river`);
		await expect(page.getByRole('heading', { level: 1, name: 'River & reserve' })).toBeVisible();
		await expect(page.locator('.uplot').first()).toBeVisible();
		await settled(page);
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.screenshot({ path: `${out}/river-${scheme}.png` });
	});

	test(`the farmer's phone, ${scheme}`, async ({ page }) => {
		await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
		await page.setViewportSize({ width: 390, height: 844 });
		await signInAs(page, FARMER1);
		await expect(page).toHaveURL(/\/farm\//);
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		await settled(page);
		await page.screenshot({ path: `${out}/farm-${scheme}.png` });
	});
}
