// Results on the Map tab (issue #326 A1, decision D-A1; docs/ui.md § Map,
// docs/maps.md § Results on the map). Areas are coloured by one run's figures:
// the measure (`measure=`, days short by default, "Kind" the off state) and,
// for editors and owners, the run (`run=`; the published run by default, the
// newest when nothing is published). Below editor only the published run, and
// one line when nothing is. Every colour is also in words: the legend's band
// words and counts, the picked feature's card, and Result and Band in Every
// feature. No assertion reads the map's pixels: the colours are checked through
// the key row's data attributes (the colour each band was given, the theme it
// was read in), against the design tokens.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createRun, putSeries, seedRunnableProject, syntheticFlow, syntheticRain, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { ANALYST, DEMO, SANDSPRUIT, seedExamplesOnce } from '../support/examples.ts';
import { expect, test } from '../support/fixtures.ts';
import { boundaryGeoJson, openKey, openMap, parcelsGeoJson, seedBigMap, showTab, uploadThroughSheet } from '../support/map.ts';
import { expectNoSidewaysScroll, layoutSettled } from '../support/reflow.ts';

const results = (page: Page) => page.getByTestId('map-results');
const legend = (page: Page) => page.getByTestId('map-legend');
const card = (page: Page) => page.getByTestId('map-feature-card');
const list = (page: Page) => page.getByTestId('map-feature-list');
/** A list row by its feature's name (its size or position follows it; "Vaalbank" is not "Vaalbank dam"). */
const row = (page: Page, name: string) => list(page).getByRole('button', { name: new RegExp(`^${name} \\d`) });
const BANDS = /^(OK|Watch|Short|No figure)$/;
/** A band cell's text (its narrow-layout label is hidden from the accessible name but in the text). */
const BANDS_CELL = /(OK|Watch|Short|No figure)$/;

/** The key row once the shown run's figures are in. */
async function resultsReady(page: Page, view: string) {
	await expect(results(page)).toHaveAttribute('data-view', view);
	await expect(results(page)).toHaveAttribute('data-ready', 'true');
}

async function signInAs(page: Page, who: { email: string; password: string }) {
	await page.goto('/login');
	await page.getByLabel('Email').fill(who.email);
	await page.getByLabel('Password').fill(who.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
}

async function sandspruitId(page: Page): Promise<string> {
	const res = await page.request.get(`${API_URL}/projects`);
	const { projects } = (await res.json()) as { projects: { id: string; name: string }[] };
	return projects.find((p) => p.name === SANDSPRUIT)!.id;
}

/** A synthetic project with a boundary, two parcels and the outlet gauge on the map, each linked by name. */
async function seedMappedProject(page: Page, name: string) {
	const project = await seedRunnableProject(page.request, name);
	await openMap(page, project.id);
	await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());
	await uploadThroughSheet(page, 'farm_parcel', 'parcels.geojson', parcelsGeoJson());
	const gauge = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Outflow gauge' }, geometry: { type: 'Point', coordinates: [21.39, -33.61] } }] });
	await uploadThroughSheet(page, 'gauge', 'gauge.geojson', gauge);
	return project;
}

test.describe('the seeded Sandspruit', () => {
	test.describe.configure({ mode: 'serial' });
	test.beforeAll(async ({ playwright }) => {
		test.setTimeout(90_000);
		const api = await playwright.request.newContext();
		await seedExamplesOnce(api);
		await api.dispose();
	});

	test('the owner sees every unit coloured from the published run, in words in the legend, the card and Every feature', async ({ page }) => {
		await signInAs(page, ANALYST);
		const id = await sandspruitId(page);
		await openMap(page, id);
		await resultsReady(page, 'daysShort');
		await expect(results(page).getByLabel('Colour areas by')).toHaveValue('daysShort');
		await expect(page.getByTestId('map-run-caption')).toHaveText(/^From the published run “.+”, ran \d{4}-\d\d-\d\d\.$/);
		// The legend names the measure and each band in words, with how many units are in it.
		await expect(legend(page).getByText('Days short', { exact: true })).toBeVisible();
		const items = legend(page).locator('.legend-item');
		await expect(items.first()).toContainText(/\(\d+ units?\)/);
		for (const word of await items.locator('strong').allTextContents()) expect(word).toMatch(BANDS);

		// Every feature: each farm parcel has its unit's figure and band; the boundary and rivers have none.
		await page.getByTestId('map-open-grid').click();
		const grid = page.getByRole('dialog', { name: 'Every map feature' });
		await expect(grid.getByRole('columnheader', { name: 'Result' })).toBeVisible();
		const parcels = grid.getByTestId('map-feature-table').getByRole('row').filter({ has: page.getByRole('cell', { name: 'Farm parcel', exact: true }) });
		await expect(parcels).toHaveCount(8);
		for (const r of await parcels.all()) {
			await expect(r.getByTestId('map-grid-result')).toHaveText(/\d+ of [\d\s,]+ days? short$|No demand days$/);
			await expect(r.getByTestId('map-grid-band')).toHaveText(BANDS_CELL);
		}
		// Every unit has a figure: no parcel is "No figure" for days short in the seeded run.
		await expect(parcels.getByTestId('map-grid-band').filter({ hasText: 'No figure' })).toHaveCount(0);
		await grid.getByRole('button', { name: 'Close', exact: true }).click();

		// The card gives the picked parcel's figure, and a gauge's EWR, met or missed.
		await row(page, 'Vaalbank').click();
		await expect(card(page).getByTestId('map-card-result')).toHaveText(/ days? short · (ok|watch|short)$/);
		await showTab(page, 'features');
		await row(page, 'Melkhout Gauge').click();
		await expect(card(page).getByTestId('map-card-result')).toHaveText(/^(EWR (met every day|missed on [\d\s,]+ days?) \(gauge\) · (ok|short)|(Not an EWR site in this run|No EWR figures in this run) · no figure)$/);
	});

	test('the measure is in the URL, Back undoes a change, and Kind is the off state', async ({ page }) => {
		await signInAs(page, ANALYST);
		const id = await sandspruitId(page);
		await openMap(page, id);
		await resultsReady(page, 'daysShort');
		const measure = results(page).getByLabel('Colour areas by');
		await measure.selectOption({ label: 'Dam level' });
		await expect(page).toHaveURL(/[?&]measure=dam-level/);
		await resultsReady(page, 'damLevel');
		await expect(legend(page).getByText('Dam level', { exact: true })).toBeVisible();
		await row(page, 'Vaalbank').click();
		await expect(card(page).getByTestId('map-card-result')).toHaveText(/(full|minimum|No dam|not in this run).* · (ok|watch|short|no figure)$/i);

		await measure.selectOption({ label: 'Curtailment' });
		await expect(page).toHaveURL(/[?&]measure=curtailment/);
		await resultsReady(page, 'curtailment');
		await measure.selectOption({ label: 'Use against allocation' });
		await resultsReady(page, 'allocation');
		// Back steps through the picks (the feature pick in between too).
		await page.goBack();
		await resultsReady(page, 'curtailment');
		await page.goBack();
		await expect(page).toHaveURL(/[?&]measure=dam-level/);

		// Kind: the kinds' key, no results anywhere.
		await page.goto(`/projects/${id}?tab=map&measure=kind`);
		await expect(results(page)).toHaveAttribute('data-view', 'kind');
		await expect(legend(page)).toHaveCount(0);
		// With the kinds' colours the Key starts folded (nothing a run says needs reading); it opens on its button.
		await expect(page.getByTestId('map-key-toggle')).toHaveAttribute('aria-expanded', 'false');
		await openKey(page);
		await expect(page.getByTestId('map-key').getByText('parcel', { exact: true })).toBeVisible();
		await page.getByTestId('map-open-grid').click();
		await expect(page.getByRole('dialog', { name: 'Every map feature' }).getByRole('columnheader', { name: 'Result' })).toHaveCount(0);
	});

	test('a viewer sees the published run with no run picker; a run= link is ignored below editor', async ({ page }) => {
		await signInAs(page, DEMO);
		const id = await sandspruitId(page);
		await openMap(page, id, '&run=00000000-0000-0000-0000-000000000000');
		await resultsReady(page, 'daysShort');
		await expect(page.getByTestId('map-run-caption')).toHaveText(/^From the published run /);
		await expect(page.getByTestId('map-run')).toHaveCount(0);
		await expectNoViolations(page);
	});
});

test('an editor sees the newest run until one is published, picks a run in the URL; a viewer sees only the published one', async ({ page, owner, signIn }) => {
	void owner;
	test.setTimeout(60_000);
	const project = await seedMappedProject(page, 'Map results runs');
	// No run: one line, the kinds' key, no picker.
	await expect(page.getByTestId('map-no-run')).toHaveText('No run yet, so the map shows each feature’s kind. Run the model to colour it by results.');
	await expect(results(page).getByLabel('Colour areas by')).toHaveCount(0);

	const first = await createRun(page.request, project.id, 'First');
	const second = await createRun(page.request, project.id, 'Second');
	const viewer = await signIn('Map results viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');

	// Nothing published: the editor sees their newest run, and may pick another.
	await openMap(page, project.id);
	await resultsReady(page, 'daysShort');
	await expect(page.getByTestId('map-run-caption')).toHaveText(/^From your newest run “Second”, ran .*: nothing is published yet\.$/);
	const runPick = page.getByTestId('map-run');
	await expect(runPick.locator('option')).toHaveText([/^Second · /, /^First · /]);
	await runPick.selectOption(first);
	await expect(page).toHaveURL(new RegExp(`[?&]run=${first}`));
	await expect(page.getByTestId('map-run-caption')).toHaveText(/^From the run “First”, .*\(not published\)\.$/);
	await resultsReady(page, 'daysShort');
	await page.goBack();
	await expect(page).not.toHaveURL(/run=/);
	await expect(page.getByTestId('map-run-caption')).toHaveText(/“Second”/);

	// The outlet gauge's EWR on its card and in the table, the parcels' figures beside it.
	await row(page, 'Outflow gauge').click();
	await expect(card(page).getByTestId('map-card-result')).toHaveText(/^EWR (met every day|missed on [\d\s,]+ days?) \(outlet\) · (ok|short)$/);
	// Its marker takes the EWR's band colour too, where the browser can draw the map (no WebGL: the list and card above carry it).
	const mapBox = page.getByTestId('catchment-map').locator('xpath=..');
	await expect(mapBox).toHaveAttribute('data-status', /^(ready|failed)$/);
	if ((await mapBox.getAttribute('data-status')) === 'ready') {
		await expect(page.getByRole('button', { name: 'Gauge: Outflow gauge' })).toHaveAttribute('data-fill', /^(#|rgb)/);
	}
	await showTab(page, 'features');
	await page.getByTestId('map-open-grid').click();
	const grid = page.getByRole('dialog', { name: 'Every map feature' });
	const gaugeRow = grid.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Outflow gauge' }) });
	await expect(gaugeRow.getByTestId('map-grid-result')).toContainText('(outlet)');
	const boundaryRow = grid.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Synthetic catchment' }) });
	await expect(boundaryRow.getByTestId('map-grid-result')).toHaveText(/–$/);
	await grid.getByRole('button', { name: 'Close', exact: true }).click();

	// The viewer: nothing published, so one line and the kinds.
	const v = viewer.page;
	await openMap(v, project.id, `&run=${second}`);
	await expect(v.getByTestId('map-no-run')).toHaveText('Nothing is published yet, so the map shows each feature’s kind.');
	await expect(results(v)).toHaveAttribute('data-view', 'kind');
	await expect(v.getByTestId('map-run')).toHaveCount(0);

	// Publish the first: both now see it by default, and the viewer's link to the unpublished run still shows it.
	expect((await page.request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId: first } })).status()).toBe(201);
	await openMap(page, project.id);
	await expect(page.getByTestId('map-run-caption')).toHaveText(/^From the published run “First”/);
	await expect(page.getByTestId('map-run').locator('option')).toHaveText([/^Second · .*\d$/, /^First · .* · published$/]);
	await openMap(v, project.id, `&run=${second}`);
	await resultsReady(v, 'daysShort');
	await expect(v.getByTestId('map-run-caption')).toHaveText(/^From the published run “First”/);
	await v.getByTestId('map-open-grid').click();
	await expect(v.getByRole('dialog', { name: 'Every map feature' }).getByRole('row').filter({ has: v.getByRole('rowheader', { name: 'Upper farm' }) }).getByTestId('map-grid-band')).toHaveText(BANDS_CELL);
});

test('the fills follow the app’s theme: each band’s colour is the token as the theme draws it, read again on a switch', async ({ page, owner }) => {
	void owner;
	await page.emulateMedia({ colorScheme: 'light' });
	const project = await seedMappedProject(page, 'Map results theme');
	await createRun(page.request, project.id, 'Only');
	await openMap(page, project.id);
	await resultsReady(page, 'daysShort');
	await expect(results(page)).toHaveAttribute('data-fill-theme', 'light');
	const swatches = async () =>
		page.evaluate(() =>
			[...document.querySelectorAll<HTMLElement>('[data-testid="map-legend"] [data-band]')].map((el) => ({
				band: el.dataset.band,
				colour: el.dataset.colour,
				token: getComputedStyle(document.documentElement).getPropertyValue(el.dataset.token!).trim()
			}))
		);
	const light = await swatches();
	expect(light.length).toBeGreaterThan(0);
	for (const s of light) expect(s.colour).toBe(s.token);

	await page.emulateMedia({ colorScheme: 'dark' });
	await expect(results(page)).toHaveAttribute('data-fill-theme', 'dark');
	const dark = await swatches();
	for (const s of dark) expect(s.colour).toBe(s.token);
	// The dark theme's band colours differ from the light theme's, so a stale read would show.
	expect(dark.map((s) => s.colour)).not.toEqual(light.map((s) => s.colour));
});

for (const [label, size] of [
	['wide', { width: 1440, height: 960 }],
	['on a phone', { width: 390, height: 844 }]
] as const) {
	test(`results on the map have no axe violations, ${label}`, async ({ page, owner }) => {
		void owner;
		await page.setViewportSize(size);
		const project = await seedMappedProject(page, `Map results axe ${label}`);
		await createRun(page.request, project.id, 'Older');
		await createRun(page.request, project.id, 'Newer');
		await openMap(page, project.id);
		await resultsReady(page, 'daysShort');
		await row(page, 'Upper farm').click();
		await expect(card(page).getByTestId('map-card-result')).toBeVisible();
		await layoutSettled(page);
		await expectNoSidewaysScroll(page);
		await expectNoViolations(page);
		await showTab(page, 'features');
		await page.getByTestId('map-open-grid').click();
		// On a phone the rows are labelled cards (no header row): read a band cell.
		await expect(page.getByRole('dialog', { name: 'Every map feature' }).getByTestId('map-grid-band').first()).toBeVisible();
		await expectNoViolations(page);
	});
}

test('thirty units with results: the page still fits 1440×960, the key row and the map in view', async ({ page, owner }) => {
	void owner;
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 1440, height: 960 });
	const big = await seedBigMap(page.request, 'Map results thirty');
	await updateSettings(page.request, big.id, { apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110] });
	await putSeries(page.request, big.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(120) });
	await putSeries(page.request, big.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(120) });
	await createRun(page.request, big.id, 'Thirty');
	await openMap(page, big.id);
	await resultsReady(page, 'daysShort');
	await layoutSettled(page);
	expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBe(0);
	await expect(legend(page)).toBeInViewport({ ratio: 1 });
	await expect(page.getByTestId('catchment-map')).toBeInViewport({ ratio: 1 });
	// The legend counts all thirty units.
	const counts = await legend(page).locator('.legend-item').allTextContents();
	expect(counts.reduce((n, t) => n + Number(/\((\d+) units?\)/.exec(t)![1]), 0)).toBe(30);
});
