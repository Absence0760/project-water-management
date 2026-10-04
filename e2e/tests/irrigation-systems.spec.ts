// A project's irrigation systems (engine 1.72.0, docs/ui.md § Irrigation
// systems): the table (Crops & demand → Tables → Irrigation systems, the grid
// modal's `grid=systems`) starts as SABI 2021's systems, whose
// efficiencies the hydrologist can change and to which a system of their own
// can be added; a crop's default is set in its sheet, a unit's own in its
// planted areas or the Planted areas table; the unit form edits its own
// efficiency while a crop is on no system, and otherwise shows its crops'
// systems blended as text, with its crops grouped by system in words. Every choice survives a save and a reload. Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createProject, putModel, sampleModel } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { closeModal, openNodeForm, saveModelChanges } from '../support/network.ts';

const panel = (page: Page) => page.getByTestId('irrigation-systems');

test('the systems table, a crop’s default and a unit’s own system, and the unit’s blended efficiency', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Irrigation systems');
	await putModel(page.request, project.id, sampleModel());

	// The sample's Orchard predates systems, so a run uses each unit's own efficiency for it: the form edits it.
	await page.goto(`/projects/${project.id}?tab=network`);
	const before = await openNodeForm(page, 'Lower farm');
	await expect(before.getByLabel('Efficiency for crops with no system (%)')).toBeEditable();
	await expect(before.getByTestId('node-systems')).toContainText('Irrigation systems: No system (its own ');

	// The table opens from the Tables menu, in the grid modal, not below the page's fold.
	await page.goto(`/projects/${project.id}?tab=crops`);
	await page.locator('details.grids-menu summary').click();
	await page.getByRole('group', { name: 'Open as a table' }).getByRole('link', { name: 'Irrigation systems' }).click();
	await expect(page).toHaveURL(/grid=systems/);
	await expect(page.getByRole('dialog', { name: 'Irrigation systems' })).toBeVisible();

	// The SABI systems, each with SABI's range; nothing on them yet.
	const sys = panel(page);
	await expect(sys.getByRole('rowheader')).toHaveCount(6);
	await expect(sys.getByLabel('Name of irrigation system 6')).toHaveValue('Flood / furrow');
	await expect(sys.getByRole('row', { name: /Drip/ })).toContainText('SABI 90–95 %');
	await expectNoViolations(page, { include: '[data-testid="irrigation-systems"]' });

	// The scheme's drip measured at 93 %, and a system of its own at 60 %.
	await sys.getByLabel('Efficiency of Drip, %').fill('93');
	await sys.getByLabel('Efficiency of Drip, %').press('Tab');
	await sys.getByRole('button', { name: '+ Add system' }).click();
	await expect(sys.getByLabel('Name of irrigation system 7')).toBeFocused();
	await sys.getByLabel('Name of irrigation system 7').fill('Old furrows');
	await sys.getByLabel('Efficiency of Old furrows, %').fill('60');
	await sys.getByLabel('Efficiency of Old furrows, %').press('Tab');
	expect((await saveModelChanges(page)).status()).toBe(200);
	// Back closes the modal.
	await page.goBack();
	await expect(page.getByRole('dialog', { name: 'Irrigation systems' })).toBeHidden();

	// Orchard's default: drip, in its sheet.
	await page.getByRole('button', { name: 'Edit Orchard' }).click();
	const sheet = page.getByRole('dialog', { name: 'Edit Orchard' });
	await sheet.getByLabel('Irrigation system', { exact: true }).selectOption({ label: 'Drip, 93 %' });
	await expect(sheet.getByTestId('crop-system-hint')).toHaveText('The system it is under wherever it grows. A unit can put it on another in its planted areas.');
	await expectNoViolations(page);
	expect((await saveModelChanges(page)).status()).toBe(200);
	await sheet.getByRole('button', { name: 'Done' }).click();

	// Lower farm waters it with the old furrows: its own, in the Planted areas table.
	await page.goto(`/projects/${project.id}?tab=crops&grid=planted-areas`);
	const grid = page.getByRole('dialog', { name: /Planted areas/ });
	await grid.getByLabel('Irrigation system of Orchard on Lower farm').selectOption({ label: 'Old furrows, 60 %' });
	await expect(grid.getByLabel('Irrigation system of Orchard on Upper farm')).toHaveValue('');
	await expect(grid.getByLabel('Irrigation system of Orchard on Upper farm').locator('option:checked')).toHaveText('Default: Drip');
	expect((await saveModelChanges(page)).status()).toBe(200);

	// After a reload: the table, the crop's default and the unit's own are as saved.
	await page.goto(`/projects/${project.id}?tab=crops&grid=systems`);
	await expect(panel(page).getByLabel('Efficiency of Drip, %')).toHaveValue('93');
	await expect(panel(page).getByRole('row', { name: /Old furrows/ })).toContainText('1 unit planting');
	await expect(panel(page).getByRole('row', { name: /Drip/ })).toContainText('1 crop');
	await closeModal(page);
	await page.getByRole('button', { name: 'Edit Orchard' }).click();
	await expect(page.getByRole('dialog', { name: 'Edit Orchard' }).getByTestId('crop-system-hint')).toHaveText(
		'The system it is under wherever it grows, except on Lower farm (Old furrows). A unit can put it on another in its planted areas.'
	);

	// The unit form: every crop is on a system, so the efficiency is theirs, as text, with its crops grouped by system.
	await page.goto(`/projects/${project.id}?tab=network`);
	const lower = await openNodeForm(page, 'Lower farm');
	await expect(lower.getByTestId('node-efficiency')).toHaveText('60 %');
	await expect(lower.getByLabel('Efficiency (%)')).toHaveJSProperty('tagName', 'OUTPUT');
	await expect(lower.getByTestId('node-systems')).toContainText('Irrigation systems: Old furrows, 60 %: Orchard.');
	await expectNoViolations(page);
});

test('the unit’s planted areas put a crop on a system of its own; removing a system in use asks first', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Irrigation systems drawer');
	const model = sampleModel();
	model.crops[0]!.irrigationSystemId = 'drip';
	await putModel(page.request, project.id, model);
	const lower = model.nodes.find((n) => n.name === 'Lower farm')!.id as string;
	await page.goto(`/projects/${project.id}?tab=crops&farm=${lower}`);
	const drawer = page.getByRole('dialog', { name: 'Lower farm: planted areas' });
	const pick = drawer.getByLabel('Irrigation system of Orchard on Lower farm');
	await expect(pick.locator('option:checked')).toHaveText("The crop's default (Drip, 90 %)");
	await pick.selectOption({ label: 'Centre pivot / linear move, 85 %' });
	await expectNoViolations(page);
	expect((await saveModelChanges(page)).status()).toBe(200);
	await drawer.getByRole('button', { name: 'Done' }).click();

	// Removing the pivot row asks, naming what is on it; Remove leaves the planting on the crop's default.
	await page.goto(`/projects/${project.id}?tab=crops&grid=systems`);
	await panel(page).getByRole('button', { name: 'Remove Centre pivot / linear move' }).click();
	const confirm = page.getByRole('alertdialog');
	await expect(confirm).toContainText('1 unit planting is on it.');
	await confirm.getByRole('button', { name: 'Remove system' }).click();
	await expect(panel(page).getByRole('rowheader')).toHaveCount(5);
	expect((await saveModelChanges(page)).status()).toBe(200);
	await page.goto(`/projects/${project.id}?tab=crops&farm=${lower}`);
	await expect(page.getByRole('dialog', { name: 'Lower farm: planted areas' }).getByLabel('Irrigation system of Orchard on Lower farm')).toHaveValue('');
});
