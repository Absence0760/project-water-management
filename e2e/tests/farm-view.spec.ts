// The phone-first farmer view (WP-2.6, docs/design/farmer-view.md) as the
// seeded farmers see it: farmer1@ is linked to Vaalbank on Sandspruit, whose
// run `seed:examples` publishes with an advisory notice (WP-2.3); farmer2@ is
// linked to Rietspruit (Sandspruit) and Kareebos (Droëvlei).
//
// The seed publishes every example's run, whose record ends on 31 Dec 2024, so
// the figures are real engine output for that season and already stale; the
// tests assert shapes and order, not the design doc's Vaalbank numbers (those
// pin the wording in the unit tests, lib/components/farm/*.test.ts).
import { readFile } from 'node:fs/promises';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { API_URL } from '../support/env.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { addAllocation } from '../support/allocations.ts';
import { acceptInvites, createProject, createRun, putModel, putSeries, register, sampleModel, seedRunnableProject, syntheticFlow, syntheticRain, updateSettings } from '../support/api.ts';
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

/** `a` comes before `b` in the document. */
async function expectBefore(a: Locator, b: Locator) {
	const handle = await b.elementHandle();
	expect(await a.evaluate((x, y) => !!(x.compareDocumentPosition(y!) & Node.DOCUMENT_POSITION_FOLLOWING), handle)).toBe(true);
}

/** The estimate line (EstimateNote): before the first figure on every farm page. */
const estimateNote = (page: Page) => page.getByRole('note').filter({ hasText: /These figures are worked out by a computer model of the catchment\./ });

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
	// en-ZA dates ("26 Sept 2026", Intl may join them with non-breaking spaces); the seeded record ends in 2024, so the dates line also says how old it is.
	const dates = page.getByText(/^Published by the WUA on /);
	await expect(dates).toHaveText(/^Published\sby\sthe\sWUA\son\s\d{1,2}\s\w{3,4}\s\d{4}\.\sData\sup\sto\s31\sDec\s2024\s\(\d+\s(months|years)\sago\)\./);

	// The WUA's answer comes first, in its own words, marked as a notice.
	const regions = page.getByRole('main').getByRole('region');
	await expect(regions.first()).toContainText('Notice from the WUA · Advisory');
	const supply = page.getByRole('region', { name: 'Water you received this season' });
	await expect(supply).toContainText(/this season\s*\d{1,3}\s%\s*of what you needed/);
	await expect(supply).toContainText(/all when your dam was down to its stop level/);
	// Stale figures: the 30 days are named by their last day, not "Last 30 days" (issue #162).
	await expect(supply).toContainText(/30\sdays\sto\s31\sDec\s2024:/);
	await expect(page.getByRole('region', { name: 'Your dam' })).toContainText(/\d+\s%\s*full/);
	await expect(page.getByRole('region', { name: /^Looking back/ })).toContainText('Model:');

	// Who can see my hydrological unit: the people by name and what they can do, never an email.
	await page.getByRole('button', { name: 'Who can see my hydrological unit' }).click();
	const who = page.locator('#who-can-see');
	await expect(who).toContainText('Demo Farmer (you) · linked to this hydrological unit');
	await expect(who).toContainText('Demo Analyst · WUA, manages who has access');
	await expect(who).not.toContainText('@example.com');

	// The unit switch rewrites the volumes and is saved to the account (WP-2.5), so it survives a reload.
	await supply.getByRole('button', { name: 'ML' }).click();
	await expect(supply).toContainText(/\d[\d.]*\sML\sof\s[\d.]+\sML\ssince 1 Oct/);
	await expect.poll(async () => ((await (await page.request.get(`${API_URL}/auth/me`)).json()) as { user: { volumeUnit: string } }).user.volumeUnit).toBe('ML');
	await page.reload();
	const supplyAgain = page.getByRole('region', { name: 'Water you received this season' });
	await expect(supplyAgain.getByRole('button', { name: 'ML' })).toHaveAttribute('aria-pressed', 'true');
	// The 12-month table follows the chosen unit too (issue #51); the chart's axis stays in ML.
	const months = page.getByRole('region', { name: 'Last 12 months, in ML' });
	await months.getByText('Show the numbers', { exact: true }).click();
	const monthsTable = months.getByRole('table');
	await expect(monthsTable).toContainText(/\sML/);
	await expect(monthsTable).not.toContainText('m³');
	// Under each month's received water, its share of the need and how short it was in words (issue #70), in
	// the Received column (three columns fit a 320 px phone), and what the words mean.
	await expect(monthsTable.getByRole('columnheader')).toHaveText(['Month', 'Needed', 'Received']);
	await expect(monthsTable).toContainText(/\d+\s% · (all or nearly all|a little short|short|very short|far too little)/);
	await expect(months).toContainText('All or nearly all is 95 % or more of what you needed;');
	// Back to m³, the seeded farmer's default, for the other specs.
	await supplyAgain.getByRole('button', { name: 'm³' }).click();
	await expect(monthsTable).toContainText(/\sm³/);
	await expect(monthsTable).not.toContainText('ML');
	await expect.poll(async () => ((await (await page.request.get(`${API_URL}/auth/me`)).json()) as { user: { volumeUnit: string } }).user.volumeUnit).toBe('m3');

	// The figures' CSV leads with the page's disclaimer line (docs/legal/disclaimer-review.md § 3), then the table:
	// plain column names in the reader's language, whole m³, the last year (issue #124).
	const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download my figures (CSV)' }).click()]);
	const lines = (await readFile((await csv.path())!, 'utf8')).replace(/^\uFEFF/, '').split('\r\n');
	expect(lines[0]).toBe('# These figures are worked out by a computer model of the catchment. They are estimates, not measurements or instructions, and they can be wrong. Only a notice from your WUA or from the Department of Water and Sanitation (DWS) is a restriction.');
	expect(lines[1]).toBe(
		'Date,Water you needed (m³/day),Water you received (m³/day),Water you were short (m³/day),Water in your dam (m³),Water that spilled from your dam (m³/day),Water transferred in (+) or out (−) (m³/day)'
	);
	const days = lines.slice(2).filter(Boolean);
	expect(days.length).toBeGreaterThan(0);
	expect(days.length).toBeLessThanOrEqual(365);
	for (const d of days) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}(,-?\d*)+$/);

	// Why? and the dam page, and back.
	await page.getByRole('link', { name: /^Why .*What can I do\?$/ }).click();
	await expect(page.getByRole('heading', { level: 1, name: /^Why about \d+\s%\?$/ })).toBeVisible();
	for (const h of ['1. Was water shared fairly?', '2. Did the river keep flowing?', 'What the WUA decided', 'What this is not']) {
		await expect(page.getByRole('heading', { level: 2, name: h })).toBeVisible();
	}
	await page.getByRole('link', { name: 'My hydrological unit' }).click();
	await page.getByRole('link', { name: 'Dam details' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Your dam' })).toBeVisible();
	await expect(page.getByRole('heading', { level: 2, name: 'Where these figures come from' })).toBeVisible();
	// The chart names what it draws under its heading; its caption gives the months and the dashed line.
	const yearChart = page.getByRole('region', { name: 'Last 12 months' });
	await expect(yearChart.getByTestId('dam-chart-what')).toHaveText('Dam level at the end of each month');
	await expect(yearChart).toContainText(/\w{3} \d{4} to \w{3} \d{4}, end of each month\./);
	await page.getByText('Show the numbers', { exact: true }).click();
	await expect(page.getByRole('table')).toContainText('Dam full');
});

// "Before you look at your farm" (CPA s49 research R2, ui.md § Farmer view):
// a farmer who hasn't pressed "I understand" meets the notice, not their
// figures, on every farm page; pressing it records the version on the
// account and shows the figures, with the estimate line (R1) before the
// first of them. Its own catchment and a fresh farmer, so the seeded
// farmers' acknowledgement stays as the other specs expect.
test('a farmer sees “Before you look at your farm” first; after I understand, the estimate line precedes every figure', async ({ page, signIn: signInAs }) => {
	await page.setViewportSize(PHONE);
	const wua = await signInAs('Notice WUA');
	const project = await seedRunnableProject(wua.page.request, 'Notice catchment');
	const runId = await createRun(wua.page.request, project.id, 'Baseline');
	expect((await wua.page.request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId } })).status()).toBe(201);
	const farmer = await register(page.context().request, 'Notice Farmer', { farmNotice: false });
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')!.id as string;
	expect((await wua.page.request.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: farmer.email, nodeIds: [upper] } })).status()).toBe(201);
	await acceptInvites(farmer.email, project.id);
	const current = async () => ((await (await page.request.get(`${API_URL}/auth/me`)).json()) as { user: { farmNoticeCurrent: boolean } }).user.farmNoticeCurrent;

	const title = page.getByRole('heading', { level: 1, name: 'Before you look at your farm' });
	const supply = page.getByRole('region', { name: 'Water you received this season' });
	// Every farm page shows the notice in place of the figures.
	for (const path of ['/dam', '/why', '']) {
		await page.goto(`/farm/${project.id}${path}`);
		await expect(title).toBeVisible();
		await expect(page.getByText(/\d\s%/)).toHaveCount(0);
	}
	await expect(supply).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Terms of use' })).toHaveAttribute('href', /\/terms#liability$/);
	await expectNoViolations(page);
	expect(await current()).toBe(false);

	await page.getByRole('button', { name: 'I understand' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Upper farm' })).toBeVisible();
	await expect(title).toHaveCount(0);
	// The button went with the notice: focus lands on the farm's title, not <body> (WCAG 2.4.3, issue #51).
	await expect(page.getByRole('heading', { level: 1, name: 'Upper farm' })).toBeFocused();
	expect(await current()).toBe(true);
	// Main page: the WUA's notice, then the estimate line, then the first figure card.
	await expect(estimateNote(page)).toBeVisible();
	await expectBefore(page.locator('#notice'), estimateNote(page));
	await expectBefore(estimateNote(page), supply);
	await expect(page.getByRole('main').getByRole('region').first()).toHaveAttribute('id', 'notice');
	await expectNoViolations(page);
	// Recorded on the account: a reload goes straight to the figures.
	await page.reload();
	await expect(supply).toBeVisible();
	await expect(title).toHaveCount(0);

	// The dam and Why? pages: the line right after the header, before any card.
	for (const path of ['/dam', '/why']) {
		await page.goto(`/farm/${project.id}${path}`);
		await expect(estimateNote(page)).toBeVisible();
		await expectBefore(page.getByRole('heading', { level: 1 }), estimateNote(page));
		await expectBefore(estimateNote(page), page.getByRole('main').locator('section').first());
	}
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
	const supply = page.getByRole('region', { name: 'Water you received this season' });
	await expect(supply).toContainText(/\d{1,3}\s%\s*of what you needed/);
	const pct = (await supply.textContent())!.match(/(\d{1,3})\s%\s*of what you needed/)![1]!;
	await context.setOffline(true);
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await expect(page.getByRole('status').filter({ hasText: /No signal\.\sThese are the figures saved on this phone at/ })).toBeVisible();
	await expect(page.getByRole('region', { name: 'At a glance' })).toContainText(new RegExp(`\\b${pct}\\s%`));
	await expect(page.getByText('Charts, “Why?” and downloads need a connection.')).toBeVisible();
	// The estimate line here too: after the WUA's notice, before "At a glance".
	await expectBefore(page.getByRole('region', { name: /^WUA notice · / }), estimateNote(page));
	await expectBefore(estimateNote(page), page.getByRole('region', { name: 'At a glance' }));

	// Try again's focus ring stands out from the strip (WCAG 1.4.11 / 2.4.7, issue #51): the strip
	// swaps the page's colours, so the page's --focus was 1.67:1 on it in dark mode.
	const retry = page.getByRole('button', { name: 'Try again' });
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await retry.focus();
		await page.keyboard.press('Shift+Tab');
		await page.keyboard.press('Tab');
		await expect(retry).toBeFocused();
		const ratio = await retry.evaluate((el) => {
			const rgb = (c: string) => c.match(/[\d.]+/g)!.slice(0, 3).map(Number);
			const lum = ([r, g, b]: number[]) => {
				const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
				return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
			};
			const ring = getComputedStyle(el);
			const ground = getComputedStyle(el.closest('.strip')!).backgroundColor;
			if (ring.outlineStyle === 'none' || Number.parseFloat(ring.outlineWidth) < 2) return 0;
			const [a, b] = [lum(rgb(ring.outlineColor)), lum(rgb(ground))];
			return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
		});
		expect(ratio, `${scheme}: focus ring against the strip`).toBeGreaterThanOrEqual(3);
	}
	await page.emulateMedia({ colorScheme: 'light' });
	await context.setOffline(false);
});

// "I understand" without a signal (issue #74): the press is kept on the
// phone and the figures show; back online, the page sends it and the
// account records it. Its own farmer, as the notice spec above.
test('“I understand” pressed without a signal shows the figures and is recorded once the signal is back', async ({ page, context, signIn: signInAs }) => {
	await page.setViewportSize(PHONE);
	const wua = await signInAs('Offline notice WUA');
	const project = await seedRunnableProject(wua.page.request, 'Offline notice catchment');
	const runId = await createRun(wua.page.request, project.id, 'Baseline');
	expect((await wua.page.request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId } })).status()).toBe(201);
	const farmer = await register(page.context().request, 'Offline Notice Farmer', { farmNotice: false });
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')!.id as string;
	expect((await wua.page.request.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: farmer.email, nodeIds: [upper] } })).status()).toBe(201);
	await acceptInvites(farmer.email, project.id);
	const current = async () => ((await (await page.request.get(`${API_URL}/auth/me`)).json()) as { user: { farmNoticeCurrent: boolean } }).user.farmNoticeCurrent;

	await page.goto(`/farm/${project.id}`);
	const title = page.getByRole('heading', { level: 1, name: 'Before you look at your farm' });
	await expect(title).toBeVisible();

	await context.setOffline(true);
	await page.getByRole('button', { name: 'I understand' }).click();
	await expect(title).toHaveCount(0);
	await expect(page.getByRole('heading', { level: 1, name: 'Upper farm' })).toBeVisible();
	await expect(estimateNote(page)).toBeVisible();

	// Back online: the page sends the kept press, and the account has it.
	const sent = page.waitForResponse((r) => r.url().endsWith('/auth/me/farm-notice') && r.request().method() === 'POST');
	await context.setOffline(false);
	expect((await sent).status()).toBe(200);
	expect(await current()).toBe(true);
	await page.reload();
	await expect(page.getByRole('region', { name: 'Water you received this season' })).toBeVisible();
	await expect(title).toHaveCount(0);
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

test('a farmer with farms in two catchments sees them listed, each with its figures', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await signIn(page, FARMER2);
	await expect(page).toHaveURL(/\/farm$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Your hydrological units' })).toBeVisible();
	for (const farm of [/Rietspruit/, /Kareebos/]) await expect(page.getByRole('link', { name: farm })).toContainText('% of water needed');
	await page.getByRole('link', { name: /Kareebos/ }).click();
	await expect(page.getByRole('heading', { level: 1, name: /^Kareebos/ })).toBeVisible();
	await expectNoSidewaysScroll(page);
});

// Its own owner and farmer: a catchment whose runs nobody has published yet.
test('a farm whose catchment has nothing published says so', async ({ page, owner, signIn: signInAs }) => {
	const project = await createProject(page.context().request, 'Unpublished catchment');
	const model = sampleModel();
	await putModel(page.context().request, project.id, model);
	const farmer = await signInAs('Early farmer');
	const farmId = model.nodes.find((n) => n.kind === 'farm')!.id as string;
	const add = await page.context().request.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: farmer.user.email, nodeIds: [farmId] } });
	expect(add.status(), await add.text()).toBe(201);
	await acceptInvites(farmer.user.email, project.id);
	expect(owner.id).toBeTruthy();

	await farmer.page.setViewportSize(PHONE);
	await farmer.page.goto('/');
	await expect(farmer.page).toHaveURL(new RegExp(`/farm/${project.id}`));
	await expect(farmer.page.getByRole('heading', { level: 2, name: 'Your WUA hasn’t published figures yet' })).toBeVisible();
	await expect(farmer.page.getByText('Questions? Contact your WUA.', { exact: true })).toBeVisible();
	await expectNoSidewaysScroll(farmer.page);

	// Once the WUA's name is set (095_wua_name), the contact line names it.
	const named = await page.context().request.patch(`${API_URL}/projects/${project.id}`, { data: { wuaName: 'Early Valley WUA' } });
	expect(named.status(), await named.text()).toBe(200);
	await farmer.page.reload();
	await expect(farmer.page.getByText('Questions? Contact Early Valley WUA.', { exact: true })).toBeVisible();
});

// The farm pages sit outside the app shell (FarmShell, ui.md § Farmer view).
// Their header is sticky at every width, while the shell sets --header-h to 0
// from 900 px: a link into a page must still land below the farm header.
async function headerBottom(page: Page) {
	return page.locator('.farm-header').evaluate((el) => el.getBoundingClientRect().bottom);
}

test('the farm pages pass an a11y scan on a phone and a desktop, in light and dark', async ({ page }) => {
	test.setTimeout(90_000);
	await signIn(page, FARMER1);
	const { projectId } = await farmOf(page.context());
	await expect(page).toHaveURL(new RegExp(`/farm/${projectId}$`));
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		for (const size of [PHONE, DESKTOP]) {
			await page.setViewportSize(size);
			for (const path of [`/farm/${projectId}`, `/farm/${projectId}/why`, `/farm/${projectId}/dam`, '/farm/words']) {
				await page.goto(path);
				await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
				await expect(page.locator('main[aria-busy]')).toHaveCount(0);
				await expectNoViolations(page);
			}
		}
	}
});

test('a link into a farm page lands below the sticky farm header on a phone and a desktop', async ({ page }) => {
	await signIn(page, FARMER1);
	const { projectId } = await farmOf(page.context());
	await expect(page).toHaveURL(new RegExp(`/farm/${projectId}$`));
	for (const size of [PHONE, DESKTOP]) {
		await page.setViewportSize(size);
		// A glossary entry, loaded by its address (the dam page's "What is “modelled”?").
		await page.goto('/farm/words#farm-modelled');
		const entry = page.locator('#farm-modelled');
		await expect(entry).toBeInViewport();
		await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
		const bottom = await headerBottom(page);
		await expect.poll(() => entry.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(bottom);

		// "Read the notice" on Why? goes back to the farm page's notice, below the header and in view.
		await page.goto(`/farm/${projectId}/why`);
		await page.getByRole('link', { name: 'Read the notice' }).click();
		await expect(page).toHaveURL(new RegExp(`/farm/${projectId}#notice$`));
		const notice = page.locator('#notice');
		await expect(notice).toBeInViewport();
		await expect.poll(() => notice.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(await headerBottom(page));
	}
});

test('a list of farms that fits the window doesn’t scroll', async ({ page }) => {
	await signIn(page, FARMER2);
	await expect(page).toHaveURL(/\/farm$/);
	for (const size of [PHONE, DESKTOP, { width: 1440, height: 960 }]) {
		await page.setViewportSize(size);
		await expect(page.getByRole('link', { name: /Kareebos/ })).toContainText('% of water needed');
		const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollHeight, window.innerHeight]);
		expect(scroll).toBeLessThanOrEqual(inner);
	}
});

// Design for N (ui-playbook § 2): a farmer linked to many farms in one
// catchment (or WUA staff previewing, who see them all) gets the switcher
// folded, so the farm's name and the WUA's notice stay on the first screen.
test('many farms in one catchment fold the switcher; the notice stays on the first screen', async ({ page, owner, signIn: signInAs }) => {
	test.setTimeout(90_000);
	void owner;
	const req = page.context().request;
	const project = await createProject(req, 'Many farms catchment');
	const base = sampleModel();
	const [gauge, template] = [base.nodes[0]!, base.nodes[1]!];
	const farms = Array.from({ length: 14 }, (_, i) => ({ ...template, id: crypto.randomUUID(), name: `Farm ${i + 1} with a longer name`, sortOrder: i + 2 }));
	const crop = base.crops[0]!;
	await putModel(req, project.id, { nodes: [gauge, ...farms], crops: [crop], cropAreas: farms.map((f) => ({ nodeId: f.id, cropId: crop.id, areaM2: 100_000 })), transfers: [] });
	await updateSettings(req, project.id, { apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110], ewrPragmaticM3PerDay: Array(12).fill(1000) });
	await putSeries(req, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(120) });
	await putSeries(req, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(120) });
	const runId = await createRun(req, project.id, 'Baseline');
	const pub = await req.post(`${API_URL}/projects/${project.id}/publication`, {
		data: { runId, restriction: { level: 'restricted', pct: 20, notice: { en: 'Pump at night only.' } } }
	});
	expect(pub.status(), await pub.text()).toBe(201);
	const farmer = await signInAs('Many-farm farmer');
	const add = await req.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: farmer.user.email, nodeIds: farms.map((f) => f.id) } });
	expect(add.status(), await add.text()).toBe(201);
	await acceptInvites(farmer.user.email, project.id);

	const fp = farmer.page;
	await fp.setViewportSize(PHONE);
	await fp.goto(`/farm/${project.id}?node=${farms[0]!.id}`);
	await expect(fp.getByRole('heading', { level: 1, name: 'Farm 1 with a longer name' })).toBeInViewport();
	await expect(fp.locator('#notice')).toBeInViewport();
	// The WUA's words and its percentage, both, as the alert email says them (operator, 2026-10-01).
	await expect(fp.locator('#notice')).toContainText('Pump at night only.');
	await expect(fp.locator('#notice')).toContainText(/Set by the WUA: a 20\s%\scut in registered water use\./);
	const switcher = fp.getByRole('navigation', { name: 'Your hydrological units in this catchment' });
	await expect(switcher).toBeHidden();
	await fp.getByText('Your hydrological units in this catchment (14 hydrological units)', { exact: true }).click();
	await expect(switcher.getByRole('link')).toHaveCount(14);
	await expect(switcher.getByRole('link', { name: 'Farm 1 with a longer name' })).toHaveAttribute('aria-current', 'page');
	await switcher.getByRole('link', { name: 'Farm 14 with a longer name' }).click();
	await expect(fp).toHaveURL(new RegExp(`node=${farms[13]!.id}`));
	await expect(fp.getByRole('heading', { level: 1, name: 'Farm 14 with a longer name' })).toBeVisible();
	await expectNoSidewaysScroll(fp);
	await expectNoViolations(fp);
});

// Issue #177: with no cut asked of the farm, the model's "you had about X %" only repeats the Supply
// card, so "Looking back" folds to its link line, as under a restriction. The seeded Vaalbank (the
// first test) is the positive control: the river asked it to pump less, and its card shows.
test('the model card folds to its link line when the river asked for no cut', async ({ page, owner, signIn: signInAs }) => {
	void owner;
	const req = page.context().request;
	const project = await createProject(req, 'No cut catchment');
	const model = sampleModel();
	await putModel(req, project.id, model);
	// No pragmatic EWR, so the river never asks anyone to pump less.
	await updateSettings(req, project.id, { apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110], ewrPragmaticM3PerDay: Array(12).fill(0) });
	await putSeries(req, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(120) });
	await putSeries(req, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(120) });
	const runId = await createRun(req, project.id, 'Baseline');
	const pub = await req.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId, restriction: { level: 'none' } } });
	expect(pub.status(), await pub.text()).toBe(201);
	const upper = model.nodes.find((n) => n.name === 'Upper farm')!;
	const farmer = await signInAs('No-cut farmer');
	const add = await req.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: farmer.user.email, nodeIds: [upper.id] } });
	expect(add.status(), await add.text()).toBe(201);
	await acceptInvites(farmer.user.email, project.id);
	// The premise, as the farmer's own view has it: no day charged to the farm.
	const view = (await (await farmer.page.request.get(`${API_URL}/projects/${project.id}/farm/${upper.id}`)).json()) as { farm: { river: { chargedDays: number } } };
	expect(view.farm.river.chargedDays).toBe(0);

	const fp = farmer.page;
	await fp.setViewportSize(PHONE);
	await fp.goto(`/farm/${project.id}`);
	await expect(fp.getByRole('region', { name: 'Water you received this season' })).toBeVisible();
	await expect(fp.getByRole('link', { name: 'The model’s look back and what you can do' })).toHaveAttribute('href', new RegExp(`/farm/${project.id}/why`));
	await expect(fp.getByRole('region', { name: /^Looking back/ })).toHaveCount(0);
	await expectNoViolations(fp);
});

// Issue #72: a farmer sees their own farm's registered volumes and storage, with what a
// registration is not, and never another farm's. The other farm's distinctive volume is the
// negative control; the farm's own figures are the positive one.
test('a farmer sees their own registered water, not an entitlement, and no one else’s', async ({ page, owner, signIn: signInAs }) => {
	void owner;
	const req = page.context().request;
	const project = await createProject(req, 'Registered water catchment');
	const model = sampleModel();
	await putModel(req, project.id, model);
	await updateSettings(req, project.id, { apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110], ewrPragmaticM3PerDay: Array(12).fill(1000) });
	await putSeries(req, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(120) });
	await putSeries(req, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(120) });
	const upper = model.nodes.find((n) => n.name === 'Upper farm')! as { id: string };
	const lower = model.nodes.find((n) => n.name === 'Lower farm')! as { id: string };
	await addAllocation(req, project.id, { nodeId: upper.id, registrationNo: 'E2E-REG-1', holder: 'Invented Holder', authorisation: 'registration', waterSource: 'surface', volumeM3PerYear: 120_000 });
	await addAllocation(req, project.id, { nodeId: upper.id, authorisation: 'registration', waterSource: 'surface', volumeM3PerYear: 0, storageM3: 150_000, waterUse: '21b' });
	await addAllocation(req, project.id, { nodeId: lower.id, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 777_000 });
	const runId = await createRun(req, project.id, 'Baseline');
	const pub = await req.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId, restriction: { level: 'none' } } });
	expect(pub.status(), await pub.text()).toBe(201);
	const farmer = await signInAs('Registered farmer');
	const add = await req.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: farmer.user.email, nodeIds: [upper.id] } });
	expect(add.status(), await add.text()).toBe(201);
	await acceptInvites(farmer.user.email, project.id);

	const fp = farmer.page;
	await fp.setViewportSize(PHONE);
	await fp.goto(`/farm/${project.id}`);
	const card = fp.getByRole('region', { name: 'Your registered water' });
	await expect(card).toContainText(/Surface water: 120\s000\sm³ a year/);
	await expect(card).toContainText(/Dam storage: 150\s000\sm³/);
	await expect(card).toContainText('A registered volume is not an entitlement');
	// Only the farm's own: no name, no registration number, nothing of the other farm.
	await expect(fp.getByRole('main')).not.toContainText(/Invented Holder|E2E-REG-1|777\s000/);
	// Reference figures, below the season's cards: after "Looking back", before the last 12 months.
	await expectBefore(fp.locator('#dam-h'), card);
	await expectNoSidewaysScroll(fp);
	await expectNoViolations(fp);
	await fp.setViewportSize(DESKTOP);
	await expectNoViolations(fp);
});
