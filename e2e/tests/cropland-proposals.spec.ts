// A unit's planted-areas drawer → "From land cover" (issue #326 B-landcover;
// docs/ui.md § Farm drawer, docs/maps.md § Cultivated area from land cover). A unit's parcels on
// the map are summed over the committed synthetic land-cover grid (every cell
// half cropland where these parcels lie); the editor picks the area (all
// parcels or one) and the crop, Use asks first and saves that one value, and
// History cites the dataset. A viewer reads the summary but can't use it. The
// tables are read, never the map's pixels. Invented data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, seedRunnableProject } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { loadSyntheticLandCover } from '../support/landCover.ts';
import { box } from '../support/map.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const panel = (page: Page) => page.getByTestId('cropland-proposals');
const cropRow = (page: Page, crop: string) => panel(page).locator(`tr[data-crop="${crop}"]`);

/** The Crops page with `nodeId`'s drawer open and its land-cover summary loaded. */
async function openBox(page: Page, projectId: string, nodeId: string, unit: string, parcels = true) {
	await page.goto(`/projects/${projectId}?tab=crops&farm=${nodeId}`);
	await expect(page.getByRole('dialog', { name: `${unit}: planted areas` })).toBeVisible();
	await expect(panel(page).getByTestId('cropland-body')).toHaveAttribute('data-ready', 'true');
	if (parcels) await expect(panel(page).getByTestId('cropland-parcels').locator('caption')).toHaveText(`Cultivated area in ${unit}’s parcels on the map`);
}

/** Two parcels of `nodeId` in the synthetic grid's half-cropland block (`suffix` after their names, for a second unit's). */
async function drawParcels(page: Page, projectId: string, nodeId: string, suffix = '') {
	for (const [name, ring] of [
		['Lower lands', box(21.31, -33.69, 0.01)],
		['Top camp', box(21.33, -33.67, 0.005)]
	] as const) {
		const made = await page.request.post(`${API_URL}/projects/${projectId}/map/features`, {
			data: { kind: 'farm_parcel', name: `${name}${suffix}`, nodeId, geometry: { type: 'Polygon', coordinates: [ring] } }
		});
		expect(made.status(), await made.text()).toBe(201);
	}
}

test.beforeAll(async () => {
	await loadSyntheticLandCover();
});

test('a Use that answers after Back moved the drawer to another unit leaves the box on that unit and the keyboard where it was', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Cropland proposals use race');
	const idOf = (name: string) => String(project.model.nodes.find((n) => n.name === name)!.id);
	await drawParcels(page, project.id, idOf('Upper farm'));
	// Lower farm's drawer, then Upper farm's by a client-side step (a farm= link), so Back returns to Lower farm's
	// with the drawer, and its proposals box, still mounted.
	await openBox(page, project.id, idOf('Lower farm'), 'Lower farm', false);
	await page.evaluate((href) => {
		const a = document.createElement('a');
		a.href = href;
		document.querySelector('dialog[open]')!.append(a);
		a.click();
		a.remove();
	}, `?tab=crops&farm=${idOf('Upper farm')}`);
	await expect(page.getByRole('dialog', { name: 'Upper farm: planted areas' })).toBeVisible();
	await expect(panel(page).getByTestId('cropland-parcels').locator('caption')).toHaveText('Cultivated area in Upper farm’s parcels on the map');

	// Hold the save until Back has moved the drawer to Lower farm and its summary is in.
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r));
	let posted!: () => void;
	const arrived = new Promise<void>((r) => (posted = r));
	await page.route(/\/crop-area-from-land-cover$/, async (route) => {
		posted();
		await held;
		await route.continue();
	});
	await cropRow(page, 'Orchard').getByRole('button', { name: /^Use / }).click();
	await answerConfirm(page, true, /Set Orchard’s planted area on Upper farm from land cover\?/);
	await arrived;
	await page.goBack();
	await expect(page.getByRole('dialog', { name: 'Lower farm: planted areas' })).toBeVisible();
	await expect(panel(page).getByTestId('cropland-body')).toHaveAttribute('data-ready', 'true');
	await expect(panel(page).getByTestId('cropland-parcels')).toHaveCount(0);

	const saved = page.waitForResponse(/\/crop-area-from-land-cover$/);
	// The box's reload after the save: one GET of a summary, whichever unit it asks for.
	const reloaded = page.waitForResponse((r) => r.request().method() === 'GET' && /\/cropland-proposals$/.test(new URL(r.url()).pathname));
	await expect(panel(page)).toHaveAttribute('data-saving', 'true');
	release();
	expect((await saved).status()).toBe(200);
	await reloaded;
	// The Use has finished, its focus step included.
	await expect(panel(page)).not.toHaveAttribute('data-saving');
	// The notice still reports the save (it names its unit), but doesn't take the keyboard: it's about a unit the drawer
	// has left.
	await expect(panel(page).getByTestId('cropland-notice')).toContainText('Orchard’s planted area on Upper farm is now');
	await expect(panel(page).getByTestId('cropland-notice')).not.toBeFocused();
	// Still Lower farm's summary (no parcels), not the reload of Upper farm's the save asked for.
	await expect(page.getByRole('dialog', { name: 'Lower farm: planted areas' })).toBeVisible();
	await expect(panel(page).getByTestId('cropland-body')).toHaveAttribute('data-ready', 'true');
	await expect(panel(page).getByTestId('cropland-parcels')).toHaveCount(0);
});

test('a Use that fails after Back moved the drawer on reports it in the notice, naming its unit, not on the other unit’s row', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Cropland proposals use fails');
	const idOf = (name: string) => String(project.model.nodes.find((n) => n.name === name)!.id);
	// Parcels on both units, so Lower farm's box has an Orchard row too: the crop's key is the same on every unit.
	await drawParcels(page, project.id, idOf('Upper farm'));
	await drawParcels(page, project.id, idOf('Lower farm'), ' (lower)');
	await openBox(page, project.id, idOf('Lower farm'), 'Lower farm');
	await page.evaluate((href) => {
		const a = document.createElement('a');
		a.href = href;
		document.querySelector('dialog[open]')!.append(a);
		a.click();
		a.remove();
	}, `?tab=crops&farm=${idOf('Upper farm')}`);
	await expect(page.getByRole('dialog', { name: 'Upper farm: planted areas' })).toBeVisible();
	await expect(panel(page).getByTestId('cropland-parcels').locator('caption')).toHaveText('Cultivated area in Upper farm’s parcels on the map');

	// Hold the save until Back has moved the drawer to Lower farm, then fail it.
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r));
	let posted!: () => void;
	const arrived = new Promise<void>((r) => (posted = r));
	await page.route(/\/crop-area-from-land-cover$/, async (route) => {
		posted();
		await held;
		await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Something went wrong' }) });
	});
	await cropRow(page, 'Orchard').getByRole('button', { name: /^Use / }).click();
	await answerConfirm(page, true, /Set Orchard’s planted area on Upper farm from land cover\?/);
	await arrived;
	await page.goBack();
	await expect(page.getByRole('dialog', { name: 'Lower farm: planted areas' })).toBeVisible();
	await expect(panel(page).getByTestId('cropland-parcels').locator('caption')).toHaveText('Cultivated area in Lower farm’s parcels on the map');
	await expect(panel(page)).toHaveAttribute('data-saving', 'true');
	release();
	await expect(panel(page)).not.toHaveAttribute('data-saving');
	// Lower farm's Orchard row (the same crop) carries no error; the notice names the unit the failure was for.
	await expect(cropRow(page, 'Orchard').getByRole('alert')).toHaveCount(0);
	await expect(panel(page).locator('.err')).toHaveCount(0);
	const notice = panel(page).getByTestId('cropland-notice');
	await expect(notice).toHaveText('Couldn’t save Orchard’s planted area on Upper farm: Something went wrong');
	await expect(notice).toHaveClass(/alert-error/);
	await expect(notice).not.toBeFocused();
});

test('an editor uses the parcels’ cultivated area as a crop’s planted area; History cites the dataset; a viewer can’t', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Cropland proposals');
	const upper = { id: String(project.model.nodes.find((n) => n.name === 'Upper farm')!.id) };
	const orchard = project.model.crops[0]!;
	await drawParcels(page, project.id, upper.id);
	const summary = (await (await page.request.get(`${API_URL}/projects/${project.id}/nodes/${upper.id}/cropland-proposals`)).json()) as {
		unit: { cultivatedM2: number };
	};

	await openBox(page, project.id, upper.id, 'Upper farm');
	await expect(panel(page).getByTestId('cropland-synthetic')).toContainText('Synthetic test data.');
	// #90 Land-cover proposals: labelled as satellite cropland, not irrigated area, to check before use.
	await expect(panel(page).getByTestId('cropland-caution')).toHaveText(
		'This is cultivated land mapped from satellite, including dryland and fallow fields, not the irrigated area: check it before you use it.'
	);
	const parcels = panel(page).getByTestId('cropland-parcels');
	await expect(parcels.locator('tbody tr')).toHaveCount(2);
	// Half of each parcel is cultivated in the synthetic grid.
	// Largest cultivated area first; half of each parcel is cultivated in the synthetic grid.
	await expect(parcels.locator('tbody tr').first().getByRole('rowheader')).toHaveText('Lower lands');
	await expect(parcels.locator('tbody tr').first().getByRole('cell').last()).toHaveText('50 %');
	await expect(parcels.locator('tfoot')).toContainText('All parcels');
	await expect(panel(page).getByLabel('Area to use')).toHaveValue('unit');
	// The land cover's own disclosure: the crop-type grid's section has one too, once its grid is loaded.
	await panel(page).locator('details').filter({ has: page.getByTestId('cropland-source') }).locator('summary').click();
	await expect(panel(page).getByTestId('cropland-source')).toContainText('SYNTHETIC test data, invented for this repository (not ESA WorldCover) (synthetic 1; dataset “synthetic”)');

	const row = cropRow(page, 'Orchard');
	await expect(row.getByRole('cell').first()).toHaveText('20 ha');
	await row.getByRole('button', { name: /^Use [\d.,]+ ha as Orchard’s planted area$/ }).click();
	// Cancel changes nothing.
	await answerConfirm(page, false, 'Set Orchard’s planted area on Upper farm from land cover?');
	await expect(row.getByRole('cell').first()).toHaveText('20 ha');
	await row.getByRole('button', { name: /^Use / }).click();
	// The page reloads the model after the save; the notice must outlive that reload (it used to be cleared by it).
	const reloaded = page.waitForResponse((r) => r.request().method() === 'GET' && r.url().endsWith(`/projects/${project.id}/model`));
	await answerConfirm(
		page,
		true,
		/Set Orchard’s planted area on Upper farm from land cover\?\s*Orchard on Upper farm changes from 20 ha to [\d.,]+ ha, the cultivated area the land cover \(synthetic, synthetic 1\) shows in Upper farm’s parcels\. This is cultivated land mapped from satellite, including dryland and fallow fields, not the irrigated area: check it before you use it\./
	);
	await expect(panel(page).getByTestId('cropland-notice')).toHaveText(/^Orchard’s planted area on Upper farm is now [\d.,]+ ha, from land cover\. Run the model to see its effect\.$/);
	// Run model lives on Runs & results: the notice links there.
	await expect(panel(page).getByTestId('cropland-notice').getByRole('link', { name: 'Run the model' })).toHaveAttribute('href', '?tab=runs');
	await expect(row.getByRole('cell').last()).toHaveText('Saved');
	// The Use button is gone: the keyboard lands on what happened (ProposalPanel's notice), not the top of the page.
	await expect(panel(page).getByTestId('cropland-notice')).toBeFocused();
	await reloaded;
	await expect(panel(page).getByTestId('cropland-notice')).toHaveText(/^Orchard’s planted area on Upper farm is now [\d.,]+ ha, from land cover\. Run the model to see its effect\.$/);
	await expect(row.getByTestId('cropland-provenance')).toContainText('from land cover (the unit’s parcels; synthetic, synthetic 1), used');
	const model = (await (await page.request.get(`${API_URL}/projects/${project.id}/model`)).json()) as { cropAreas: { nodeId: string; cropId: string; areaM2: number }[] };
	expect(model.cropAreas.find((a) => a.nodeId === upper.id && a.cropId === orchard.id)!.areaM2).toBe(summary.unit.cultivatedM2);
	await expectNoViolations(page, { include: '[data-testid="cropland-proposals"]' });

	await page.goto(`/projects/${project.id}?tab=history`);
	await expect(page.getByTestId('history-entry').nth(0)).toContainText(
		/Planted area of Orchard on Upper farm from land cover: [\d.]+ ha cultivated in its 2 parcels; SYNTHETIC .*\(synthetic 1; dataset “synthetic”\)\. Pre-summarised at import/
	);

	// A viewer reads the summary and its source, and has no Use; on a phone nothing scrolls sideways.
	const viewer = await signIn('Cropland viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.setViewportSize({ width: 390, height: 844 });
	await openBox(v, project.id, upper.id, 'Upper farm');
	await expect(panel(v).getByRole('button', { name: /^Use / })).toHaveCount(0);
	await expect(panel(v)).toContainText('Only an editor can use a value.');
	await expectNoSidewaysScroll(v);
	// Nor inside their own boxes: the parcels and crops tables fit the drawer as columns (the Dams one stacks its rows).
	const wraps = await panel(v).locator('.table-wrap').evaluateAll((ws) => ws.map((w) => [w.scrollWidth, w.clientWidth]));
	expect(wraps.length).toBeGreaterThan(0);
	for (const [scroll, client] of wraps) expect(scroll).toBeLessThanOrEqual(client!);
	await expectNoViolations(v, { include: '[data-testid="cropland-proposals"]' });
});

test('one parcel’s area, a unit with no parcel, and Use waiting for unsaved changes', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Cropland one parcel');
	const upper = { id: String(project.model.nodes.find((n) => n.name === 'Upper farm')!.id) };
	const lower = { id: String(project.model.nodes.find((n) => n.name === 'Lower farm')!.id) };
	await drawParcels(page, project.id, upper.id);

	// Lower farm has no parcel on the map: the box says so and offers nothing to use.
	await openBox(page, project.id, lower.id, 'Lower farm', false);
	await expect(panel(page).getByTestId('cropland-no-parcels')).toContainText('No farm parcel on the map is linked to Lower farm.');
	await expect(panel(page).getByRole('button', { name: /^Use / })).toHaveCount(0);

	await openBox(page, project.id, upper.id, 'Upper farm');
	const topCamp = await panel(page).getByLabel('Area to use').locator('option', { hasText: /^Top camp: / }).getAttribute('value');
	await panel(page).getByLabel('Area to use').selectOption(topCamp!);
	const row = cropRow(page, 'Orchard');
	// An unsaved edit in the drawer: Use waits, and says why.
	const area = page.getByLabel('Orchard on Upper farm, ha');
	await area.fill('21');
	await area.blur();
	await expect(row.getByRole('button', { name: /^Use / })).toBeDisabled();
	await expect(panel(page)).toContainText('Save or discard your model changes first');
	await area.fill('20');
	await area.blur();
	await expect(row.getByRole('button', { name: /^Use / })).toBeEnabled();
	await row.getByRole('button', { name: /^Use / }).click();
	await answerConfirm(page, true, /shows in the parcel Top camp\./);
	await expect(row.getByTestId('cropland-provenance')).toContainText('from land cover (the parcel “Top camp”; synthetic, synthetic 1), used');
	await page.goto(`/projects/${project.id}?tab=history`);
	await expect(page.getByTestId('history-entry').nth(0)).toContainText(/Planted area of Orchard on Upper farm from land cover: [\d.]+ ha cultivated in the parcel “Top camp”;/);
});
