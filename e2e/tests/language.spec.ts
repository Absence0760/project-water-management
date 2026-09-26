// Language and units (WP-2.5, docs/ui.md § Language): the EN | AF switch on
// the sign-in pages, the farm view and the account page; the choice is kept
// on the device and, signed in, on the account (PATCH /auth/me), with the
// farm view's numbers following it at once (a decimal comma in Afrikaans).
//
// No Afrikaans wording is reviewed yet (docs/i18n/af-translation-sheet.md),
// so the words stay English and <html lang> stays "en": the page never claims
// to be Afrikaans while its words are English. The emails are covered by
// backend/src/auth/locale.db.test.ts (e2e mail goes to the server log).
import type { APIRequestContext, Page } from '@playwright/test';
import { register } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { ANALYST, FARMER1, seedExamplesOnce } from '../support/examples.ts';
import { expect, test } from '../support/fixtures.ts';

const PHONE = { width: 360, height: 740 };

test.beforeAll(async ({ playwright }) => {
	test.setTimeout(90_000);
	const api = await playwright.request.newContext();
	await seedExamplesOnce(api);
	await api.dispose();
});

const me = async (request: APIRequestContext) => ((await (await request.get(`${API_URL}/auth/me`)).json()) as { user: { locale: string | null; volumeUnit: string } }).user;
const switchIn = (page: Page) => page.getByRole('group', { name: 'Language' }).first();

test('the sign-in page switches language, marks each option with its own lang, and remembers the choice on this device', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.goto('/login');
	const lang = switchIn(page);
	const af = lang.getByRole('button', { name: 'Afrikaans' });
	await expect(af).toHaveAttribute('lang', 'af');
	await expect(lang.getByRole('button', { name: 'English' })).toHaveAttribute('lang', 'en');
	await expect(af).toHaveAttribute('aria-pressed', 'false');
	await af.click();
	await expect(af).toHaveAttribute('aria-pressed', 'true');
	// Every word is still English until the reviewed Afrikaans lands, so the page says so.
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	await page.reload();
	await expect(switchIn(page).getByRole('button', { name: 'Afrikaans' })).toHaveAttribute('aria-pressed', 'true');
	await expectNoViolations(page);
});

test('a farmer’s choice of language and unit is saved to the account, and the farm view writes a decimal comma in Afrikaans', async ({ page, playwright }) => {
	await page.setViewportSize(PHONE);
	// A fresh farmer on Vaalbank, so the seeded farmers' own preferences stay as they are for other specs.
	const farmer = await register(page.context().request, 'Taal Farmer');
	const staff = await playwright.request.newContext();
	expect((await staff.post(`${API_URL}/auth/login`, { data: FARMER1 })).ok()).toBe(true);
	const { projects } = (await (await staff.get(`${API_URL}/projects`)).json()) as { projects: { id: string; role: string }[] };
	const projectId = projects.find((p) => p.role === 'farmer')!.id;
	const { farms } = (await (await staff.get(`${API_URL}/projects/${projectId}/farm`)).json()) as { farms: { nodeId: string }[] };
	expect((await staff.post(`${API_URL}/auth/login`, { data: ANALYST })).ok()).toBe(true);
	const added = await staff.post(`${API_URL}/projects/${projectId}/farmers`, { data: { email: farmer.email, nodeIds: [farms[0]!.nodeId] } });
	expect(added.status(), await added.text()).toBe(201);
	await staff.dispose();

	await page.goto('/farm');
	await expect(page).toHaveURL(new RegExp(`/farm/${projectId}$`));
	const supply = page.getByRole('region', { name: 'Water you received this season' });
	await supply.getByRole('button', { name: 'ML' }).click();
	await expect(supply.getByRole('button', { name: 'ML' })).toHaveAttribute('aria-pressed', 'true');
	await expect.poll(async () => (await me(page.request)).volumeUnit).toBe('ML');

	const numbers = page.getByRole('region', { name: 'Last 12 months, in ML' });
	await numbers.getByText('Show the numbers', { exact: true }).click();
	const table = numbers.getByRole('table');
	await expect(table).toContainText(/\d\.\d\sML/);

	await switchIn(page).getByRole('button', { name: 'Afrikaans' }).click();
	await expect(table).toContainText(/\d,\d\sML/);
	await expect(table).not.toContainText(/\d\.\d\sML/);
	await expect.poll(async () => (await me(page.request)).locale).toBe('af');
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');

	// From the account now, not just this device: a fresh browser signed in as the farmer starts in Afrikaans and ML.
	await page.context().clearCookies();
	await page.evaluate(() => localStorage.clear());
	await page.goto('/login');
	await page.getByLabel('Email').fill(farmer.email);
	await page.getByLabel('Password').fill(farmer.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(new RegExp(`/farm/${projectId}$`));
	await expect(switchIn(page).getByRole('button', { name: 'Afrikaans' })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByRole('region', { name: 'Water you received this season' }).getByRole('button', { name: 'ML' })).toHaveAttribute('aria-pressed', 'true');
});

test('the account page sets the language and the farm view’s volume unit', async ({ page, owner }) => {
	await page.goto('/account');
	await expect(page.getByRole('region', { name: 'Profile' })).toContainText(owner.email);
	const prefs = page.getByRole('region', { name: 'Language and units' });
	await expect(prefs).toBeVisible();
	await prefs.getByRole('button', { name: 'Afrikaans' }).click();
	await expect(prefs.getByRole('button', { name: 'Afrikaans' })).toHaveAttribute('aria-pressed', 'true');
	await expect.poll(async () => (await me(page.request)).locale).toBe('af');

	await expect(prefs.getByLabel('Cubic metres (m³)')).toBeChecked();
	await prefs.getByLabel('Megalitres (ML)').check();
	await expect(prefs.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
	expect((await me(page.request)).volumeUnit).toBe('ML');

	await page.reload();
	await expect(page.getByRole('region', { name: 'Language and units' }).getByRole('button', { name: 'Afrikaans' })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByRole('region', { name: 'Language and units' }).getByLabel('Megalitres (ML)')).toBeChecked();
	await expectNoViolations(page);
});
