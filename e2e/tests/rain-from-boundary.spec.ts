// The rain feed from the map's catchment boundary (issue #326 B-rain;
// docs/ui.md § Data feeds and § Map, docs/maps.md § Rain from the boundary),
// on the seeded Sandspruit, whose map has a boundary. The Map tab says no rain
// feed reads it and links to Settings → Data feeds with the proposal open:
// the boundary, its CHIRPS cells and how much of them lies inside, what Apply
// does, and the cells in a table. The owner applies it, the feed list shows
// the boundary's cells, and the Map tab's line goes. A viewer gets neither
// the link nor the button. The page passes axe with the proposal open. No
// fetch runs here (the DB tests fetch through the fixtures), and the feed is
// removed afterwards, so the shared example stays as seeded.
import type { APIRequestContext, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL, WEB_URL } from '../support/env.ts';
import { ANALYST, DEMO, SANDSPRUIT, seedExamplesOnce } from '../support/examples.ts';
import { expect, test } from '../support/fixtures.ts';
import { openMap } from '../support/map.ts';

test.describe.configure({ mode: 'serial' });

async function signInAs(page: Page, who: { email: string; password: string }) {
	await page.goto('/login');
	await page.getByLabel('Email').fill(who.email);
	await page.getByLabel('Password').fill(who.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
}

async function sandspruitId(request: APIRequestContext): Promise<string> {
	const { projects } = (await (await request.get(`${API_URL}/projects`)).json()) as { projects: { id: string; name: string }[] };
	return projects.find((p) => p.name === SANDSPRUIT)!.id;
}

/** Remove any feed this spec left on the shared example (a failed earlier run included). */
async function removeBoundaryFeeds(request: APIRequestContext, id: string) {
	const { feeds } = (await (await request.get(`${API_URL}/projects/${id}/feeds`)).json()) as { feeds: { id: string; config: { boundary?: unknown } }[] };
	for (const f of feeds.filter((x) => x.config.boundary)) expect((await request.delete(`${API_URL}/projects/${id}/feeds/${f.id}`, { headers: { Origin: WEB_URL } })).status()).toBe(204);
}

test.beforeAll(async ({ playwright }) => {
	test.setTimeout(90_000);
	const api = await playwright.request.newContext();
	await seedExamplesOnce(api);
	await api.dispose();
});

test('the owner sets the rain feed up from the boundary: the map links to the proposal, Apply attaches it, and the feed lists the boundary’s cells', async ({ page }) => {
	await signInAs(page, ANALYST);
	const id = await sandspruitId(page.request);
	await removeBoundaryFeeds(page.request, id);
	try {
		await openMap(page, id);
		await expect(page.getByTestId('map-rain')).toHaveAttribute('data-state', 'none');
		await expect(page.getByTestId('map-rain-link')).toContainText('No rain feed reads this catchment boundary yet.');
		await page.getByRole('link', { name: 'Set up the rain feed from the boundary' }).click();

		// Settings → Data feeds, the proposal open.
		await expect(page).toHaveURL(/[?&]tab=settings/);
		await expect(page).toHaveURL(/[?&]rain=boundary/);
		const proposal = page.getByRole('region', { name: 'Rain from the catchment boundary' });
		await expect(proposal.getByTestId('boundary-rain-boundary')).toHaveText(/^“Sandspruit catchment”, \d+\.\d km², drawn or last changed \d{1,2} \w{3} \d{4}$/);
		const cellsLine = proposal.getByTestId('boundary-rain-cells');
		await expect(cellsLine).toHaveText(/^\d+ CHIRPS v3 cells of 0\.05° in \d+ rows, [\d\s.]+ km² in all, [\d\s.]+ km² of it inside the boundary$/);
		const n = Number((await cellsLine.textContent())!.match(/^(\d+)/)![1]);
		expect(n).toBeGreaterThan(8);
		await expect(proposal.getByText(/^Rainfall area-weighted over \d+ CHIRPS v3 cells \(0\.05°\), each by the share of it inside the boundary\. Source: CHIRPS v3 daily/)).toBeVisible();
		await expect(proposal.getByTestId('boundary-rain-apply-words')).toHaveText(/^Apply attaches a new CHIRPS feed into .+\. It reads the last 60 days at its first fetch, then keeps up daily\.$/);
		await proposal.getByText('The cells', { exact: true }).click();
		const table = proposal.getByRole('table', { name: 'The boundary’s CHIRPS cells' });
		await expect(table.locator('tbody tr')).toHaveCount(n);
		await expect(table.locator('tbody tr').first()).toHaveText(/-33\.\d{3}\s*21\.\d{3}\s*[\d.]+ %\s*0\.\d{3}/);
		await expectNoViolations(page);

		await proposal.getByTestId('boundary-rain-apply').click();
		await expect(proposal.getByTestId('boundary-rain-done')).toContainText(`the CHIRPS feed now reads ${n} cells of “Sandspruit catchment”`);
		const feed = page.getByRole('list', { name: 'Data feeds' }).getByRole('listitem').filter({ hasText: 'of the catchment boundary' });
		await expect(feed).toHaveCount(1);
		await expect(feed).toContainText(`${n} cells of the catchment boundary “Sandspruit catchment”, area weighted`);
		await expect(feed).toContainText('CHIRPS daily rainfall');

		// The map's line goes once a feed reads this boundary.
		await openMap(page, id);
		await expect(page.getByTestId('map-rain')).toHaveAttribute('data-state', 'current');
		await expect(page.getByTestId('map-rain-link')).toHaveCount(0);
	} finally {
		await removeBoundaryFeeds(page.request, id);
	}
});

test('a viewer gets neither the map’s link nor the button', async ({ page }) => {
	await signInAs(page, DEMO);
	const id = await sandspruitId(page.request);
	await openMap(page, id);
	await expect(page.getByTestId('map-feature-list')).toBeVisible();
	await expect(page.getByTestId('map-rain')).toHaveCount(0);
	await page.goto(`/projects/${id}?tab=settings&rain=boundary`);
	const panel = page.getByRole('region', { name: 'Data feeds' });
	await expect(panel.getByRole('button', { name: 'Refresh status' })).toBeVisible();
	await expect(panel.getByRole('button', { name: 'Use the catchment boundary' })).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Rain from the catchment boundary' })).toHaveCount(0);
});
