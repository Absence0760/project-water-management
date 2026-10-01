// The catchment map (issue #288, roadmap WP-3.12; docs/ui.md § Catchment
// map): an editor uploads a synthetic catchment boundary and sees it listed,
// sees a projected file refused with its problem per feature, imports farm
// parcels (linked by name), accepts a parcel's area into a hydrological unit
// and sees it in the run comparison's input diff; places a gauge from typed
// coordinates; and, in Settings → WR2012 check, looks up the quaternary under
// the boundary (the synthetic dataset, flagged as such) and uses its MAP one
// value at a time. Everything works from the list and forms: no assertion
// reads the map's pixels, and without WebGL the map says so and the flow is
// the same. A viewer gets no edit tools. Axe-scanned, light, dark and phone.
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { whatChanged } from '../support/compare.ts';
import { expect, test } from '../support/fixtures.ts';
import { boundaryGeoJson, loadSyntheticQuaternaries, parcelsGeoJson, projectedGeoJson } from '../support/map.ts';

const upload = (name: string, text: string) => ({ name, mimeType: 'application/geo+json', buffer: Buffer.from(text) });

test('an editor uploads a boundary and parcels, accepts an area into the model, and places a gauge', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Catchment map golden path');
	const before = await createRun(page.request, project.id, 'Before');

	await page.goto(`/projects/${project.id}?tab=map`);
	await expect(page.getByTestId('map-no-boundary')).toContainText('No catchment boundary yet.');
	await expect(page.getByTestId('map-no-tiles')).toBeVisible();

	// A projected file is refused, with the problem per feature, and nothing is added.
	const file = page.getByLabel(/^GeoJSON file/);
	await file.setInputFiles(upload('lo19.geojson', projectedGeoJson()));
	await page.getByRole('button', { name: 'Upload', exact: true }).click();
	const error = page.getByTestId('map-import-error');
	await expect(error).toContainText('The file was not imported. Fix these and upload it again:');
	await expect(error.getByRole('listitem')).toHaveText([/^Feature 1 has a coordinate .* looks projected .* reproject it to WGS84 \(EPSG:4326\)\.$/]);

	// The boundary: listed, measured on the server.
	await file.setInputFiles(upload('boundary.geojson', boundaryGeoJson()));
	await page.getByRole('button', { name: 'Upload', exact: true }).click();
	await expect(page.getByTestId('map-notice')).toContainText('Imported 1 feature from boundary.geojson.');
	await expect(page.getByTestId('map-no-boundary')).toBeHidden();
	const list = page.getByTestId('map-feature-list');
	await expect(list.getByRole('button', { name: 'Synthetic catchment' })).toBeVisible();
	await expect(list).toContainText(/Catchment boundary · 10\d\.\d\d km²/);

	// Parcels, linked to the farms of the same name.
	await page.getByLabel('The file holds').selectOption('farm_parcel');
	await file.setInputFiles(upload('parcels.geojson', parcelsGeoJson()));
	await page.getByRole('button', { name: 'Upload', exact: true }).click();
	await expect(page.getByTestId('map-notice')).toContainText('Imported 2 features from parcels.geojson.');
	const table = page.getByTestId('map-feature-table');
	const upperRow = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Upper farm' }) });
	await expect(upperRow.getByLabel('What Upper farm stands for')).toHaveValue(/.+/);

	// Accept the parcel's area into Upper farm: a confirmed model change.
	await expect(upperRow.getByLabel('Hydrological unit to take Upper farm’s area')).toHaveValue(/.+/);
	await upperRow.getByRole('button', { name: /^Use \d+\.\d{3} km²$/ }).click();
	const dialog = page.getByRole('alertdialog', { name: 'Set Upper farm’s area from the map?' });
	await expect(dialog).toContainText('changes from 12.000 km² to');
	await dialog.getByRole('button', { name: 'Use this area' }).click();
	await expect(page.getByTestId('map-notice')).toContainText(/Upper farm’s area is now \d+\.\d{3} km², from the map\./);
	await expect(upperRow.getByRole('button', { name: 'In use' })).toBeDisabled();
	await expect(page.getByTestId('map-area-sources').getByRole('listitem').filter({ hasText: 'Upper farm' })).toContainText('From the map “Upper farm”');

	// A gauge from typed coordinates, with the form's own checks first.
	await page.getByRole('button', { name: 'Place the point' }).click();
	await expect(page.getByText('Enter the latitude.')).toBeVisible();
	await page.getByLabel('Name (optional)').fill('Weir pin');
	await page.getByLabel('Latitude').fill('33.62 S');
	await page.getByLabel('Longitude').fill('21.34');
	await page.getByRole('button', { name: 'Place the point' }).click();
	await expect(list.getByRole('button', { name: 'Weir pin' })).toBeVisible();
	await expect(list).toContainText('33.6200° S, 21.3400° E');

	// The list selects with the keyboard.
	await list.getByRole('button', { name: 'Weir pin' }).focus();
	await page.keyboard.press('Enter');
	await expect(list.getByRole('button', { name: 'Weir pin' })).toHaveAttribute('aria-pressed', 'true');
	await expectNoViolations(page);

	// The area is an input like any other: the next run's comparison names it.
	const after = await createRun(page.request, project.id, 'After');
	await page.goto(`/projects/${project.id}?tab=compare&a=${project.id}:${before}&b=${project.id}:${after}`);
	// The diff line names the change, and the history's reason names the feature it came from.
	const line = whatChanged(page).getByRole('listitem').filter({ hasText: /Upper farm: area 12 km² → \d+\.\d{3} km²/ });
	await expect(line).toContainText('Area of Upper farm from the map: “Upper farm”');
});

test('the quaternary under the boundary proposes the WR2012 values, one at a time, flagged synthetic', async ({ page, owner }) => {
	void owner;
	await loadSyntheticQuaternaries();
	const project = await seedRunnableProject(page.request, 'Catchment map quaternary');
	const at = `/projects/${project.id}`;
	await page.goto(`${at}?tab=map`);
	await page.getByLabel(/^GeoJSON file/).setInputFiles(upload('boundary.geojson', boundaryGeoJson()));
	await page.getByRole('button', { name: 'Upload', exact: true }).click();
	await expect(page.getByTestId('map-notice')).toContainText('Imported 1 feature');

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

test('a viewer sees the map and its list but no edit tools', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Catchment map viewer');
	await page.goto(`/projects/${project.id}?tab=map`);
	await page.getByLabel(/^GeoJSON file/).setInputFiles(upload('boundary.geojson', boundaryGeoJson()));
	await page.getByRole('button', { name: 'Upload', exact: true }).click();
	await expect(page.getByTestId('map-notice')).toContainText('Imported 1 feature');
	const viewer = await signIn('Map viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=map`);
	await expect(viewer.page.getByTestId('map-feature-list').getByRole('button', { name: 'Synthetic catchment' })).toBeVisible();
	await expect(viewer.page.getByRole('button', { name: 'Upload', exact: true })).toHaveCount(0);
	await expect(viewer.page.getByRole('button', { name: 'Place the point' })).toHaveCount(0);
	await expect(viewer.page.getByRole('button', { name: /^Delete / })).toHaveCount(0);
});

for (const scheme of ['light', 'dark'] as const) {
	test(`the Catchment map tab has no axe violations, ${scheme}, on a phone`, async ({ page, owner }) => {
		void owner;
		await page.emulateMedia({ colorScheme: scheme });
		await page.setViewportSize({ width: 390, height: 844 });
		const project = await seedRunnableProject(page.request, `Catchment map axe ${scheme}`);
		await page.goto(`/projects/${project.id}?tab=map`);
		await page.getByLabel(/^GeoJSON file/).setInputFiles(upload('boundary.geojson', boundaryGeoJson()));
		await page.getByRole('button', { name: 'Upload', exact: true }).click();
		await expect(page.getByTestId('map-notice')).toContainText('Imported 1 feature');
		await expectNoViolations(page);
	});
}
