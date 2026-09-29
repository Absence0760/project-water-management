// Language and units (WP-2.5, docs/ui.md § Language): the EN | AF switch on
// the sign-in pages, the farm view and the account page; the choice is kept
// on the device and, signed in, on the account (PATCH /auth/me), with the
// farm view's numbers following it at once (a decimal comma in Afrikaans),
// and the WUA's own Afrikaans notice too (it is the WUA's words, not ours).
//
// The Afrikaans catalogue is complete, so choosing Afrikaans turns the words
// and <html lang> to Afrikaans (the plan's WP-2.5 e2e: the sign-in page and
// the farm view). The Afrikaans is read from the catalogue (support/lang.ts).
// The emails are covered by backend/src/auth/locale.db.test.ts and
// farms/invites.db.test.ts (e2e mail goes to the server log), and the alert
// email through Mailpit by alerts-mailpit.spec.ts.
import { readFile } from 'node:fs/promises';
import type { APIRequestContext, Page } from '@playwright/test';
import { createRun, register, seedRunnableProject } from '../support/api.ts';
import { words as siteWords } from '../support/lang.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const PHONE = { width: 360, height: 740 };
const words = await siteWords('af');

const me = async (request: APIRequestContext) => ((await (await request.get(`${API_URL}/auth/me`)).json()) as { user: { locale: string | null; volumeUnit: string } }).user;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A name in English or in its Afrikaans, for a control the test meets in both languages. */
const either = (english: string) => new RegExp(`^(${escape(english)}|${escape(words(english))})$`);
/** The EN | AF switch, whichever language the page is in. */
const switchIn = (page: Page) => page.getByRole('group', { name: either('Language') }).first();

test('the sign-in page switches to Afrikaans, words and <html lang> both, and remembers the choice on this device', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.goto('/login');
	const lang = switchIn(page);
	const af = lang.getByRole('button', { name: 'Afrikaans' });
	await expect(af).toHaveAttribute('lang', 'af');
	await expect(lang.getByRole('button', { name: 'English' })).toHaveAttribute('lang', 'en');
	await expect(af).toHaveAttribute('aria-pressed', 'false');
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	await af.click();
	await expect(af).toHaveAttribute('aria-pressed', 'true');
	await expect(page.locator('html')).toHaveAttribute('lang', 'af');
	await expect(page.getByRole('button', { name: words('Sign in'), exact: true })).toBeVisible();
	await expect(page.getByLabel(words('Password'), { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
	await page.reload();
	await expect(switchIn(page).getByRole('button', { name: 'Afrikaans' })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.locator('html')).toHaveAttribute('lang', 'af');
	await expectNoViolations(page);
	// And back.
	await switchIn(page).getByRole('button', { name: 'English' }).click();
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('a farmer’s choice of language and unit is saved to the account; the farm view turns Afrikaans, words, decimal comma and the WUA’s own Afrikaans notice', async ({ page, signIn }) => {
	await page.setViewportSize(PHONE);
	// Its own published catchment and a fresh farmer, so neither the seeded
	// farmers' preferences nor the seeded catchments' farmer lists change under
	// other specs (examples.spec.ts counts Sandspruit's farmers).
	const wua = await signIn('Taal WUA');
	const project = await seedRunnableProject(wua.page.request, 'Taal catchment');
	const runId = await createRun(wua.page.request, project.id, 'Baseline');
	// The WUA writes both notices; these stand in for its words (the app never writes restriction text).
	const notice = { en: 'English notice from the WUA, for the test.', af: '[af] Afrikaans notice from the WUA, for the test.' };
	const restriction = { level: 'advisory', pct: null, notice };
	const pub = await wua.page.request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId, restriction } });
	expect(pub.status(), await pub.text()).toBe(201);
	const farmer = await register(page.context().request, 'Taal Farmer');
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')!.id as string;
	const added = await wua.page.request.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: farmer.email, nodeIds: [upper] } });
	expect(added.status(), await added.text()).toBe(201);

	await page.goto('/farm');
	await expect(page).toHaveURL(new RegExp(`/farm/${project.id}$`));
	const projectId = project.id;
	const supply = page.getByRole('region', { name: either('Water you received this season') });
	await supply.getByRole('button', { name: 'ML' }).click();
	await expect(supply.getByRole('button', { name: 'ML' })).toHaveAttribute('aria-pressed', 'true');
	await expect.poll(async () => (await me(page.request)).volumeUnit).toBe('ML');

	// English first.
	const card = page.locator('#notice');
	await expect(card.getByText(notice.en)).toBeVisible();

	const numbers = page.getByRole('region', { name: either('Last 12 months, in ML') });
	await numbers.getByText('Show the numbers', { exact: true }).click();
	const table = numbers.getByRole('table');
	await expect(table).toContainText(/\d\.\d\sML/);

	await switchIn(page).getByRole('button', { name: 'Afrikaans' }).click();
	await expect(table).toContainText(/\d,\d\sML/);
	await expect(table).not.toContainText(/\d\.\d\sML/);
	await expect.poll(async () => (await me(page.request)).locale).toBe('af');
	// The catalogue is complete: the page's own words are Afrikaans, and it says so.
	await expect(page.locator('html')).toHaveAttribute('lang', 'af');
	await expect(page.getByRole('heading', { level: 2, name: words('Water you received this season') })).toBeVisible();
	await expect(numbers.getByText(words('Show the numbers'), { exact: true })).toBeVisible();
	// The WUA's Afrikaans follows the choice at once; on an Afrikaans page it needs no lang of its own.
	await expect(card.getByText(notice.af)).toBeVisible();
	await expect(card.getByText(notice.af)).not.toHaveAttribute('lang', /./);
	await expect(card).not.toContainText(notice.en);
	// No "written only in …" line: the notice is in the reader's language.
	await expect(card).not.toContainText(words('The WUA wrote this notice in {language} only.').split('{language}')[0]!);
	await expectNoViolations(page);

	// The figures' CSV in Afrikaans (issue #124): the column names in the catalogue's words, and `;` between
	// cells with a decimal comma, so Excel in af-ZA opens it in columns; whole m³, so no decimals at all.
	const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: words('Download my figures (CSV)') }).click()]);
	const lines = (await readFile((await csv.path())!, 'utf8')).replace(/^\uFEFF/, '').split('\r\n');
	expect(lines[0]!.startsWith('# ')).toBe(true);
	expect(lines[1]!.split(';').slice(0, 3)).toEqual([words('Date'), words('Water you needed (m³/day)'), words('Water you received (m³/day)')]);
	expect(lines[2]).toMatch(/^\d{4}-\d{2}-\d{2}(;-?\d*)+$/);

	// From the account now, not just this device: a fresh browser signed in as the farmer starts in Afrikaans and ML.
	await page.context().clearCookies();
	await page.evaluate(() => localStorage.clear());
	await page.goto('/login');
	await page.getByLabel('Email').fill(farmer.email);
	await page.getByLabel('Password').fill(farmer.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(new RegExp(`/farm/${projectId}$`));
	await expect(switchIn(page).getByRole('button', { name: 'Afrikaans' })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.locator('html')).toHaveAttribute('lang', 'af');
	await expect(page.getByRole('region', { name: words('Water you received this season') }).getByRole('button', { name: 'ML' })).toHaveAttribute('aria-pressed', 'true');
});

test('the account page sets the language and the farm view’s volume unit', async ({ page, owner }) => {
	await page.goto('/account');
	await expect(page.getByRole('region', { name: 'Account', exact: true })).toContainText(owner.email);
	const prefs = page.getByRole('region', { name: either('Language and units') });
	await expect(prefs).toBeVisible();
	await prefs.getByRole('button', { name: 'Afrikaans' }).click();
	await expect(prefs.getByRole('button', { name: 'Afrikaans' })).toHaveAttribute('aria-pressed', 'true');
	await expect.poll(async () => (await me(page.request)).locale).toBe('af');
	// The account page is a translated page: it turns Afrikaans at once.
	await expect(page.locator('html')).toHaveAttribute('lang', 'af');
	await expect(page.getByRole('region', { name: words('Language and units') })).toBeVisible();

	await expect(prefs.getByLabel(words('Cubic metres (m³)'))).toBeChecked();
	await prefs.getByLabel(words('Megalitres (ML)')).check();
	await expect(prefs.getByRole('status').filter({ hasText: words('Saved.') })).toBeVisible();
	expect((await me(page.request)).volumeUnit).toBe('ML');

	await page.reload();
	await expect(prefs.getByRole('button', { name: 'Afrikaans' })).toHaveAttribute('aria-pressed', 'true');
	await expect(prefs.getByLabel(words('Megalitres (ML)'))).toBeChecked();
	await expectNoViolations(page);
});
