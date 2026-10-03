// Load crop factors on Crops & demand (issue #54 item 1, docs/ui.md § Crop
// grids), from the Crop factors grid (Tables › Crop factors, issue #17): map a crop to the reference library, see the diff and the demand
// change, apply, save with a reason, reload; and a rejected change leaves
// the factors as they were.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
// A node-based workbook (invented data): the reader's own synthetic layout, loaded by URL so the e2e typecheck doesn't pull in the frontend's modules.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
type Builder = { set(sheet: string, cell: string, v: string | number): Builder; toFile(): Uint8Array };
const { syntheticNodeBased } = (await import(pathToFileURL(path.join(ROOT, 'frontend/src/lib/spreadsheet/import/testWorkbook.ts')).href)) as {
	syntheticNodeBased: () => Builder;
};

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
	// It says why, tied to the month it needs.
	const why = 'Pick a planting month: until then Onions has no factors to load into Orchard.';
	await expect(d.getByTestId('planting-month-why')).toHaveText(why);
	await expect(d.getByLabel('Orchard planting month')).toHaveAccessibleDescription(why);

	// 1 May for 160 days: May 0.25 … to 7 Oct (7 days × 0.50 ÷ 31 = 0.113); Nov–Apr 0.
	await d.getByLabel('Orchard planting month').selectOption({ label: 'May' });
	await expect(d.getByTestId('planting-month-why')).toHaveCount(0);
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
	await expect(d.getByRole('status').filter({ hasText: '6 crops from [Crop demand] in synthetic_b023.xlsx.' })).toBeVisible();
	// The import report's crop-table warnings for the fixture's copied and suspect rows (issue #289), as text.
	const warnings = d.getByRole('group', { name: 'Check these in the workbook' });
	await expect(warnings.getByRole('listitem')).toHaveText([
		/^\[Crop demand\] crop Fodder E: Dec factor is 0 between Nov 0\.5 and Jan 0\.5/,
		/^\[Crop demand\] crop Pasture F: its 12 factors are the same as Pasture C's/
	]);
	await expectNoViolations(page);
	// A b023 set is A-pan factors: Kp stays 1.
	await expect(d.getByLabel('Pan coefficient Kp')).toHaveValue('1');
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

test('the pan coefficient starts at the source’s default, says why, and a typed Kp survives a change of source', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Crop library Kp');
	await page.goto(`/projects/${project.id}?tab=crops`);
	await openLoad(page);
	const d = dialog(page);
	const kp = d.getByLabel('Pan coefficient Kp');
	// The library is A-pan factors: Kp 1, and the line under it says why, citing FAO-56 Table 5 for a Kc set.
	await expect(kp).toHaveValue('1');
	const why = d.getByTestId('kp-why');
	await expect(why).toContainText('Default 1: these factors already multiply A-pan');
	await expect(why.getByRole('link', { name: 'FAO-56 Table 5' })).toHaveAttribute('href', 'https://www.fao.org/4/x0490e/x0490e08.htm');
	await expect(d.getByRole('button', { name: /^Use the default/ })).toHaveCount(0);

	// The modeller's own Kp is kept when the source changes; one click puts the default back.
	await kp.fill('0.8');
	await kp.press('Tab');
	await d.getByRole('radio', { name: 'A b023 workbook' }).check();
	await expect(kp).toHaveValue('0.8');
	await d.getByRole('button', { name: 'Use the default, 1' }).click();
	await expect(kp).toHaveValue('1');
	// The button goes, so focus returns to the input; the why line describes it.
	await expect(kp).toBeFocused();
	await expect(kp).toHaveAccessibleDescription(/^Default 1: these factors already multiply A-pan.* 0\.1 to 1\.5$/);
	await expect(d.getByRole('button', { name: /^Use the default/ })).toHaveCount(0);
});

test('a Kp out of range says the range', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Crop library Kp range');
	await page.goto(`/projects/${project.id}?tab=crops`);
	await openLoad(page);
	const d = dialog(page);
	const kp = d.getByLabel('Pan coefficient Kp');
	// The range is on screen beside the field and in its description, before anything is typed.
	await expect(d.locator('#lcf-kp-range')).toHaveText('0.1 to 1.5');
	await expect(kp).toHaveAccessibleDescription(/0\.1 to 1\.5$/);
	await kp.fill('2');
	await kp.press('Tab');
	await expect(kp).toHaveAttribute('aria-invalid', 'true');
	await expect(kp).toHaveAccessibleDescription(/0\.1 to 1\.5/);
});

test('Load crop factors opens from the Crops header and from a crop’s sheet', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Crop library header');
	await page.goto(`/projects/${project.id}?tab=crops`);
	await page.getByRole('button', { name: 'Load crop factors…' }).click();
	await expect(dialog(page)).toBeVisible();
	await expect(dialog(page).getByLabel('Load factors for Orchard from')).toBeVisible();
	await dialog(page).getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog(page)).toHaveCount(0);

	// From the sheet: the dialog opens over it, and closing it leaves the sheet open.
	await page.getByRole('button', { name: 'Edit Orchard' }).click();
	const sheet = page.getByRole('dialog', { name: 'Edit Orchard' });
	await sheet.getByRole('button', { name: 'Load crop factors…' }).click();
	await expect(dialog(page)).toBeVisible();
	await dialog(page).getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog(page)).toBeHidden();
	await expect(sheet).toBeVisible();
	await expectNoViolations(page);
});

test('from a node-based workbook: FAO-56 Kc, so Kp starts at 0.75 with why, and the reader’s warnings listed', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Crop library node-based');
	await page.goto(`/projects/${project.id}?tab=crops`);
	await openLoad(page);
	const d = dialog(page);
	const kp = d.getByLabel('Pan coefficient Kp');
	await d.getByRole('radio', { name: 'A node-based workbook (FAO-56 Kc)' }).check();
	// FAO-56 Kc against ET₀: Kp switches from the library's 1 to 0.75, and the line under it says why.
	await expect(kp).toHaveValue('0.75');
	const why = d.getByTestId('kp-why');
	await expect(why).toContainText('Default 0.75: these are FAO-56 Kc values, set against reference ET₀');
	await expect(why).toContainText('0.35–0.85 for a Class A pan');
	await expect(why.getByRole('link', { name: 'FAO-56 Table 5' })).toHaveAttribute('href', 'https://www.fao.org/4/x0490e/x0490e08.htm');

	// Olives' Nov factor is text in this copy: read as 0, and said so with its cell.
	const bytes = syntheticNodeBased().set('Crop_Factors', 'C9', 'n/a').toFile();
	await d.getByLabel('Workbook (.xlsx, .xlsm)').setInputFiles({ name: 'node-based.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(bytes) });
	await expect(d.getByRole('status').filter({ hasText: '3 crops from [Crop_Factors] in node-based.xlsx.' })).toBeVisible();
	await expect(d.getByRole('group', { name: 'Check this in the workbook' }).getByRole('listitem')).toHaveText([/not a number \(n\/a\); read as 0\. \(\[Crop_Factors\] C9\)$/]);

	// Orchard matches none of Lucerne, Olives, Wine grapes; Olives' Oct Kc 0.55 × 0.75 = 0.4125.
	await d.getByLabel('Load factors for Orchard from').selectOption({ label: 'Olives' });
	const diff = d.getByRole('region', { name: 'Orchard: changes' });
	await expect(diff).toContainText('← Olives × Kp 0.75');
	await expect(diff).toContainText('From [Crop_Factors] in node-based.xlsx.');
	await expectNoViolations(page);
	await d.getByRole('button', { name: 'Apply 1 crop' }).click();
	await expect(page.getByLabel('Orchard crop factor, Oct')).toHaveValue('0.4125');
	await expect(page.getByLabel('Orchard crop factor, Nov')).toHaveValue('0');
});

test('a node-based workbook with many problems lists the first five, and all on request', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Crop library node warnings');
	await page.goto(`/projects/${project.id}?tab=crops`);
	await openLoad(page);
	const d = dialog(page);
	await d.getByRole('radio', { name: 'A node-based workbook (FAO-56 Kc)' }).check();
	// Seven of Lucerne's months are text: seven warnings.
	const b = syntheticNodeBased();
	for (const col of ['B', 'C', 'D', 'E', 'F', 'G', 'H']) b.set('Crop_Factors', `${col}8`, 'x');
	await d.getByLabel('Workbook (.xlsx, .xlsm)').setInputFiles({ name: 'messy.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(b.toFile()) });
	const warnings = d.getByRole('group', { name: 'Check these in the workbook' });
	await expect(warnings.getByRole('listitem')).toHaveCount(5);
	const more = warnings.getByRole('button', { name: 'Show all 7' });
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	await more.click();
	await expect(warnings.getByRole('listitem')).toHaveCount(7);
	await expect(warnings.getByRole('button', { name: 'Show the first 5' })).toHaveAttribute('aria-expanded', 'true');
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
