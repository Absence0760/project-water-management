// The rain feed from the map's catchment boundary (issue #326 B-rain;
// docs/ui.md § Data feeds and § Map, docs/maps.md § Rain from the boundary),
// on the seeded Sandspruit, whose map has a boundary. The Map tab says no rain
// feed reads it and links to Data → Data feeds with the proposal open:
// the boundary, its CHIRPS cells and how much of them lies inside, what Apply
// does, and the cells in a table. The owner applies it, the feed list shows
// the boundary's cells, and the Map tab's line goes. A viewer gets neither
// the link nor the button. The page passes axe with the proposal open. No
// fetch runs here (the DB tests fetch through the fixtures), and the feed is
// removed afterwards, so the shared example stays as seeded. On a project of
// its own whose runs read a CHIRPS record (issue #561), the proposal names the
// record, keeps it for runs (the new series sorts after it, read from the
// record's first day with rnl), and replaces it only when the owner chooses.
import type { APIRequestContext, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL, WEB_URL } from '../support/env.ts';
import { createProject, putSeries } from '../support/api.ts';
import { ANALYST, DEMO, SANDSPRUIT, seedExamplesOnce } from '../support/examples.ts';
import { expect, test } from '../support/fixtures.ts';
import { box, openMap } from '../support/map.ts';

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
		// The step is in the header's Getting started pill (it was a line above the map until 2026-10-02): 1 of 2, the boundary done.
		const pill = page.getByTestId('map-setup-pill');
		await expect(pill).toHaveText(/^\s*Getting started\s*· 1 of 2$/);
		await pill.click();
		await expect(pill).toHaveAttribute('aria-expanded', 'true');
		const step = page.getByTestId('map-setup').locator('[data-step="rain"]');
		await expect(step).toContainText('No rain feed reads this catchment boundary yet.');
		await expect(step.getByTestId('map-rain-link')).toHaveText('Set up the rain feed from the boundary');
		// Escape closes it and gives the focus back to the pill.
		await page.keyboard.press('Escape');
		await expect(pill).toHaveAttribute('aria-expanded', 'false');
		await expect(pill).toBeFocused();
		await pill.click();
		await page.getByRole('link', { name: 'Set up the rain feed from the boundary' }).click();

		// Data → Data feeds, the proposal open.
		await expect(page).toHaveURL(/[?&]tab=series/);
		await expect(page).toHaveURL(/[?&]rain=boundary/);
		// It lands on the Data page's Data feeds (issue #586: it was on Settings), in view, the proposal's heading focused.
		await expect(page).toHaveURL(/#data-feeds$/);
		await expect(page.getByRole('heading', { name: 'Data feeds', level: 2 })).toBeInViewport();
		await expect(page.getByRole('heading', { name: 'Rain from the catchment boundary' })).toBeFocused();
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
		// Every step done: the pill goes (finished work leaves the page).
		await expect(page.getByTestId('map-setup-pill')).toHaveCount(0);
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
	await page.goto(`/projects/${id}?tab=series&rain=boundary`);
	const panel = page.getByRole('region', { name: 'Data feeds' });
	await expect(panel.getByRole('button', { name: 'Refresh status' })).toBeVisible();
	await expect(panel.getByRole('button', { name: /^(?:Attach a feed|Rain from the map)$/ })).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Rain from the catchment boundary' })).toHaveCount(0);
});

test('beside a CHIRPS record runs read: the proposal names it and keeps it for runs from its first day, or replaces it when chosen (issue #561)', async ({ page, owner }) => {
	void owner;
	const RECORD = 'Rainfall CHIRPS satelite (mm)';
	const { id } = await createProject(page.request, 'Boundary rain beside a record');
	await putSeries(page.request, id, { kind: 'rain_chirps_mm', name: RECORD, unit: 'mm', startDate: '1995-01-01', values: [1, 2, 3] });
	const made = await page.request.post(`${API_URL}/projects/${id}/map/features`, {
		data: { kind: 'catchment_boundary', name: 'Synthetic catchment', geometry: { type: 'Polygon', coordinates: [box(21.26, -33.74, 0.1)] } }
	});
	expect(made.status(), await made.text()).toBe(201);
	await page.goto(`/projects/${id}?tab=series&rain=boundary`);

	const proposal = page.getByRole('region', { name: 'Rain from the catchment boundary' });
	await expect(proposal.getByTestId('boundary-rain-run-series')).toHaveText(`“${RECORD}”, 1 Jan 1995 to 3 Jan 1995`);
	const keep = proposal.getByRole('radio', { name: `Keep “${RECORD}” for runs, and put the boundary’s rain beside it to compare` });
	const replace = proposal.getByRole('radio', { name: `Replace “${RECORD}” with the boundary’s rain, once its whole record is read` });
	await expect(keep).toBeChecked();
	await expect(replace).toBeEnabled();
	// Read from the record's first day, with rnl (it starts before sat does); never only the last 60 days.
	await expect(proposal.getByRole('combobox')).toHaveValue('rnl');
	await expect(proposal.getByRole('textbox', { name: /^Start date/ })).toHaveValue('1 Jan 1995');
	await expect(proposal.getByTestId('boundary-rain-apply-words')).toHaveText(
		`Apply attaches a new CHIRPS feed into Rainfall — CHIRPS · ${RECORD} (boundary). Runs keep reading “${RECORD}”: the new series sorts after it, so the two sit side by side to compare. It reads the rnl product from 1 Jan 1995, then keeps up daily.`
	);
	await expectNoViolations(page);

	// Replacing says what happens, and hides the product and start (the record's own).
	await replace.check();
	await expect(proposal.getByTestId('boundary-rain-apply-words')).toHaveText(
		`Apply attaches a CHIRPS feed (rnl) that replaces “${RECORD}” with the boundary’s rain: it reads the whole record again from 1 Jan 1995 into a stage, and runs keep reading the old values until the new record is complete, then it takes their place whole (the old values stay in the series’ history).`
	);
	await expect(proposal.getByRole('combobox')).toHaveCount(0);

	// Keep it: the feed goes into the series beside the record.
	await keep.check();
	await proposal.getByTestId('boundary-rain-apply').click();
	await expect(proposal.getByTestId('boundary-rain-done')).toContainText('the CHIRPS feed now reads');
	const { feeds } = (await (await page.request.get(`${API_URL}/projects/${id}/feeds`)).json()) as { feeds: { targetName: string; config: { product?: string; startDate?: string } }[] };
	expect(feeds).toEqual([expect.objectContaining({ targetName: `${RECORD} (boundary)`, config: expect.objectContaining({ product: 'rnl', startDate: '1995-01-01' }) })]);
});

test('a record another feed writes can’t be replaced: the choice is off and says why, and keeping it still applies (issue #561)', async ({ page, owner }) => {
	void owner;
	const RECORD = 'Rainfall CHIRPS';
	const { id } = await createProject(page.request, 'Boundary rain, record fed');
	await putSeries(page.request, id, { kind: 'rain_chirps_mm', name: RECORD, unit: 'mm', startDate: '1995-01-01', values: [1, 2, 3] });
	const fed = await page.request.post(`${API_URL}/projects/${id}/feeds`, {
		data: { source: 'chirps', config: { cells: [{ lat: -33.7, lon: 21.3 }], product: 'rnl', startDate: '1995-01-01' }, targetName: RECORD, replaceSeries: true }
	});
	expect(fed.status(), await fed.text()).toBe(201);
	const made = await page.request.post(`${API_URL}/projects/${id}/map/features`, {
		data: { kind: 'catchment_boundary', name: 'Synthetic catchment', geometry: { type: 'Polygon', coordinates: [box(21.26, -33.74, 0.1)] } }
	});
	expect(made.status(), await made.text()).toBe(201);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/projects/${id}?tab=series&rain=boundary`);

	const proposal = page.getByRole('region', { name: 'Rain from the catchment boundary' });
	const replace = proposal.getByRole('radio', { name: `Replace “${RECORD}” with the boundary’s rain, once its whole record is read` });
	await expect(replace).toBeDisabled();
	await expect(replace).toHaveAccessibleDescription(`Can’t replace it: a feed already writes “${RECORD}”: change or remove that feed to replace its record.`);
	await expect(proposal.getByRole('radio', { name: new RegExp(`^Keep “${RECORD}” for runs`) })).toBeChecked();
	await expectNoViolations(page);
	await proposal.getByTestId('boundary-rain-apply').click();
	await expect(proposal.getByTestId('boundary-rain-done')).toContainText('the CHIRPS feed now reads');
});
