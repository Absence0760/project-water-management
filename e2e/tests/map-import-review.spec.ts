// A GeoJSON file mixing feature kinds, reviewed before it is saved (issue
// #326 D2; docs/maps.md § Uploads, docs/ui.md § Map). The upload sheet reads
// the file on the server, proposes each feature's kind (from a `layer`
// property, else from its shape: the largest polygon round the rest is the
// boundary) and the node it stands for, and lets the editor change any row
// before Import. A file with a refused feature lists its problem on the row
// and imports nothing. A row marked as the boundary while the project has one
// warns that it replaces it, and Import waits for "Replace the current
// boundary". The list, never the map's pixels, says what went in.
// Synthetic data only: the sample model's names and invented boxes.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { boundaryGeoJson, box, geoFile, openMap, openUploadSheet, showTab, uploadThroughSheet } from '../support/map.ts';
import { expectNoSidewaysScroll, resizeTo } from '../support/reflow.ts';

const poly = (name: string, ring: [number, number][]) => ({ type: 'Feature', properties: { name }, geometry: { type: 'Polygon', coordinates: [ring] } });
/** A boundary round two parcels named like the sample model's farms, a river (its `layer` says so) and a gauge. No kind on the polygons. */
const mixed = JSON.stringify({
	type: 'FeatureCollection',
	features: [
		poly('Upper farm', box(21.31, -33.69, 0.03)),
		poly('Lower farm', box(21.36, -33.69, 0.02)),
		poly('Mixed catchment', box(21.3, -33.7, 0.1)),
		{ type: 'Feature', properties: { name: 'Mixed river', layer: 'Streams' }, geometry: { type: 'LineString', coordinates: [[21.31, -33.68], [21.39, -33.61]] } },
		{ type: 'Feature', properties: { name: 'Outflow gauge' }, geometry: { type: 'Point', coordinates: [21.39, -33.61] } }
	]
});
/** One fine parcel and one feature in projected metres. */
const halfRefused = JSON.stringify({
	type: 'FeatureCollection',
	features: [poly('Fine parcel', box(21.32, -33.66, 0.01)), { type: 'Feature', properties: { name: 'Projected' }, geometry: { type: 'Point', coordinates: [-45_000, 3_700_000] } }]
});


async function review(page: Page, name: string, text: string) {
	const sheet = await openUploadSheet(page);
	await sheet.getByLabel(/^GeoJSON file/).setInputFiles(geoFile(name, text));
	await sheet.getByRole('button', { name: 'Review', exact: true }).click();
	await expect(sheet.getByTestId('map-review-table')).toBeVisible();
	return sheet;
}

test('a mixed file: the review proposes each kind, one is changed, and the list shows them grouped', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Mixed map import');
	await openMap(page, project.id);
	const sheet = await review(page, 'mixed.geojson', mixed);

	// The proposals: by shape, the river from its layer; the parcels and gauge linked by name. Nothing saved yet.
	await expect(sheet.getByTestId('map-review-summary')).toContainText('5 features (1 catchment boundary, 2 farm parcels, 1 gauge, 1 river)');
	for (const [i, kind, from] of [
		[1, 'farm_parcel', 'from its shape'],
		[2, 'farm_parcel', 'from its shape'],
		[3, 'catchment_boundary', 'from its shape'],
		[4, 'river', 'from the file'],
		[5, 'gauge', 'from its shape']
	] as const) {
		await expect(sheet.getByLabel(`Kind of feature ${i}`)).toHaveValue(kind);
		await expect(sheet.getByTestId('map-review-row').nth(i - 1)).toContainText(from);
	}
	await expect(sheet.getByLabel('What feature 1 stands for').locator('option:checked')).toHaveText('Upper farm');
	await expect(sheet.getByLabel('What feature 5 stands for').locator('option:checked')).toHaveText('Outflow gauge');
	// A river stands for no node, and its kind offers only what a line can be.
	await expect(sheet.getByLabel('What feature 4 stands for')).toHaveCount(0);
	await expect(sheet.getByLabel('Kind of feature 4').locator('option')).toHaveText(['River', 'Other']);
	await expect(page.getByTestId('map-summary')).toHaveText('Nothing on the map yet');
	// No boundary yet: the boundary row replaces nothing, so no warning and no tick.
	await expect(sheet.getByTestId('map-import-replaces')).toHaveCount(0);
	await expectNoViolations(page);

	// Lower farm's polygon becomes a dam (still standing for Lower farm), renamed.
	await sheet.getByLabel('Kind of feature 2').selectOption('dam');
	await expect(sheet.getByLabel('What feature 2 stands for').locator('option:checked')).toHaveText('Lower farm');
	await sheet.getByLabel('Name of feature 2').fill('Lower dam');
	// Two boundaries are refused before the server sees them; set back, the parcel's link is chosen again.
	await sheet.getByLabel('Kind of feature 1').selectOption('catchment_boundary');
	await expect(sheet.getByTestId('map-import-error')).toContainText('A file holds at most one catchment boundary; features 1, 3 are each marked as one.');
	await expect(sheet.getByRole('button', { name: /^Import / })).toBeDisabled();
	await sheet.getByLabel('Kind of feature 1').selectOption('farm_parcel');
	await expect(sheet.getByTestId('map-import-error')).toHaveCount(0);
	await sheet.getByLabel('What feature 1 stands for').selectOption({ label: 'Upper farm' });

	await sheet.getByRole('button', { name: 'Import 5 features' }).click();
	await expect(page.getByTestId('map-notice')).toContainText('Imported 5 features from mixed.geojson.');
	await expect(sheet).toBeHidden();
	await showTab(page, 'features');
	const list = page.getByTestId('map-feature-list');
	await expect(list.getByRole('heading', { level: 3 })).toHaveText([/^Farm parcels/, /^Dams/, /^Gauges/, /^Rivers/, /^Catchment boundary/]);
	for (const [group, name] of [
		['Farm parcels', 'Upper farm'],
		['Dams', 'Lower dam'],
		['Gauges', 'Outflow gauge'],
		['Rivers', 'Mixed river'],
		['Catchment boundary', 'Mixed catchment']
	] as const)
		await expect(list.getByRole('group', { name: new RegExp(group) }).locator('.nm')).toHaveText([name]);
});

test('a refused feature lists its problem on its row, and the file imports nothing; on a phone each row is a card', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Refused map import');
	await openMap(page, project.id);
	const sheet = await review(page, 'half.geojson', halfRefused);
	await expect(sheet.getByTestId('map-import-error')).toContainText('The file was not imported. Fix these and upload it again:');
	await expect(sheet.getByTestId('map-import-error').getByRole('listitem')).toHaveText([/^Feature 2 has a coordinate .* looks projected/]);
	const refused = sheet.getByTestId('map-review-row').nth(1);
	await expect(refused).toContainText(/It has a coordinate .* looks projected/);
	await expect(refused.getByRole('combobox')).toHaveCount(0);
	await expect(sheet.getByRole('button', { name: 'Import 1 feature' })).toBeDisabled();

	// A phone: the table's header row is gone, each row a card with its fields labelled; nothing scrolls sideways.
	await resizeTo(page, { width: 390, height: 844 });
	await expect(sheet.getByRole('columnheader', { name: 'Kind' })).toBeHidden();
	await expect(sheet.getByLabel('Kind of feature 1')).toBeVisible();
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page);

	await sheet.getByRole('button', { name: 'Choose another file' }).click();
	await expect(sheet.getByLabel(/^GeoJSON file/)).toBeVisible();
	await sheet.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(page.getByTestId('map-summary')).toHaveText('Nothing on the map yet');
});

test('a row marked as the boundary while the project has one warns, and Import waits for the Replace tick', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Replace boundary import');
	await openMap(page, project.id);
	await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson('First catchment'));
	const sheet = await review(page, 'wider.geojson', JSON.stringify({ type: 'FeatureCollection', features: [poly('Wider catchment', box(21.29, -33.71, 0.12))] }));

	// A lone polygon isn't proposed as the boundary while there is one: nothing to warn about.
	await expect(sheet.getByLabel('Kind of feature 1')).toHaveValue('farm_parcel');
	await expect(sheet.getByTestId('map-import-replaces')).toHaveCount(0);
	const importButton = sheet.getByRole('button', { name: 'Import 1 feature' });
	await expect(importButton).toBeEnabled();

	// Marked as the boundary: the warning names the current one, the tick is off and Import waits for it.
	await sheet.getByLabel('Kind of feature 1').selectOption('catchment_boundary');
	const warning = sheet.getByTestId('map-import-replaces');
	await expect(warning.getByRole('paragraph')).toHaveText('Importing replaces the current catchment boundary “First catchment”: it goes from the map.');
	const tick = warning.getByRole('checkbox', { name: 'Replace the current boundary' });
	await expect(tick).not.toBeChecked();
	await expect(importButton).toBeDisabled();
	await expectNoViolations(page);
	// Set back to a parcel, the warning goes; marked again, it is back with the Import still waiting.
	await sheet.getByLabel('Kind of feature 1').selectOption('farm_parcel');
	await expect(warning).toHaveCount(0);
	await sheet.getByLabel('Kind of feature 1').selectOption('catchment_boundary');
	await expect(importButton).toBeDisabled();

	await tick.check();
	await expect(importButton).toBeEnabled();
	await importButton.click();
	await expect(page.getByTestId('map-notice')).toContainText('Imported 1 feature from wider.geojson.');
	await expect(sheet).toBeHidden();
	await showTab(page, 'features');
	await expect(page.getByTestId('map-feature-list').getByRole('group', { name: /Catchment boundary/ }).locator('.nm')).toHaveText(['Wider catchment']);
});

/** Thirty parcels with long names, every third with its kind in the file. */
const thirty = JSON.stringify({
	type: 'FeatureCollection',
	features: Array.from({ length: 30 }, (_, i) => ({
		type: 'Feature',
		properties: { name: `Parcel ${i + 1} with a fairly long field name`, ...(i % 3 === 0 ? { kind: 'farm_parcel' } : {}) },
		geometry: { type: 'Polygon', coordinates: [box(21.31 + (i % 6) * 0.012, -33.69 + Math.floor(i / 6) * 0.012, 0.01)] }
	}))
});

test('thirty features: whole names, no column of “None”, a header row that stays, and short cards on a phone (issue #521)', async ({ page, owner }) => {
	test.setTimeout(60_000);
	void owner;
	const project = await seedRunnableProject(page.request, 'Thirty features');
	await page.setViewportSize({ width: 1440, height: 960 });
	await openMap(page, project.id);
	const sheet = await review(page, 'thirty.geojson', thirty);
	const table = sheet.getByTestId('map-review-table');
	// No row has a problem: no Problems column, and the name gets the room (14rem, 196 px).
	await expect(table.getByRole('columnheader')).toHaveText(['#', 'Name', 'Shape', 'Kind', 'Stands for']);
	expect((await sheet.getByLabel('Name of feature 1', { exact: true }).boundingBox())!.width).toBeGreaterThanOrEqual(196);
	// Where a kind came from: said once in the summary for the file's own, under a row only when it is a guess, and
	// always the row's description for a screen reader.
	await expect(sheet.getByTestId('map-review-summary')).toContainText('Kinds come from the file’s properties, else from each shape.');
	// Visually hidden (a 1 px box, which Playwright counts as visible).
	expect((await sheet.getByTestId('map-review-row').nth(0).getByText('from the file').boundingBox())!.width).toBeLessThanOrEqual(1);
	await expect(sheet.getByLabel('Kind of feature 1', { exact: true })).toHaveAccessibleDescription('from the file');
	await expect(sheet.getByTestId('map-review-row').nth(1).getByText('from its shape')).toBeVisible();
	// The cells top-aligned, the number with them.
	const row = sheet.getByTestId('map-review-row').first();
	expect(Math.abs((await row.getByRole('rowheader').boundingBox())!.y - (await row.getByRole('cell').first().boundingBox())!.y)).toBeLessThan(2);
	// Scrolled to the last rows, the column names are still at the top of the sheet's scroll.
	await sheet.getByLabel('Name of feature 28', { exact: true }).scrollIntoViewIfNeeded();
	const head = (await table.getByRole('columnheader', { name: 'Kind' }).boundingBox())!;
	const firstRow = (await sheet.getByLabel('Name of feature 1', { exact: true }).boundingBox())!;
	expect(head.y).toBeGreaterThan(firstRow.y + firstRow.height);
	await expect(table.getByRole('columnheader', { name: 'Kind' })).toBeInViewport();
	await expectNoViolations(page);

	// A phone: each feature a card under 200 px (it was 352), its first line the number and shape, Kind and Stands
	// for side by side, no Problems line.
	for (const size of [{ width: 390, height: 844 }, { width: 360, height: 740 }, { width: 320, height: 640 }]) {
		await resizeTo(page, size);
		const card = sheet.getByTestId('map-review-row').first();
		const b = (await card.boundingBox())!;
		expect(b.height, `${size.width} px`).toBeLessThanOrEqual(size.width >= 360 ? 200 : 260);
		const num = (await card.getByRole('rowheader').boundingBox())!;
		const shape = (await card.getByText(/^Polygon, /).boundingBox())!;
		expect(Math.abs(num.y - shape.y), `${size.width} px`).toBeLessThan(4);
		if (size.width >= 360) expect(Math.abs((await card.getByLabel('Kind of feature 1', { exact: true }).boundingBox())!.y - (await card.getByLabel('What feature 1 stands for', { exact: true }).boundingBox())!.y)).toBeLessThan(2);
		await expect(card.getByText('None')).toHaveCount(0);
		await expectNoSidewaysScroll(page);
	}
	await expectNoViolations(page);
});

test('a file nothing in can be imported says so once and leaves Choose another file as the one action', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Nothing to import');
	for (const size of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
		await page.setViewportSize(size);
		await openMap(page, project.id, '&upload=1');
		const sheet = page.getByRole('dialog', { name: 'Upload a GeoJSON file' });
		// The empty sheet: one short line under the file field; the rest stays its description.
		await expect(sheet.locator('.hint').first()).toHaveText(/^WGS84 longitude and latitude; a file in a Lo zone or UTM is refused\./);
		await expect(sheet.getByLabel(/^GeoJSON file/)).toHaveAccessibleDescription(/reproject it first \(QGIS: Export → Save Features As, CRS EPSG:4326\)/);
		await sheet.getByLabel(/^GeoJSON file/).setInputFiles(geoFile('lo19.geojson', JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-45_000, 3_700_000] } }] })));
		await sheet.getByRole('button', { name: 'Review', exact: true }).click();
		await expect(sheet.getByTestId('map-review-summary')).toContainText('Nothing in this file can be imported.');
		await expect(sheet.getByTestId('map-review-summary')).not.toContainText('Check each kind');
		await expect(sheet.getByTestId('map-import-error').getByRole('listitem')).toHaveText([/^Feature 1 has a coordinate .* looks projected/]);
		// The problem once: no table repeating it.
		await expect(sheet.getByTestId('map-review-table')).toHaveCount(0);
		await expect(sheet.getByRole('button', { name: /^Import / })).toHaveCount(0);
		await expect(sheet.getByRole('button', { name: 'Choose another file' })).toHaveClass(/btn-primary/);
		await expectNoSidewaysScroll(page);
		await expectNoViolations(page);
		await sheet.getByRole('button', { name: 'Choose another file' }).click();
		await expect(sheet.getByLabel(/^GeoJSON file/)).toBeVisible();
	}
});
