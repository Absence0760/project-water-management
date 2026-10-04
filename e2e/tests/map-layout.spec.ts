// The Map tab's layout since 2026-10-02 (docs/ui.md § Map): the map's tools on
// the map's left edge (the header keeps the page's actions), a strip over the
// map naming the tool that's on, the last action's toast over the page's foot
// (it never pushes the map down), the setup steps in one Getting started pill,
// Layers and Key as panels over the map's corners, and the side column one
// panel at a time (Details · Features · Checks). Layout pins at 1440×960 and on
// a phone, the old `checks=1` link, the keyboard, a viewer, axe with the panels
// open, light and dark. No assertion reads the map's pixels.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { boundaryGeoJson, openKey, openLayers, openMap, parcelsGeoJson, seedBigMap, showTab, uploadThroughSheet } from '../support/map.ts';
import { expectNoSidewaysScroll, layoutSettled, resizeTo } from '../support/reflow.ts';

const header = (page: Page) => page.getByTestId('section-header');
const tools = (page: Page) => page.getByTestId('map-tools');
const tool = (page: Page, name: string) => tools(page).getByRole('button', { name, exact: true });
const strip = (page: Page) => page.getByTestId('map-tool-strip');
const mapReady = (page: Page) => expect(page.locator('.map-wrap[data-status="ready"]')).toBeVisible();

async function mapped(page: Page, name: string) {
	const project = await seedRunnableProject(page.request, name);
	await openMap(page, project.id);
	await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());
	await uploadThroughSheet(page, 'farm_parcel', 'parcels.geojson', parcelsGeoJson());
	return project;
}

test('the tools are on the map, in order, pressed while on, with a strip naming the one that is on; the header keeps the page actions', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	await mapped(page, 'Map layout tools');
	await mapReady(page);

	// The palette sits inside the map's box, on its left edge, and holds every tool (the e2e API has a DEM and water data).
	await expect(tools(page).getByRole('button')).toHaveText([/Measure/, /Draw/, /Point/, /Delineate/, /Trace/]);
	for (const name of ['Measure', 'Draw a shape', 'Place a point', 'Delineate', 'Trace a dam']) await expect(tool(page, name)).toHaveAttribute('aria-pressed', 'false');
	const box = await page.locator('.map-body').boundingBox();
	const pal = await tools(page).boundingBox();
	expect(pal!.x).toBeGreaterThanOrEqual(box!.x);
	expect(pal!.x - box!.x).toBeLessThan(20);
	expect(pal!.y + pal!.height).toBeLessThanOrEqual(box!.y + box!.height);
	// Every tool button meets the 24 px target.
	for (const b of await tools(page).getByRole('button').all()) {
		const r = (await b.boundingBox())!;
		expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(24);
	}

	// The header: no tools, only the page's actions, on one row.
	for (const name of ['Measure', 'Draw a shape', 'Place a point', 'Delineate', 'Trace a dam']) await expect(header(page).getByRole('button', { name, exact: true })).toHaveCount(0);
	await expect(header(page).getByRole('link', { name: 'Upload GeoJSON' })).toBeVisible();
	await expect(header(page).getByRole('link', { name: 'Divide the model' })).toBeVisible();
	const tops = await header(page).locator('button:visible, a.btn:visible').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
	expect(new Set(tops).size).toBe(1);

	// Tab goes through the tools in order, after the header and before the map.
	await tool(page, 'Measure').focus();
	for (const name of ['Draw a shape', 'Place a point', 'Delineate', 'Trace a dam']) {
		await page.keyboard.press('Tab');
		await expect(tool(page, name)).toBeFocused();
	}

	// A tool on: pressed, the strip names it; Escape on the map ends it and the strip goes; another tool takes over.
	await expect(strip(page)).toHaveCount(0);
	await tool(page, 'Delineate').click();
	await expect(tool(page, 'Delineate')).toHaveAttribute('aria-pressed', 'true');
	await expect(strip(page)).toHaveText('Delineating · Esc to stop');
	// Measure waits while a drawing mode is open (as it did in the header).
	await expect(tool(page, 'Measure')).toBeDisabled();
	await page.keyboard.press('Escape');
	await expect(tool(page, 'Delineate')).toHaveAttribute('aria-pressed', 'false');
	await expect(strip(page)).toHaveCount(0);
	await tool(page, 'Measure').click();
	await expect(tool(page, 'Measure')).toHaveAttribute('aria-pressed', 'true');
	await expect(strip(page)).toHaveText('Measuring · Esc to stop');
	await page.keyboard.press('Escape');
	await expect(tool(page, 'Measure')).toHaveAttribute('aria-pressed', 'false');
	await expect(strip(page)).toHaveCount(0);
	await tool(page, 'Draw a shape').click();
	await expect(strip(page)).toHaveText('Drawing a shape · Esc to cancel');
	await tool(page, 'Place a point').click();
	await expect(tool(page, 'Place a point')).toHaveAttribute('aria-pressed', 'true');
	await expect(tool(page, 'Draw a shape')).toHaveAttribute('aria-pressed', 'false');
	await expect(strip(page)).toHaveText('Placing a point · Esc to cancel');
	await page.keyboard.press('Escape');
	await expect(strip(page)).toHaveCount(0);
});

test('the toast says what an action did without moving the map, and goes on Dismiss or when a tool starts', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Map layout toast');
	await openMap(page, project.id);
	await mapReady(page);
	await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());
	const toast = page.getByTestId('map-notice');
	await expect(toast).toHaveText(/^Imported 1 feature from boundary\.geojson\./);
	await toast.getByRole('button', { name: 'Dismiss' }).click();
	await expect(toast).toHaveCount(0);
	// The next one: over the page's foot, inside the window, and the map hasn't moved (no line pushed in above it).
	const top = (await page.locator('.map-body').boundingBox())!.y;
	await uploadThroughSheet(page, 'farm_parcel', 'parcels.geojson', parcelsGeoJson());
	await expect(toast).toHaveText(/^Imported 2 features from parcels\.geojson\./);
	expect((await page.locator('.map-body').boundingBox())!.y).toBe(top);
	const t = (await toast.boundingBox())!;
	expect(t.y + t.height).toBeLessThanOrEqual(960);
	expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(0);
	await tool(page, 'Place a point').click();
	await expect(toast).toHaveCount(0);
});

test('the setup steps are one pill: the boundary then the rain feed, each with its way in; it opens over the page and Escape closes it', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Map layout setup');
	await openMap(page, project.id);
	await uploadThroughSheet(page, 'farm_parcel', 'parcels.geojson', parcelsGeoJson());
	// No line above the map: nothing sits between the header and the map's card.
	await expect(page.locator('.map-page > .alert')).toHaveCount(0);
	await expect(page.getByTestId('map-no-tiles')).toBeVisible();
	const pill = page.getByTestId('map-setup-pill');
	await expect(pill).toHaveText(/^\s*Getting started\s*· 0 of 2$/);
	const before = await page.evaluate(() => document.documentElement.scrollHeight);
	await pill.click();
	const setup = page.getByTestId('map-setup');
	// The e2e server has an elevation model, so the step leads with Delineate, as the empty map does.
	await expect(setup.locator('[data-step="boundary"]')).toContainText('No catchment boundary yet. Delineate it from its outlet on the river, draw it on the map, or upload it as a GeoJSON file (WGS84).');
	await expect(setup.getByTestId('map-setup-delineate')).toHaveText('Delineate from the outlet');
	await expect(setup.locator('[data-step="rain"]')).toContainText('Once the boundary is on the map');
	// Opening it never makes the page taller, and it stays inside the window (not over the sidebar).
	expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(before);
	const pop = (await setup.locator('.pop').boundingBox())!;
	const main = (await page.locator('.map-page').boundingBox())!;
	expect(pop.x).toBeGreaterThanOrEqual(main.x - 1);
	expect(pop.x + pop.width).toBeLessThanOrEqual(1440);
	await expectNoViolations(page);
	await page.keyboard.press('Escape');
	await expect(pill).toHaveAttribute('aria-expanded', 'false');
	await expect(pill).toBeFocused();
	// Draw the boundary from the pill puts the map in the drawing mode for the boundary.
	await pill.click();
	await page.getByTestId('map-setup-draw-boundary').click();
	await expect(page.getByTestId('map-draw-bar')).toBeVisible();
	await expect(tool(page, 'Draw a shape')).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByTestId('map-draw-bar').getByLabel('Drawing', { exact: true })).toHaveValue('catchment_boundary');
});

test('the side column shows one panel at a time; a pick shows its Details, the arrow keys move between tabs, and checks=1 opens Checks', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await mapped(page, 'Map layout tabs');
	const tabs = page.getByRole('tablist', { name: 'Side panel' });
	await expect(tabs.getByRole('tab')).toHaveText([/^Details/, /^Features\s*3$/, /^Checks/]);
	// The import picked its first feature: Details.
	await expect(page.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByRole('tabpanel')).toHaveCount(1);
	// Arrow keys move the choice and the focus; Home and End go to the ends.
	await page.getByRole('tab', { name: 'Details' }).focus();
	await page.keyboard.press('ArrowRight');
	await expect(page.getByRole('tab', { name: /^Features/ })).toBeFocused();
	await expect(page.getByRole('tab', { name: /^Features/ })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByRole('tabpanel')).toContainText('Upper farm');
	await page.keyboard.press('End');
	await expect(page.getByRole('tab', { name: /^Checks/ })).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('ArrowRight');
	await expect(page.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
	// A pick from the list shows its Details; Back shows the one before.
	await showTab(page, 'features');
	await page.getByTestId('map-feature-list').getByRole('button', { name: /^Lower farm/ }).click();
	await expect(page.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByTestId('map-feature-card').getByRole('heading', { name: 'Lower farm' })).toBeVisible();
	await page.goBack();
	await expect(page.getByTestId('map-feature-card').getByRole('heading')).not.toHaveText('Lower farm');

	// The old Map checks sheet's link opens the Checks tab, and the param goes in place.
	await openMap(page, project.id, '&checks=1');
	await expect(page.getByRole('tab', { name: /^Checks/ })).toHaveAttribute('aria-selected', 'true');
	await expect(page).not.toHaveURL(/checks=/);
	await expect(page.getByRole('dialog', { name: 'Map checks' })).toHaveCount(0);
	await expect(page.getByTestId('map-checks-line')).toBeVisible();
});

test('Layers and Key open over the map’s corners, inside the map; Escape closes each and gives its button the focus', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	await mapped(page, 'Map layout panels');
	await mapReady(page);
	const map = (await page.locator('.map-body').boundingBox())!;
	const inside = async (sel: string) => {
		const r = (await page.locator(sel).boundingBox())!;
		expect(r.x).toBeGreaterThanOrEqual(map.x);
		expect(r.y).toBeGreaterThanOrEqual(map.y);
		expect(r.x + r.width).toBeLessThanOrEqual(map.x + map.width + 0.5);
		expect(r.y + r.height).toBeLessThanOrEqual(map.y + map.height + 0.5);
		return r;
	};
	// With the kinds' colours (no run) the key starts folded; open, it lists only what the map draws.
	await expect(page.getByTestId('map-key-toggle')).toHaveAttribute('aria-expanded', 'false');
	await openKey(page);
	const key = page.getByTestId('map-key');
	await expect(key.locator('.key-h')).toHaveText(['Areas']);
	await expect(key.locator('.key-item')).toHaveText(['catchment boundary', 'parcel']);
	const k = await inside('.key-panel');
	// Clear of the tools above it.
	const pal = (await tools(page).boundingBox())!;
	expect(k.y).toBeGreaterThanOrEqual(pal.y + pal.height);
	await page.getByRole('region', { name: 'Map key' }).focus();
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('map-key-toggle')).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByTestId('map-key-toggle')).toBeFocused();

	await openLayers(page);
	await inside('.layers-panel');
	await page.getByTestId('map-layers').getByRole('checkbox', { name: 'Quaternary catchments' }).focus();
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('map-layers-toggle')).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByTestId('map-layers-toggle')).toBeFocused();
});

test('on a phone the Layers and Key panels take turns, so they never cover each other', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 390, height: 844 });
	await mapped(page, 'Map layout phone panels');
	await mapReady(page);
	const layersBtn = page.getByTestId('map-layers-toggle');
	const keyBtn = page.getByTestId('map-key-toggle');
	await openKey(page);
	await openLayers(page);
	await expect(keyBtn).toHaveAttribute('aria-expanded', 'false');
	await expect(page.locator('.key-panel')).toBeHidden();
	await openKey(page);
	await expect(layersBtn).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByTestId('map-layers')).toBeHidden();
	// Opened wide and narrowed to a phone with both open, the Key gives way too.
	await resizeTo(page, { width: 1440, height: 960 });
	await openLayers(page);
	await openKey(page);
	await expect(layersBtn).toHaveAttribute('aria-expanded', 'true');
	await resizeTo(page, { width: 390, height: 844 });
	await expect(keyBtn).toHaveAttribute('aria-expanded', 'false');
	await expect(page.locator('.key-panel')).toBeHidden();
});

test('a viewer gets Measure alone on the map, no Getting started and no basemap note, and the tabs', async ({ page, owner, signIn }) => {
	void owner;
	const project = await mapped(page, 'Map layout viewer');
	const viewer = await signIn('Map layout viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await openMap(v, project.id);
	await mapReady(v);
	await expect(tools(v).getByRole('button')).toHaveText([/Measure/]);
	await expect(v.getByTestId('map-setup-pill')).toHaveCount(0);
	await expect(v.getByTestId('map-no-tiles')).toHaveCount(0);
	await expect(v.getByRole('tab', { name: /^Features/ })).toHaveAttribute('aria-selected', 'true');
	await expect(header(v).getByRole('link', { name: 'Divide the model' })).toHaveCount(0);
});

test('thirty units: the map keeps the window, the column’s one panel fits it; on a phone the tools stay on the map with no sideways scroll', async ({ page, owner }) => {
	void owner;
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 1440, height: 960 });
	const big = await seedBigMap(page.request, 'Map layout thirty');
	await openMap(page, big.id, `&node=${big.farms[5]}`);
	await mapReady(page);
	await layoutSettled(page);
	const m = await page.evaluate(() => {
		const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
		const panel = [...document.querySelectorAll('.map-side .tab-panel')].find((e) => !(e as HTMLElement).hidden)!.getBoundingClientRect();
		return { scroll: document.documentElement.scrollHeight - innerHeight, mapTop: r('.map-body').top, mapH: r('.map-body').height, panelBottom: panel.bottom, sideBottom: r('.map-side').bottom };
	});
	expect(m.scroll).toBe(0);
	// The map starts right under the header (no notice lines between) and takes the rest of the window.
	expect(m.mapTop).toBeLessThan(160);
	expect(m.mapH).toBeGreaterThan(700);
	expect(m.panelBottom).toBeLessThanOrEqual(m.sideBottom + 0.5);

	await resizeTo(page, { width: 390, height: 844 });
	await expectNoSidewaysScroll(page);
	const map = (await page.locator('.map-body').boundingBox())!;
	for (const sel of ['[data-testid="map-tools"]', '[data-testid="map-layers-toggle"]', '[data-testid="map-key-toggle"]']) {
		const r = (await page.locator(sel).boundingBox())!;
		expect(r.x).toBeGreaterThanOrEqual(map.x);
		expect(r.x + r.width).toBeLessThanOrEqual(map.x + map.width + 0.5);
		expect(r.y + r.height).toBeLessThanOrEqual(map.y + map.height + 0.5);
	}
});

for (const scheme of ['light', 'dark'] as const) {
	for (const [label, size] of [
		['wide', { width: 1440, height: 960 }],
		['on a phone', { width: 390, height: 844 }]
	] as const) {
		test(`the map's panels and tools have no axe violations, ${scheme}, ${label}`, async ({ page, owner }) => {
			void owner;
			await page.emulateMedia({ colorScheme: scheme });
			await page.setViewportSize(size);
			await mapped(page, `Map layout axe ${scheme} ${label}`);
			await mapReady(page);
			await openKey(page);
			await expectNoViolations(page);
			await openLayers(page);
			await tool(page, 'Delineate').click();
			await expect(strip(page)).toBeVisible();
			await showTab(page, 'checks');
			await expectNoViolations(page);
			await expectNoSidewaysScroll(page);
		});
	}
}
