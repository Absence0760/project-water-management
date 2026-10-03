// The catchment map (issue #288, roadmap WP-3.12; laid out as a workspace in
// #326 E3–E6, D3; docs/ui.md § Map). An editor opens it from its sidebar row,
// uploads a synthetic boundary and parcels through the Upload sheet
// (`upload=1`), sees a projected file refused with its problem per feature,
// accepts a parcel's area from the picked feature's card and sees it in the
// run comparison's input diff; places a gauge through the Place sheet
// (`place=1`); reads Every feature (`grid=map-features`). The pick is in the
// URL (`feature=`, `node=`) and Back undoes it. Settings → WR2012 check looks
// up the quaternary under the boundary. A viewer gets no edit tools. The big
// case (30 units) fits the window with the list scrolling in its card. No
// assertion reads the map's pixels. Axe-scanned, light and dark, wide and phone.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { answerConfirm } from '../support/confirm.ts';
import { whatChanged } from '../support/compare.ts';
import { expect, test } from '../support/fixtures.ts';
import { boundaryGeoJson, damGeoJson, loadSyntheticQuaternaries, openMap, parcelsGeoJson, projectedGeoJson, seedBigMap, uploadThroughSheet } from '../support/map.ts';
import { expectNoSidewaysScroll, layoutSettled, resizeTo } from '../support/reflow.ts';

const header = (page: Page) => page.getByTestId('section-header');
const list = (page: Page) => page.getByTestId('map-feature-list');
const card = (page: Page) => page.getByTestId('map-feature-card');
const row = (page: Page, name: string) => list(page).getByRole('button', { name: new RegExp(`^${name}\\b`) });

test('an editor uploads a boundary and parcels, accepts an area from the card, and places a gauge', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Catchment map golden path');
	const before = await createRun(page.request, project.id, 'Before');

	// The Map has its own sidebar row, after the Network (#326 D3), and the Network's header still links to it.
	await page.goto(`/projects/${project.id}?tab=network`);
	await expect(header(page).getByRole('link', { name: 'Map', exact: true })).toBeVisible();
	const sections = page.getByRole('navigation', { name: 'Project sections' });
	await sections.getByRole('link', { name: 'Map', exact: true }).click();
	await expect(page).toHaveURL(/\?tab=map$/);
	await expect(sections.getByRole('link', { name: 'Map', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('.map-page[data-ready]')).toBeVisible();

	// One title (the header's), its line, and the one empty-state line.
	await expect(page.getByRole('heading', { name: /^Map/ })).toHaveCount(1);
	await expect(page.getByTestId('map-summary')).toHaveText('Nothing on the map yet');
	await expect(page.getByTestId('map-no-boundary')).toHaveCount(1);
	// The empty state leads with delineating (the e2e API has a DEM) and drawing (#326 D4); upload is the other way in.
	await expect(page.getByTestId('map-no-boundary')).toContainText('Nothing on the map yet. Start with the catchment: delineate it from its outlet on the river, or draw its boundary.');
	await expect(page.getByTestId('map-no-boundary').getByRole('button', { name: 'Delineate from the outlet' })).toBeVisible();
	await expect(page.getByTestId('map-no-boundary').getByRole('button', { name: 'Draw the boundary' })).toBeVisible();
	await expect(page.getByTestId('map-no-boundary').getByRole('link', { name: 'upload it as a GeoJSON file' })).toBeVisible();
	await expect(page.getByTestId('map-no-tiles')).toBeVisible();
	await expect(page.getByTestId('map-show-everything')).toHaveCount(0);

	// Upload opens a sheet in the URL; a projected file is refused with its problem per feature, and the sheet stays.
	await header(page).getByRole('link', { name: 'Upload GeoJSON' }).click();
	await expect(page).toHaveURL(/[?&]upload=1/);
	const sheet = page.getByRole('dialog', { name: 'Upload a GeoJSON file' });
	await uploadThroughSheet(page, null, 'lo19.geojson', projectedGeoJson(), false);
	const error = sheet.getByTestId('map-import-error');
	await expect(error).toContainText('The file was not imported. Fix these and upload it again:');
	await expect(error.getByRole('listitem')).toHaveText([/^Feature 1 has a coordinate .* looks projected .* reproject it to WGS84 \(EPSG:4326\)\.$/]);

	// The boundary: the sheet closes, the feature is picked (in the URL) and on the card, the header counts it.
	await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());
	await expect(page).not.toHaveURL(/upload=/);
	await expect(page).toHaveURL(/[?&]feature=[0-9a-f-]+/);
	await expect(card(page).getByRole('heading', { name: 'Synthetic catchment' })).toBeVisible();
	await expect(card(page)).toContainText(/Catchment boundary/);
	await expect(page.getByTestId('map-summary')).toHaveText(/^1 feature · boundary 10\d\.\d\d km² · 0 of 2 unit areas from the map$/);
	await expect(page.getByTestId('map-no-boundary')).toHaveCount(0);

	// Parcels, linked to the farms of the same name; the imported files sit in the upload sheet, hash cut to 12.
	await uploadThroughSheet(page, 'farm_parcel', 'parcels.geojson', parcelsGeoJson());
	await expect(list(page).getByRole('group', { name: /Farm parcels/ })).toBeVisible();
	await expect(row(page, 'Upper farm')).toContainText('linked · area typed');
	await header(page).getByRole('link', { name: 'Upload GeoJSON' }).click();
	await expect(sheet.getByTestId('map-source-hash')).toHaveText([/^[0-9a-f]{12}…$/, /^[0-9a-f]{12}…$/]);
	await sheet.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(page).not.toHaveURL(/upload=/);

	// Pick Upper farm; its card offers its area into the model, with the linked unit chosen.
	await row(page, 'Upper farm').click();
	await expect(card(page).getByRole('heading', { name: 'Upper farm' })).toBeVisible();
	await expect(card(page).getByLabel('What Upper farm stands for')).toHaveValue(/.+/);
	await expect(card(page).getByLabel('Hydrological unit to take Upper farm’s area')).toHaveValue(/.+/);
	await expect(card(page).getByTestId('map-card-area-source')).toHaveText(/Upper farm: 12\.000 km² · typed/);
	await card(page).getByRole('button', { name: /^Use \d+\.\d{3} km²$/ }).click();
	const dialog = page.getByRole('alertdialog', { name: 'Set Upper farm’s area from the map?' });
	await expect(dialog).toContainText('changes from 12.000 km² to');
	await dialog.getByRole('button', { name: 'Use this area' }).click();
	await expect(page.getByTestId('map-notice')).toContainText(/Upper farm’s area is now \d+\.\d{3} km², from the map\./);
	await expect(card(page).getByRole('button', { name: 'In use' })).toBeDisabled();
	await expect(card(page).getByTestId('map-card-area-source')).toContainText('From the map this farm parcel');
	await expect(row(page, 'Upper farm')).toContainText('area from the map');
	await expect(page.getByTestId('map-summary')).toContainText('1 of 2 unit areas from the map');

	// A dam's polygon is never a unit's catchment area: no area control on its card.
	await uploadThroughSheet(page, 'dam', 'dams.geojson', damGeoJson());
	await expect(card(page).getByRole('heading', { name: 'Upper dam' })).toBeVisible();
	await expect(card(page).getByRole('button', { name: /^Use / })).toHaveCount(0);
	await expect(card(page).getByRole('combobox', { name: /area$/ })).toHaveCount(0);

	// The list puts parcels first, then dams, the boundary last; each parcel group largest first.
	await expect(list(page).getByRole('heading', { level: 3 })).toHaveText([/^Farm parcels/, /^Dams/, /^Catchment boundary/]);
	await expect(list(page).getByRole('group', { name: /Farm parcels/ }).locator('.nm')).toHaveText(['Upper farm', 'Lower farm']);

	// Every feature: the table, with the area controls only on parcels, the units' area sources and the files.
	await page.getByTestId('map-open-grid').click();
	await expect(page).toHaveURL(/[?&]grid=map-features/);
	const grid = page.getByRole('dialog', { name: 'Every map feature' });
	const table = grid.getByTestId('map-feature-table');
	for (const name of ['Upper dam', 'Synthetic catchment']) {
		const r = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name }) });
		await expect(r).toBeVisible();
		await expect(r.getByRole('button', { name: /^Use / })).toHaveCount(0);
	}
	await expect(grid.getByTestId('map-area-sources').getByRole('listitem').filter({ hasText: 'Upper farm' })).toContainText('From the map “Upper farm”');
	await expect(grid.getByRole('link', { name: 'Settings → WR2012 check' })).toBeVisible();
	await expect(grid.getByTestId('map-sources').getByRole('listitem')).toHaveCount(3);
	// A row's name picks it and closes the grid.
	await table.getByRole('button', { name: 'Lower farm', exact: true }).click();
	await expect(grid).toBeHidden();
	await expect(page).not.toHaveURL(/grid=/);
	await expect(card(page).getByRole('heading', { name: 'Lower farm' })).toBeVisible();

	// A gauge by typed coordinates (#326 D1: behind the draw bar's Enter coordinates), with the form's own checks first.
	await header(page).getByRole('button', { name: 'Place a point' }).click();
	await page.getByTestId('map-draw-bar').getByRole('button', { name: 'Enter coordinates' }).click();
	await expect(page).toHaveURL(/[?&]place=1/);
	const place = page.getByRole('dialog', { name: 'Place a point' });
	await expect(place.locator('details')).toHaveAttribute('open', '');
	await place.getByRole('button', { name: 'Place the point' }).click();
	await expect(place.getByText('Enter the latitude.')).toBeVisible();
	await place.getByLabel('Name (optional)').fill('Weir pin');
	await place.getByLabel('Latitude').fill('33.62 S');
	await place.getByLabel('Longitude').fill('21.34');
	await place.getByRole('button', { name: 'Place the point' }).click();
	await expect(place).toBeHidden();
	await expect(page).not.toHaveURL(/place=/);
	await expect(card(page).getByRole('heading', { name: 'Weir pin' })).toBeVisible();
	await expect(row(page, 'Weir pin')).toContainText('33.6200° S, 21.3400° E');

	// The list picks with the keyboard; Back undoes a pick.
	await row(page, 'Upper farm').focus();
	await page.keyboard.press('Enter');
	await expect(row(page, 'Upper farm')).toHaveAttribute('aria-pressed', 'true');
	await expect(card(page).getByRole('heading', { name: 'Upper farm' })).toBeVisible();
	await page.goBack();
	await expect(card(page).getByRole('heading', { name: 'Weir pin' })).toBeVisible();
	await expect(row(page, 'Upper farm')).toHaveAttribute('aria-pressed', 'false');

	// Delete from the card asks first, then the pick goes.
	await row(page, 'Weir pin').click();
	await card(page).getByRole('button', { name: 'Delete Weir pin' }).click();
	await answerConfirm(page, true, 'Delete “Weir pin”?');
	await expect(row(page, 'Weir pin')).toHaveCount(0);
	await expect(page).not.toHaveURL(/feature=/);
	await expect(card(page)).toContainText('Select a feature on the map or in the list to see it here.');
	await expectNoViolations(page);

	// The area is an input like any other: the next run's comparison names it.
	const after = await createRun(page.request, project.id, 'After');
	await page.goto(`/projects/${project.id}?tab=compare&a=${project.id}:${before}&b=${project.id}:${after}`);
	const line = whatChanged(page).getByRole('listitem').filter({ hasText: /Upper farm: area 12 km² → \d+\.\d{3} km²/ });
	await expect(line).toContainText('Area of Upper farm from the map: “Upper farm”');
});

test('the URL picks: feature= and node= select, an unknown one picks nothing, old and over-another-tab links land', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Catchment map links');
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')!;
	await openMap(page, project.id);
	await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());
	await uploadThroughSheet(page, 'farm_parcel', 'parcels.geojson', parcelsGeoJson());
	await uploadThroughSheet(page, 'dam', 'dams.geojson', damGeoJson());
	// The dam stands for Upper farm too: node= takes the parcel, not the dam.
	await page.getByRole('combobox', { name: 'What Upper dam stands for' }).selectOption({ label: 'Upper farm' });
	await expect(row(page, 'Upper dam')).toContainText('Upper farm');

	await openMap(page, project.id, `&node=${upper.id}`);
	await expect(card(page).getByRole('heading', { name: 'Upper farm' })).toBeVisible();
	await expect(row(page, 'Upper farm')).toHaveAttribute('aria-pressed', 'true');
	// A pick from there replaces node= with feature=, and Back goes back to the node's pick.
	await row(page, 'Lower farm').click();
	await expect(page).toHaveURL(/[?&]feature=/);
	await expect(page).not.toHaveURL(/node=/);
	await page.goBack();
	await expect(page).toHaveURL(new RegExp(`node=${upper.id}`));
	await expect(card(page).getByRole('heading', { name: 'Upper farm' })).toBeVisible();

	const damId = await list(page).locator('li', { has: page.getByRole('button', { name: /^Upper dam/ }) }).getAttribute('data-feature');
	await openMap(page, project.id, `&feature=${damId}`);
	await expect(card(page).getByRole('heading', { name: 'Upper dam' })).toBeVisible();
	await openMap(page, project.id, '&feature=00000000-0000-0000-0000-000000000000');
	await expect(card(page)).toContainText('Select a feature on the map or in the list to see it here.');

	// The old alias and Every feature over another tab both land on the Map.
	await page.goto(`/projects/${project.id}?tab=gis`);
	await expect(page.locator('.map-page[data-ready]')).toBeVisible();
	await page.goto(`/projects/${project.id}?tab=network&grid=map-features`);
	await expect(page).toHaveURL(/tab=map/);
	await expect(page.getByRole('dialog', { name: 'Every map feature' })).toBeVisible();
	// Loaded directly, the grid stays open; Esc closes it in place.
	await page.keyboard.press('Escape');
	await expect(page).not.toHaveURL(/grid=/);
	await expect(page).toHaveURL(/tab=map/);
});

test('the quaternary under the boundary proposes the WR2012 values, one at a time, flagged synthetic', async ({ page, owner }) => {
	void owner;
	await loadSyntheticQuaternaries();
	const project = await seedRunnableProject(page.request, 'Catchment map quaternary');
	const at = `/projects/${project.id}`;
	await openMap(page, project.id);
	await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());

	await page.goto(`${at}?tab=settings`);
	await page.getByLabel('Compare runs with WR2012 naturalised flow').check();
	await page.getByRole('button', { name: 'Propose from the map' }).click();
	const proposal = page.getByTestId('quaternary-proposal');
	await expect(proposal.getByLabel('Look up at')).toHaveValue(/.+/);
	await proposal.getByRole('button', { name: 'Look up the quaternary' }).click();
	await expect(proposal.getByTestId('quaternary-code')).toHaveText('Z01B');
	await expect(proposal.getByTestId('quaternary-synthetic')).toContainText('Synthetic test data.');
	await expect(proposal).toContainText('Source: SYNTHETIC test data');

	// Nothing is filled until asked: the MAP field is still blank, then takes only the MAP.
	const mapField = page.getByLabel('Quaternary MAP (mm, optional)', { exact: true });
	await expect(mapField).toHaveValue('');
	const rows = proposal.getByTestId('quaternary-rows');
	await rows.getByRole('button', { name: 'Use the proposed quaternary map (mm)' }).click();
	await expect(mapField).toHaveValue('540');
	await expect(page.getByLabel('Quaternary area (km²)', { exact: true })).toHaveValue('');
	await expect(rows.getByRole('row').filter({ hasText: 'Quaternary MAP (mm)' })).toContainText('Used');
	await expectNoViolations(page);
});

test('an editor marks a dam outline off-channel in its card, kept across a reload; a viewer reads it; a point dam isn’t asked (194)', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Catchment map dam siting');
	await openMap(page, project.id);
	await uploadThroughSheet(page, 'dam', 'dams.geojson', damGeoJson());
	await row(page, 'Upper dam').click();
	const siting = card(page).getByRole('combobox', { name: 'Where Upper dam stands against its river' });
	await expect(siting).toHaveValue('');
	await expect(siting.locator('option:checked')).toHaveText('Not said (from its outline)');
	await expect(card(page)).toContainText('Start and Divide take only an off-channel dam’s own catchment into it, the river passing it by; unsaid, its outline decides.');
	const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/map\/features\//.test(r.url()));
	await siting.selectOption({ label: 'Off-channel (filled by a pump or a furrow)' });
	expect((await saved).status()).toBe(200);
	await expect(siting).toHaveValue('off_channel');
	await expect(siting).toBeEnabled();
	await page.reload();
	await expect(page.locator('.map-page[data-ready]')).toBeVisible();
	await expect(card(page).getByRole('combobox', { name: 'Where Upper dam stands against its river' })).toHaveValue('off_channel');
	await expectNoViolations(page);

	// A viewer reads the siting as words, with nothing to change.
	const viewer = await signIn('Dam siting viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.goto(page.url());
	await expect(v.locator('.map-page[data-ready]')).toBeVisible();
	await expect(card(v).getByRole('heading', { name: 'Upper dam' })).toBeVisible();
	await expect(card(v).getByTestId('map-dam-position')).toHaveText('Off-channel (filled by a pump or a furrow)');
	await expect(card(v).getByRole('combobox')).toHaveCount(0);

	// A dam placed as a point has no outline to place by: its card doesn't ask.
	const point = await page.request.post(`${API_URL}/projects/${project.id}/map/features`, { data: { kind: 'dam', name: 'Point dam', lon: 21.33, lat: -33.65 } });
	expect(point.status()).toBe(201);
	await page.reload();
	await expect(page.locator('.map-page[data-ready]')).toBeVisible();
	await row(page, 'Point dam').click();
	await expect(card(page).getByRole('heading', { name: 'Point dam' })).toBeVisible();
	await expect(card(page).getByTestId('map-dam-position')).toHaveCount(0);
});

test('a viewer sees the map, its sidebar row, the list, the card and Every feature, but no edit tools', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Catchment map viewer');
	await openMap(page, project.id);
	await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());
	await uploadThroughSheet(page, 'farm_parcel', 'parcels.geojson', parcelsGeoJson());
	const viewer = await signIn('Map viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.goto(`/projects/${project.id}`);
	await v.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Map', exact: true }).click();
	await expect(v.locator('.map-page[data-ready]')).toBeVisible();
	await expect(row(v, 'Synthetic catchment')).toBeVisible();
	await expect(v.getByTestId('map-show-everything')).toBeVisible();
	await expect(header(v).getByRole('link', { name: 'Upload GeoJSON' })).toHaveCount(0);
	await expect(header(v).getByRole('button', { name: 'Place a point' })).toHaveCount(0);
	await expect(header(v).getByRole('button', { name: 'Draw a shape' })).toHaveCount(0);
	await expect(v.getByTestId('map-no-tiles')).toHaveCount(0);
	await row(v, 'Upper farm').click();
	await expect(card(v).getByRole('heading', { name: 'Upper farm' })).toBeVisible();
	await expect(card(v).getByRole('combobox')).toHaveCount(0);
	await expect(card(v).getByRole('button', { name: /^Delete / })).toHaveCount(0);
	await expect(card(v).getByRole('button', { name: 'Edit the shape' })).toHaveCount(0);
	// A sheet's link does nothing for a viewer: the param goes.
	await v.goto(`/projects/${project.id}?tab=map&upload=1`);
	await expect(v.locator('.map-page[data-ready]')).toBeVisible();
	await expect(v).not.toHaveURL(/upload=/);
	await expect(v.getByRole('dialog', { name: 'Upload a GeoJSON file' })).toHaveCount(0);
	// Every feature reads the same rows, with the files, and no controls.
	await v.getByTestId('map-open-grid').click();
	const grid = v.getByRole('dialog', { name: 'Every map feature' });
	await expect(grid.getByTestId('map-feature-table').getByRole('rowheader')).toHaveText(['Upper farm', 'Lower farm', 'Synthetic catchment']);
	await expect(grid.getByRole('combobox')).toHaveCount(0);
	await expect(grid.getByTestId('map-sources')).toContainText('parcels.geojson');
	await expectNoViolations(v);
});

test('thirty units: the page fits the window, the list scrolls in its card, a linked pick is in view; the phone stacks', async ({ page, owner }) => {
	void owner;
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 1440, height: 960 });
	const big = await seedBigMap(page.request, 'Catchment map thirty');
	// Pick one of the smallest parcels, far down the list, from the URL.
	await openMap(page, big.id, `&node=${big.farms[28]}`);
	await expect(card(page).getByRole('heading', { name: 'Hydrological unit with a long name 29' })).toBeVisible();
	await expect(page.getByTestId('map-summary')).toHaveText(/^35 features · boundary [\d\s,.]+ km² · 0 of 30 unit areas from the map$/);
	await layoutSettled(page);
	const m = await page.evaluate(() => {
		const scroller = document.querySelector('[data-testid="map-feature-list"]') as HTMLElement;
		const layout = document.querySelector('.map-layout') as HTMLElement;
		return {
			pageScroll: document.documentElement.scrollHeight - innerHeight,
			listScrolls: scroller.scrollHeight > scroller.clientHeight,
			overflowY: getComputedStyle(scroller).overflowY,
			gapBelow: innerHeight - layout.getBoundingClientRect().bottom
		};
	});
	expect(m.pageScroll).toBe(0);
	expect(m.listScrolls).toBe(true);
	expect(m.overflowY).toBe('auto');
	// The layout reaches the window's foot, less the 1rem gutter.
	expect(m.gapBelow).toBeGreaterThanOrEqual(12);
	expect(m.gapBelow).toBeLessThanOrEqual(16);
	await expect(row(page, 'Hydrological unit with a long name 29')).toBeInViewport({ ratio: 1 });
	await expect(page.getByTestId('catchment-map')).toBeInViewport({ ratio: 1 });

	await resizeTo(page, { width: 390, height: 844 });
	await expectNoSidewaysScroll(page);
	// Stacked: a pick from the list brings the card above it into view.
	await row(page, 'Hydrological unit with a long name 30').click();
	await expect(card(page).getByRole('heading', { name: 'Hydrological unit with a long name 30' })).toBeInViewport();
});

for (const scheme of ['light', 'dark'] as const) {
	for (const [label, size] of [
		['wide', { width: 1440, height: 960 }],
		['on a phone', { width: 390, height: 844 }]
	] as const) {
		test(`the Map tab has no axe violations, ${scheme}, ${label}`, async ({ page, owner }) => {
			void owner;
			await page.emulateMedia({ colorScheme: scheme });
			await page.setViewportSize(size);
			const project = await seedRunnableProject(page.request, `Catchment map axe ${scheme} ${label}`);
			await openMap(page, project.id);
			await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());
			await uploadThroughSheet(page, 'farm_parcel', 'parcels.geojson', parcelsGeoJson());
			await row(page, 'Upper farm').click();
			await expect(card(page).getByRole('heading', { name: 'Upper farm' })).toBeVisible();
			await layoutSettled(page);
			await expectNoSidewaysScroll(page);
			await expectNoViolations(page);
			await page.getByTestId('map-open-grid').click();
			await expect(page.getByRole('dialog', { name: 'Every map feature' })).toBeVisible();
			await expectNoViolations(page);
		});
	}
}
