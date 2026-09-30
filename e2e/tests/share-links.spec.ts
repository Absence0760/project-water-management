// Read-only share links (WP-2.3 phase 2, docs/ui.md § Share links): an owner
// makes a link on the Project page and copies it; someone signed out opens it
// on a phone and sees the catchment's reserve status and the WUA's notice, the
// token gone from the address bar; the owner withdraws it and the link shows
// the dead-link state. A catchment with too few farms gets no flow chart.
// The layout (issue #17) is pinned at 1440 × 960 and on a phone.
import type { APIRequestContext } from '@playwright/test';
import { words as siteWords } from '../support/lang.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { createRun, putModel, seedRunnableProject, type Model } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { answerConfirm } from '../support/confirm.ts';

const PHONE = { width: 360, height: 740 };
const words = await siteWords('af');
const NOTICE = 'Water is short on the river.\nIrrigate at night and cut back where you can.';

/** The sample network with three more farms: five farm holders, enough for the flow chart (FARMER_K). */
function fiveFarms(model: Model): Model {
	const gauge = model.nodes.find((n) => n.kind === 'gauge')!;
	const lower = model.nodes.find((n) => n.name === 'Lower farm')!;
	const extra = ['Farm Three', 'Farm Four', 'Farm Five'].map((name, i) => ({ ...lower, id: crypto.randomUUID(), name, downstreamNodeId: gauge.id, sortOrder: 4 + i }));
	return {
		...model,
		nodes: [...model.nodes, ...extra],
		cropAreas: [...model.cropAreas, ...extra.map((n) => ({ nodeId: n.id as string, cropId: model.crops[0]!.id, areaM2: 50_000 }))]
	};
}

async function publish(request: APIRequestContext, projectId: string) {
	const runId = await createRun(request, projectId, 'Baseline');
	const res = await request.post(`${API_URL}/projects/${projectId}/publication`, {
		data: { runId, note: 'Staff only: the gauge was re-rated in March.', restriction: { level: 'advisory', pct: 10, notice: { en: NOTICE } } }
	});
	expect(res.status()).toBe(201);
}

test('an owner shares the published baseline; it opens signed out on a phone, and a withdrawn link is dead', async ({ page, owner, browser }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Shared catchment');
	const model = fiveFarms(project.model);
	await putModel(page.request, project.id, model);
	await publish(page.request, project.id);
	await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

	await page.goto(`/projects/${project.id}?tab=project`);
	const panel = page.getByRole('region', { name: 'Share links' });
	await expect(panel.getByText('No share links yet.')).toBeVisible();
	const form = panel.getByRole('form', { name: 'Make a share link' });
	await form.getByLabel('Who it’s for').fill('Catchment forum');
	await form.getByLabel('Works for').selectOption({ label: '90 days' });
	await form.getByRole('button', { name: 'Make link' }).click();

	const url = await panel.getByLabel('The new link').inputValue();
	expect(url).toMatch(/\/share#t=[A-Za-z0-9_-]{43}$/);
	await panel.getByRole('button', { name: 'Copy' }).click();
	await expect(panel.getByRole('status').filter({ hasText: 'Link copied.' })).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
	const row = panel.getByRole('row', { name: /Catchment forum/ });
	await expect(row).toContainText('Live');
	await expect(row).toContainText('Never');
	await expectNoViolations(page);

	// Signed out, on a phone, in a browser that has never seen the app.
	const stranger = await browser.newContext({ viewport: PHONE, locale: 'en-ZA', timezoneId: 'UTC' });
	const shared = await stranger.newPage();
	const t0 = Date.now();
	await shared.goto(url);
	const notice = shared.getByRole('region', { name: 'Water is short on the river.' });
	const reserve = shared.getByRole('region', { name: 'The river’s ecological reserve' });
	await expect(notice).toBeVisible();
	await expect(reserve.getByText('At the catchment outlet')).toBeVisible();
	// The acceptance criterion (roadmap WP-2.3): status and notice in under 2 s locally.
	expect(Date.now() - t0).toBeLessThan(2000);
	await expect(shared).toHaveURL(/\/share$/);
	expect(await shared.evaluate(() => location.hash)).toBe('');
	await expect(shared.getByRole('heading', { level: 1 })).toHaveText('Shared catchment');
	await expect(shared.getByText(/^Published by Owner \d+ on /)).toBeVisible();
	// Under the heading, where the reliance happens (docs/legal/disclaimer-review.md § 3).
	await expect(shared.getByTestId('share-caveat')).toHaveText(
		'A model estimate that can be wrong, not a measurement, licence or restriction. As far as the law allows, the operator of this software accepts no responsibility to anyone who relies on this page.'
	);
	await expect(notice).toContainText('Irrigate at night and cut back where you can.');
	// The seeded record is long past, so the 30 days are named by their last day (issue #162).
	await expect(reserve.getByText(/(Below|Kept) its reserve on .* the 30\sdays\sto\s\d{1,2}\s\w{3,4}\s\d{4}\./)).toBeVisible();
	await expect(shared.getByRole('region', { name: 'River flow each month, in m³ a day' })).toBeVisible();
	// No farm, no note, anywhere on the page.
	const text = await shared.locator('body').innerText();
	for (const name of model.nodes.map((n) => n.name as string)) expect(text).not.toContain(name);
	expect(text).not.toContain('Staff only');
	await expect(shared.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
	const [scroll, inner] = await shared.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
	expect(scroll).toBeLessThanOrEqual(inner);
	await expectNoViolations(shared);
	await shared.emulateMedia({ colorScheme: 'dark' });
	await expectNoViolations(shared);
	await shared.emulateMedia({ colorScheme: 'light' });

	// The page is translated (WP-2.5): its header has the language switch.
	// Afrikaans turns the page's words and <html lang>; the WUA wrote only an
	// English notice, so that stays English, marked lang="en", and the card
	// says so.
	await expect(shared.locator('html')).toHaveAttribute('lang', 'en');
	await shared.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'Afrikaans' }).click();
	await expect(shared.locator('html')).toHaveAttribute('lang', 'af');
	await expect(shared.getByRole('group', { name: words('Language') }).getByRole('button', { name: 'Afrikaans' })).toHaveAttribute('aria-pressed', 'true');
	// The line names the language in the page's words ("Engels"), as the browser names it.
	await expect(notice).toContainText(words('The WUA wrote this notice in {language} only.').replace('{language}', new Intl.DisplayNames(['af-ZA'], { type: 'language' }).of('en')!));
	await expect(notice.getByRole('heading', { name: 'Water is short on the river.' })).toHaveAttribute('lang', 'en');
	const reserveAf = shared.getByRole('region', { name: words('The river’s ecological reserve') });
	await expect(reserveAf.getByText(words('At the catchment outlet'))).toBeVisible();
	await expectNoViolations(shared);

	// Opening it counts as a use.
	await page.reload();
	await expect(row).not.toContainText('Never');

	// Withdraw it: the confirm, then the link is dead for whoever holds it.
	await row.getByRole('button', { name: 'Withdraw Catchment forum' }).click();
	await answerConfirm(page, true, 'Withdraw the link “Catchment forum” (the published baseline)?');
	await expect(row).toContainText('Withdrawn');
	await expect(row.getByRole('button', { name: /^Withdraw/ })).toHaveCount(0);

	// The same tab again: only the fragment changes, so the page must pick the new token up without a reload.
	await shared.goto(url);
	// Still in the Afrikaans this browser chose above.
	await expect(shared.getByRole('alert')).toHaveText(words('This link has expired or was withdrawn. Ask whoever sent it for a new one.'));
	await expect(shared).toHaveURL(/\/share$/);
	await expectNoViolations(shared);
	await stranger.close();
});

test('a catchment with too few farms shows its status without the flow chart, and a cut-short link says so', async ({ page, owner, browser }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Two-farm catchment');
	await publish(page.request, project.id);
	const made = await page.request.post(`${API_URL}/projects/${project.id}/share-links`, { data: { label: 'Neighbours', expiresInDays: 7 } });
	expect(made.status()).toBe(201);
	const { link } = (await made.json()) as { link: { url: string } };

	const stranger = await browser.newContext({ viewport: PHONE });
	const shared = await stranger.newPage();
	await shared.goto(link.url);
	await expect(shared.getByRole('region', { name: 'The river’s ecological reserve' })).toBeVisible();
	await expect(shared.getByText(/^The flow chart isn’t shown for this catchment/)).toBeVisible();
	await expect(shared.getByRole('region', { name: /^River flow each month/ })).toHaveCount(0);
	await expect(shared.getByText(/^2\s+hydrological units in the catchment\.$/)).toBeVisible();

	await shared.goto('/share');
	await expect(shared.getByRole('alert')).toHaveText(/^This page needs the whole link\./);
	await stranger.close();
});

// Screen use (issue #17): on a laptop the whole result fits the window in two
// columns (the notice and the reserve, then the flow chart and About), with
// the header's content lined up over the page's; on a phone the header stays
// one row (the name with "Shared view" under it, the EN | AF switch beside)
// and the page stacks with no sideways scroll. axe in both themes at both sizes.
test('a share link fits a laptop screen in two columns and a phone in one', async ({ page, owner, browser }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Two-column catchment');
	await putModel(page.request, project.id, fiveFarms(project.model));
	await publish(page.request, project.id);
	const made = await page.request.post(`${API_URL}/projects/${project.id}/share-links`, { data: { label: 'Laptop', expiresInDays: 7 } });
	expect(made.status()).toBe(201);
	const { link } = (await made.json()) as { link: { url: string } };

	const stranger = await browser.newContext({ viewport: { width: 1440, height: 960 } });
	const shared = await stranger.newPage();
	await shared.goto(link.url);
	await expect(shared.locator('main[data-share-state="ready"]')).toBeVisible();
	await expect(shared.getByRole('heading', { level: 1 })).toHaveCount(1);
	const notice = (await shared.getByRole('region', { name: 'Water is short on the river.' }).boundingBox())!;
	const reserve = (await shared.getByRole('region', { name: 'The river’s ecological reserve' }).boundingBox())!;
	const chart = (await shared.getByRole('region', { name: 'River flow each month, in m³ a day' }).boundingBox())!;
	const about = (await shared.getByRole('region', { name: 'About this page' }).boundingBox())!;
	// Notice and chart side by side at the top; reserve under the notice, About under the chart.
	expect(Math.abs(notice.y - chart.y)).toBeLessThan(1);
	expect(chart.x).toBeGreaterThan(notice.x + notice.width);
	expect(Math.abs(reserve.x - notice.x)).toBeLessThan(1);
	expect(Math.abs(about.x - chart.x)).toBeLessThan(1);
	// All of it inside 1440 × 960: no page scroll.
	expect(about.y + about.height).toBeLessThanOrEqual(960);
	expect(await shared.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(0);
	// The header's brand starts where the page's content does.
	const brand = (await shared.locator('.share-header .brand').boundingBox())!;
	expect(Math.abs(brand.x - notice.x)).toBeLessThan(1);
	for (const colorScheme of ['light', 'dark'] as const) {
		await shared.emulateMedia({ colorScheme });
		await expectNoViolations(shared);
	}
	await shared.emulateMedia({ colorScheme: 'light' });

	for (const viewport of [PHONE, { width: 390, height: 844 }]) {
		await shared.setViewportSize(viewport);
		const header = (await shared.locator('.share-header').boundingBox())!;
		expect(header.height).toBeLessThanOrEqual(64);
		const en = (await shared.getByRole('button', { name: 'English' }).boundingBox())!;
		const af = (await shared.getByRole('button', { name: 'Afrikaans' }).boundingBox())!;
		expect(Math.abs(en.y - af.y)).toBeLessThan(1);
		const notice2 = (await shared.getByRole('region', { name: 'Water is short on the river.' }).boundingBox())!;
		const chart2 = (await shared.getByRole('region', { name: 'River flow each month, in m³ a day' }).boundingBox())!;
		expect(Math.abs(notice2.x - chart2.x)).toBeLessThan(1);
		expect(chart2.y).toBeGreaterThan(notice2.y + notice2.height);
		await expectNoSidewaysScroll(shared);
	}
	for (const colorScheme of ['light', 'dark'] as const) {
		await shared.emulateMedia({ colorScheme });
		await expectNoViolations(shared);
	}
	await stranger.close();
});
