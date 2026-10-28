// A unit's planted-areas drawer → "From land cover" → Orchards and vines
// (issue #604 R5-D; docs/ui.md § Farm drawer, docs/maps.md § Orchards and vines
// from SANLC). Beside the land cover's cultivated area, the committed synthetic
// crop-type grid (every cell 20 % orchard, 10 % vine, 5 % new orchard where
// these parcels lie) gives each parcel's orchards and vines and what is new
// since its earlier edition. The editor picks the unit's orchards under Area to
// use, Use asks first with the crop types' own caution, saves that one value,
// and History cites the dataset and class. New plantings are shown, never
// offered. The tables are read, never the map's pixels. Invented data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { loadSyntheticCropTypes } from '../support/cropTypes.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { loadSyntheticLandCover } from '../support/landCover.ts';
import { box } from '../support/map.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const panel = (page: Page) => page.getByTestId('cropland-proposals');
const types = (page: Page) => panel(page).getByTestId('croptypes');
/** An area as the drawer writes it (fmtHa: hectares, at most two decimals). */
const ha = (m2: number) => `${Number((m2 / 10_000).toFixed(2))} ha`;

interface Areas {
	areaM2: number;
	orchardM2: number;
	vineM2: number;
	newOrchardM2: number;
	newVineM2: number;
}

test.beforeAll(async () => {
	await Promise.all([loadSyntheticLandCover(), loadSyntheticCropTypes()]);
});

test('an editor uses the unit’s orchards as a crop’s planted area; new plantings are shown, not offered; History cites the class', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Orchards and vines');
	const upper = String(project.model.nodes.find((n) => n.name === 'Upper farm')!.id);
	const orchard = project.model.crops[0]!;
	for (const [name, ring] of [
		['Lower block', box(21.31, -33.69, 0.01)],
		['Top block', box(21.33, -33.67, 0.005)]
	] as const) {
		const made = await page.request.post(`${API_URL}/projects/${project.id}/map/features`, {
			data: { kind: 'farm_parcel', name, nodeId: upper, geometry: { type: 'Polygon', coordinates: [ring] } }
		});
		expect(made.status(), await made.text()).toBe(201);
	}
	const summary = (await (await page.request.get(`${API_URL}/projects/${project.id}/nodes/${upper}/cropland-proposals`)).json()) as {
		cropTypes: { parcels: (Areas & { name: string })[]; unit: Areas };
	};
	const unit = summary.cropTypes.unit;

	await page.goto(`/projects/${project.id}?tab=crops&farm=${upper}`);
	await expect(page.getByRole('dialog', { name: 'Upper farm: planted areas' })).toBeVisible();
	await expect(panel(page).getByTestId('cropland-body')).toHaveAttribute('data-ready', 'true');
	await expect(types(page).getByRole('heading', { name: 'Orchards and vines' })).toBeVisible();
	await expect(types(page).getByTestId('croptypes-synthetic')).toContainText('Synthetic test data.');
	await expect(types(page).getByTestId('croptypes-caution')).toHaveText(
		'This is orchard and vine land mapped from satellite, not the irrigated area, and it doesn’t say which fruit or cultivar: check it before you use it.'
	);
	const table = types(page).getByTestId('croptypes-parcels');
	await expect(table.getByRole('columnheader')).toHaveText(['Parcel', 'Orchards', 'Vines', 'New since synthetic 2018']);
	// Largest cultivated first, as the land cover's table.
	const lower = summary.cropTypes.parcels.find((p) => p.name === 'Lower block')!;
	await expect(table.locator('tbody tr').first().getByRole('rowheader')).toHaveText('Lower block');
	await expect(table.locator('tbody tr').first().getByRole('cell')).toHaveText([ha(lower.orchardM2), ha(lower.vineM2), ha(lower.newOrchardM2 + lower.newVineM2)]);
	await expect(table.getByTestId('croptypes-new-total')).toHaveText(ha(unit.newOrchardM2 + unit.newVineM2));
	await expect(types(page).getByTestId('croptypes-new-note')).toContainText('Shown here, never offered as an area to use.');
	await types(page).getByText('Source and method').click();
	await expect(types(page).getByTestId('croptypes-source')).toContainText('Synthetic crop-type grid (invented for testing; not SANLC) (synthetic 2022; dataset “synthetic”)');

	// The orchards are offered under Area to use, the new plantings never.
	const select = panel(page).getByLabel('Area to use');
	await expect(select.locator('optgroup[label="Orchards and vines"] option')).toHaveText([
		`Orchards, all 2 parcels: ${ha(unit.orchardM2)}`,
		...summary.cropTypes.parcels.filter((p) => p.orchardM2 > 0).map((p) => `Orchards, ${p.name}: ${ha(p.orchardM2)}`),
		`Vines, all 2 parcels: ${ha(unit.vineM2)}`,
		...summary.cropTypes.parcels.filter((p) => p.vineM2 > 0).map((p) => `Vines, ${p.name}: ${ha(p.vineM2)}`)
	]);
	await expect(select.locator('option', { hasText: /new/i })).toHaveCount(0);
	await select.selectOption({ label: `Orchards, all 2 parcels: ${ha(unit.orchardM2)}` });

	const row = panel(page).locator(`tr[data-crop="${orchard.name}"]`);
	await row.getByRole('button', { name: `Use ${ha(unit.orchardM2)} as ${orchard.name}’s planted area` }).click();
	await answerConfirm(
		page,
		true,
		new RegExp(
			`Set ${orchard.name}’s planted area on Upper farm from crop types\\?\\s*${orchard.name} on Upper farm changes from [\\d.,]+ ha to ${ha(unit.orchardM2).replace('.', '\\.')}, the permanent orchards the crop types \\(synthetic, synthetic 2022\\) show in Upper farm’s parcels\\. This is orchard and vine land mapped from satellite`
		)
	);
	await expect(panel(page).getByTestId('cropland-notice')).toHaveText(new RegExp(`^${orchard.name}’s planted area on Upper farm is now ${ha(unit.orchardM2).replace('.', '\\.')}, from crop types\\. Run the model to see its effect\\.$`));
	await expect(row.getByRole('cell').last()).toHaveText('Saved');
	await expect(row.getByTestId('cropland-provenance')).toContainText(`${ha(unit.orchardM2)} from crop types (orchards; the unit’s parcels; synthetic, synthetic 2022), used`);
	const model = (await (await page.request.get(`${API_URL}/projects/${project.id}/model`)).json()) as { cropAreas: { nodeId: string; cropId: string; areaM2: number }[] };
	expect(model.cropAreas.find((a) => a.nodeId === upper && a.cropId === orchard.id)!.areaM2).toBe(unit.orchardM2);
	await expectNoViolations(page, { include: '[data-testid="cropland-proposals"]' });

	// On a phone the crop-type table fits the drawer like the others.
	await page.setViewportSize({ width: 390, height: 844 });
	await expectNoSidewaysScroll(page);
	const [scroll, client] = await types(page).locator('.table-wrap').evaluate((w) => [w.scrollWidth, w.clientWidth]);
	expect(scroll).toBeLessThanOrEqual(client!);

	await page.goto(`/projects/${project.id}?tab=history`);
	await expect(page.getByTestId('history-entry').nth(0)).toContainText(
		new RegExp(`Planted area of ${orchard.name} on Upper farm from crop types: [\\d.]+ ha of permanent orchards in its 2 parcels; Synthetic crop-type grid .*\\(synthetic 2022; dataset “synthetic”\\)\\. Permanent orchards \\(class 32\\)\\.`)
	);
});
