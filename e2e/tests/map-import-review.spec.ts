// A GeoJSON file mixing feature kinds, reviewed before it is saved (issue
// #326 D2; docs/maps.md § Uploads, docs/ui.md § Map). The upload sheet reads
// the file on the server, proposes each feature's kind (from a `layer`
// property, else from its shape: the largest polygon round the rest is the
// boundary) and the node it stands for, and lets the editor change any row
// before Import. A file with a refused feature lists its problem on the row
// and imports nothing. The list, never the map's pixels, says what went in.
// Synthetic data only: the sample model's names and invented boxes.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { box, geoFile, openMap } from '../support/map.ts';
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

const sheetOf = (page: Page) => page.getByRole('dialog', { name: 'Upload a GeoJSON file' });

async function review(page: Page, name: string, text: string) {
	const sheet = sheetOf(page);
	if (!(await sheet.isVisible())) await page.getByTestId('section-header').getByRole('link', { name: 'Upload GeoJSON' }).click();
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
