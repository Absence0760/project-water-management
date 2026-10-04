// The crop supply table (engine 1.73.0, issue #408, docs/model.md §2.7k): in
// the node form a unit's crops are split by share between its own dam, the
// river at the unit and another unit's dam, which is saved, refused while the
// shares don't add up, and run.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openNodeForm, saveModelChanges } from '../support/network.ts';

const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });
const lower = '3. Lower farm · hydrological unit';

test('split a unit’s crops between its dam, the river and another unit’s dam: checked, saved, and run', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Crop supply table');
	await page.goto(`/projects/${project.id}?tab=network`);
	await openNodeForm(page);
	await page.getByLabel('Node to edit').selectOption({ label: lower });

	const supply = page.getByRole('group', { name: 'Supply', exact: true });
	const split = supply.getByLabel('Split the crops’ water between sources');
	await expect(split).not.toBeChecked();
	// Ticked, the table starts from the crops' source (all on the dam) and replaces the water source.
	await split.check();
	await expect(supply.getByLabel('This unit’s dam (%)')).toHaveValue('100');
	await expect(supply.getByLabel('Water for the crops')).toHaveCount(0);
	const total = supply.getByTestId(/^crop-supply-total-/);
	await expect(total).toHaveText('Total 100 %');

	await supply.getByLabel('This unit’s dam (%)').fill('60');
	await supply.getByLabel('The river at this unit (%)').fill('20');
	await supply.getByLabel('Another unit’s dam (%)').fill('10');
	// 90 %: the form says so, and the save bar holds the save.
	await expect(total).toHaveText('Total 90 %');
	await expect(supply.getByRole('alert')).toContainText('the crop supply shares add up to 90 %, not 100 %');
	await expect(supply.getByRole('alert')).toContainText("the crops' share from another unit's dam needs that unit");
	await expect(saveBar(page)).toContainText('"Lower farm": the crop supply shares add up to 90 %, not 100 %');

	await supply.getByLabel('Another unit’s dam (%)').fill('20');
	await supply.getByLabel('Which unit’s dam').selectOption({ label: 'Upper farm' });
	// The pipe takes the pumps' unit picker (docs/ui.md § Flow units): 5 l/s is 432 m³/day, and the crops' pump follows the pick.
	await expect(supply.getByLabel('Pipe capacity (m³/day)')).toBeVisible();
	await supply.getByLabel('Unit of pipe capacity').selectOption('ls');
	await supply.getByLabel('Pipe capacity (l/s)').fill('5');
	await supply.getByLabel('River pump capacity for the crops (l/s)').fill('10');
	await expect(total).toHaveText('Total 100 %');
	await expect(supply.getByRole('alert')).toHaveCount(0);
	await expectNoViolations(page, { include: '.detail' });
	await page.setViewportSize({ width: 390, height: 844 });
	await expectNoViolations(page, { include: '.detail' });
	await page.setViewportSize({ width: 1440, height: 900 });
	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);
	const saved = (await (await page.request.get(`${API_URL}/projects/${project.id}/model`)).json()) as { nodes: { name: string; cropRemoteCapM3Day: number | null; cropRiverPumpM3Day: number | null }[] };
	const lowerSaved = saved.nodes.find((n) => n.name === 'Lower farm')!;
	expect(lowerSaved.cropRemoteCapM3Day).toBeCloseTo(432, 6);
	expect(lowerSaved.cropRiverPumpM3Day).toBeCloseTo(864, 6);

	await page.reload();
	await openNodeForm(page);
	await page.getByLabel('Node to edit').selectOption({ label: lower });
	const again = page.getByRole('group', { name: 'Supply', exact: true });
	await expect(again.getByLabel('Split the crops’ water between sources')).toBeChecked();
	await expect(again.getByLabel('This unit’s dam (%)')).toHaveValue('60');
	await expect(again.getByLabel('The river at this unit (%)')).toHaveValue('20');
	await expect(again.getByLabel('Another unit’s dam (%)')).toHaveValue('20');
	await expect(again.getByLabel('Which unit’s dam')).toHaveValue(project.model.nodes.find((n) => n.name === 'Upper farm')!.id as string);
	// The pick lasts across the reload.
	await expect(again.getByLabel('Pipe capacity (l/s)')).toHaveValue('5');
	await expect(again.getByLabel('River pump capacity for the crops (l/s)')).toHaveValue('10');

	// The model runs with it (the engine checks its own balance, the remote share at both ends included).
	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('Crop supply table');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Crop supply table' })).toBeVisible();

	// Unticked, the table goes and the crops take their water source again.
	await page.goto(`/projects/${project.id}?tab=network`);
	await openNodeForm(page);
	await page.getByLabel('Node to edit').selectOption({ label: lower });
	const last = page.getByRole('group', { name: 'Supply', exact: true });
	await last.getByLabel('Split the crops’ water between sources').uncheck();
	await expect(last.getByLabel('Water for the crops')).toHaveValue('dam');
	await expect(last.getByLabel('This unit’s dam (%)')).toHaveCount(0);
});
