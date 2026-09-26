// Language and units (WP-2.5, docs/ui.md § Language): the EN | AF switch on
// the sign-in pages, the farm view and the account page; the choice is kept
// on the device and, signed in, on the account (PATCH /auth/me), with the
// farm view's numbers following it at once (a decimal comma in Afrikaans),
// and the WUA's own Afrikaans notice too (it is the WUA's words, not ours).
//
// No Afrikaans wording is reviewed yet (docs/i18n/af-translation-sheet.md),
// so the words stay English and <html lang> stays "en": the page never claims
// to be Afrikaans while its words are English. The emails are covered by
// backend/src/auth/locale.db.test.ts (e2e mail goes to the server log).
import type { APIRequestContext, Page } from '@playwright/test';
import { createRun, register, seedRunnableProject } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const PHONE = { width: 360, height: 740 };

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

test('a farmer’s choice of language and unit is saved to the account; the farm view writes a decimal comma, and the WUA’s own Afrikaans notice', async ({ page, signIn }) => {
	await page.setViewportSize(PHONE);
	// Its own published catchment and a fresh farmer, so neither the seeded
	// farmers' preferences nor the seeded catchments' farmer lists change under
	// other specs (examples.spec.ts counts Sandspruit's farmers).
	const wua = await signIn('Taal WUA');
	const project = await seedRunnableProject(wua.page.request, 'Taal catchment');
	const runId = await createRun(wua.page.request, project.id, 'Baseline');
	// The WUA writes both notices; these stand in for its words (the app never writes restriction text).
	const restriction = { level: 'advisory', pct: null, noticeEn: 'English notice from the WUA, for the test.', noticeAf: '[af] Afrikaans notice from the WUA, for the test.' };
	const pub = await wua.page.request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId, restriction } });
	expect(pub.status(), await pub.text()).toBe(201);
	const farmer = await register(page.context().request, 'Taal Farmer');
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')!.id as string;
	const added = await wua.page.request.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: farmer.email, nodeIds: [upper] } });
	expect(added.status(), await added.text()).toBe(201);

	await page.goto('/farm');
	await expect(page).toHaveURL(new RegExp(`/farm/${project.id}$`));
	const projectId = project.id;
	const supply = page.getByRole('region', { name: 'Water you received this season' });
	await supply.getByRole('button', { name: 'ML' }).click();
	await expect(supply.getByRole('button', { name: 'ML' })).toHaveAttribute('aria-pressed', 'true');
	await expect.poll(async () => (await me(page.request)).volumeUnit).toBe('ML');

	// English first.
	const notice = page.locator('#notice');
	await expect(notice.getByText(restriction.noticeEn)).toBeVisible();

	const numbers = page.getByRole('region', { name: 'Last 12 months, in ML' });
	await numbers.getByText('Show the numbers', { exact: true }).click();
	const table = numbers.getByRole('table');
	await expect(table).toContainText(/\d\.\d\sML/);

	await switchIn(page).getByRole('button', { name: 'Afrikaans' }).click();
	await expect(table).toContainText(/\d,\d\sML/);
	await expect(table).not.toContainText(/\d\.\d\sML/);
	await expect.poll(async () => (await me(page.request)).locale).toBe('af');
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	// The WUA's Afrikaans is real, so it follows the choice at once, marked as Afrikaans on the English page.
	await expect(notice.getByText(restriction.noticeAf)).toHaveAttribute('lang', 'af');
	await expect(notice).not.toContainText(restriction.noticeEn);
	await expect(notice).not.toContainText('only.');

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
