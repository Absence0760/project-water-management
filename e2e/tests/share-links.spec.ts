// Read-only share links (WP-2.3 phase 2, docs/ui.md § Share links): an owner
// makes a link on the Project page and copies it; someone signed out opens it
// on a phone and sees the catchment's reserve status and the WUA's notice, the
// token gone from the address bar; the owner withdraws it and the link shows
// the dead-link state. A catchment with too few farms gets no flow chart.
import type { APIRequestContext } from '@playwright/test';
import { afWords } from '../support/af.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { createRun, putModel, seedRunnableProject, type Model } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const PHONE = { width: 360, height: 740 };
const words = await afWords();
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
		data: { runId, note: 'Staff only: the gauge was re-rated in March.', restriction: { level: 'advisory', pct: 10, noticeEn: NOTICE, noticeAf: null } }
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
	await expect(notice).toContainText('Irrigate at night and cut back where you can.');
	await expect(reserve.getByText(/(Below|Kept) its reserve on .* the last 30\sdays\./)).toBeVisible();
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
	await expect(notice).toContainText(words('The WUA wrote this notice in English only.'));
	await expect(notice.getByRole('heading', { name: 'Water is short on the river.' })).toHaveAttribute('lang', 'en');
	const reserveAf = shared.getByRole('region', { name: words('The river’s ecological reserve') });
	await expect(reserveAf.getByText(words('At the catchment outlet'))).toBeVisible();
	await expectNoViolations(shared);

	// Opening it counts as a use.
	await page.reload();
	await expect(row).not.toContainText('Never');

	// Withdraw it: the confirm, then the link is dead for whoever holds it.
	page.once('dialog', (d) => d.accept());
	await row.getByRole('button', { name: 'Withdraw Catchment forum' }).click();
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
	await expect(shared.getByText(/^2\s+farms in the catchment\.$/)).toBeVisible();

	await shared.goto('/share');
	await expect(shared.getByRole('alert')).toHaveText(/^This page needs the whole link\./);
	await stranger.close();
});
