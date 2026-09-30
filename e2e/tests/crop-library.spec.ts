// Load crop factors on Crops & demand (issue #54 item 1, docs/ui.md § Crop
// grids), from the Crop factors grid (Grids › Crop factors, issue #17): map a crop to the reference library, see the diff and the demand
// change, apply, save with a reason, reload; and a rejected change leaves
// the factors as they were.
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { API_URL } from '../support/env.ts';
import { seedRunnableProject, showAllSections } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { openCropGrid } from '../support/crops.ts';
import { expect, test } from '../support/fixtures.ts';
import { closeModal } from '../support/network.ts';

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Load crop factors' });
// The seeded Orchard, Oct … Sep, and the library's citrus (ARC Table 4.13 in water-year order).
const ORCHARD = [0.6, 0.7, 0.8, 0.8, 0.8, 0.7, 0.6, 0.5, 0.4, 0.4, 0.5, 0.6];
const CITRUS = [0.4, 0.4, 0.4, 0.4, 0.4, 0.5, 0.5, 0.4, 0.4, 0.3, 0.3, 0.4];
// The committed synthetic b023 workbook (invented data), as workbook-import.spec.ts uses it.
const WORKBOOK = new URL('../../scripts/wbt-import/fixtures/synthetic_b023.xlsx', import.meta.url);

async function savedFactors(page: Page, projectId: string): Promise<number[]> {
	const res = await page.request.get(`${API_URL}/projects/${projectId}/model`);
	const model = (await res.json()) as { crops: { name: string; cropFactor: number[] }[] };
	return model.crops.find((c) => c.name === 'Orchard')!.cropFactor;
}

/** Opens the Crop factors grid (the grid modal) and, from it, the Load crop factors dialog. */
async function openLoad(page: Page) {
	const grid = await openCropGrid(page, 'crop-factors');
	await grid.getByRole('button', { name: 'Load crop factors…' }).click();
}

async function openAndMapToCitrus(page: Page, projectId: string) {
	await page.goto(`/projects/${projectId}?tab=crops`);
	await openLoad(page);
	const d = dialog(page);
	await expect(d).toBeVisible();
	// "Orchard" matches no library crop by name, so it starts on Keep current and nothing would change.
	const from = d.getByLabel('Load factors for Orchard from');
	await expect(from).toHaveValue('');
	await expect(d.getByRole('button', { name: 'Apply 0 crops' })).toBeDisabled();
	await from.selectOption({ label: 'Citrus' });
	return d;
}

test('map Orchard to the library citrus, see the diff and the demand change, apply, save with a reason, reload', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Crop library');
	// History is hidden from the sidebar by default; this account shows it, to reach it from there below.
	await showAllSections(page.request);
	const d = await openAndMapToCitrus(page, project.id);

	const diff = d.getByRole('region', { name: 'Orchard: changes' });
	await expect(diff.getByRole('row', { name: /^Current/ })).toContainText('0.60');
	await expect(diff.getByRole('row', { name: /^New/ })).toContainText('0.40');
	await expect(diff).toContainText('ARC/SABI Irrigation Design Manual, ch. 4, Table 4.13, p. 4.50');
	// Σ factor × A-pan falls from 1 100 to 665 mm a year on the same area: −39.5 %.
	await expect(d.getByTestId('demand-change')).toHaveText('−40 %');
	await expectNoViolations(page);

	await d.getByRole('button', { name: 'Apply 1 crop' }).click();
	await expect(d).toBeHidden();
	await expect(page.getByLabel('Orchard crop factor, Mar')).toHaveValue('0.5');
	await expect(page.getByLabel('Orchard crop factor, Jul')).toHaveValue('0.3');
	// Nothing is saved until the save bar saves it.
	expect(await savedFactors(page, project.id)).toEqual(ORCHARD);

	// The grid modal hides the save bar, so its own save row saves, with the reason.
	const grid = page.getByRole('dialog', { name: 'Crop factors' });
	await grid.getByLabel('Reason for this change (optional)').fill('ARC winter-rainfall citrus');
	await grid.getByRole('button', { name: 'Save changes' }).click();
	await expect(grid).toContainText('No unsaved changes');
	expect(await savedFactors(page, project.id)).toEqual(CITRUS);

	// A reload keeps the grid open (`grid=` in the URL), with the saved factors.
	await page.reload();
	await expect(page.getByLabel('Orchard crop factor, Mar')).toHaveValue('0.5');
	await closeModal(page);
	await page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'History' }).click();
	const newest = page.getByTestId('history-entry').first();
	await expect(newest).toContainText('Model changed');
	await expect(newest).toContainText('Reason: ARC winter-rainfall citrus');
});

test('a staged vegetable needs a planting date; its season comes from Table 4.7', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Crop library staged');
	await page.goto(`/projects/${project.id}?tab=crops`);
	await openLoad(page);
	const d = dialog(page);
	await d.getByLabel('Load factors for Orchard from').selectOption({ label: 'Onions' });
	// No planting month yet, so no new factors to apply.
	await expect(d.getByLabel('Orchard season, days')).toHaveValue('160');
	await expect(d).toContainText('Table 4.7: Autumn transplant 160');
	await expect(d.getByRole('region', { name: 'Orchard: changes' })).toHaveCount(0);
	await expect(d.getByRole('button', { name: 'Apply 0 crops' })).toBeDisabled();

	// 1 May for 160 days: May 0.25 … to 7 Oct (7 days × 0.50 ÷ 31 = 0.113); Nov–Apr 0.
	await d.getByLabel('Orchard planting month').selectOption({ label: 'May' });
	const next = d.getByRole('region', { name: 'Orchard: changes' }).getByRole('row', { name: /^New/ });
	await expect(next).toContainText('0.11');
	await d.getByRole('button', { name: 'Apply 1 crop' }).click();
	await expect(page.getByLabel('Orchard crop factor, Oct')).toHaveValue('0.113');
	await expect(page.getByLabel('Orchard crop factor, Jun')).toHaveValue('0.298');
	await expect(page.getByLabel('Orchard crop factor, Jan')).toHaveValue('0');
});

test('from a b023 workbook: matched by name, times a pan coefficient', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Crop library b023');
	await page.goto(`/projects/${project.id}?tab=crops`);
	await openLoad(page);
	const d = dialog(page);
	await d.getByRole('radio', { name: 'A b023 workbook' }).check();
	await d.getByLabel('Workbook (.xlsx, .xlsm)').setInputFiles(fileURLToPath(WORKBOOK));
	await expect(d.getByRole('status').filter({ hasText: '5 crops from [Crop demand] in synthetic_b023.xlsx.' })).toBeVisible();
	// "Orchard" is in exactly one workbook crop's name, "Orchard A" (invented fixture: Oct 0.45).
	await expect(d.getByLabel('Load factors for Orchard from')).toHaveValue(/^wb:/);
	await expect(d.getByRole('region', { name: 'Orchard: changes' })).toContainText('← Orchard A');
	await d.getByLabel('Pan coefficient Kp').fill('0.75');
	await d.getByLabel('Pan coefficient Kp').press('Tab');
	await expect(d.getByRole('region', { name: 'Orchard: changes' })).toContainText('× Kp 0.75');
	await d.getByRole('button', { name: 'Apply 1 crop' }).click();
	await expect(page.getByLabel('Orchard crop factor, Oct')).toHaveValue('0.3375');
	await expect(page.getByRole('region', { name: 'Unsaved model changes' })).toBeVisible();
});

test('rejecting the change, or cancelling, leaves the factors as they were', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Crop library reject');
	const d = await openAndMapToCitrus(page, project.id);

	// Unticking Apply rejects the crop: nothing left to apply, and no demand difference.
	await d.getByRole('checkbox', { name: 'Apply to Orchard' }).uncheck();
	await expect(d.getByRole('button', { name: 'Apply 0 crops' })).toBeDisabled();
	await expect(d.getByTestId('demand-difference')).toHaveCount(0);
	await d.getByRole('button', { name: 'Cancel' }).click();
	await expect(d).toBeHidden();

	await expect(page.getByLabel('Orchard crop factor, Mar')).toHaveValue('0.7');
	await expect(page.getByRole('region', { name: 'Unsaved model changes' })).toHaveCount(0);
	expect(await savedFactors(page, project.id)).toEqual(ORCHARD);
});
