// A water source per demand (engine 1.65.0, issue #344, docs/model.md §2.7j):
// in the node form a demand object, and a unit's crops, draw on the dam (the
// default) or on a river abstraction of their own with a pump and a pool,
// which are saved and run.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openNodeForm, saveModelChanges } from '../support/network.ts';

const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });
const unit = '2. Upper farm · hydrological unit';

test('put a demand object and the crops on river abstractions beside the dam: saved, and the run pumps them', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Water source');
	await page.goto(`/projects/${project.id}?tab=network`);
	await openNodeForm(page);
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: unit });

	const objects = page.getByRole('group', { name: 'Demand objects', exact: true });
	await objects.getByLabel('Category of the new demand object').selectOption('industrial');
	await objects.getByRole('button', { name: '+ Add demand' }).click();
	await objects.getByLabel('Name').fill('Mill');
	await objects.getByLabel('Demand of Mill in Oct, m³/day').fill('50');
	await objects.getByRole('button', { name: 'Use October’s demand for every month' }).click();
	// A new object draws on the dam; a river abstraction shows its pump and pool.
	const source = objects.getByLabel('Water for Mill');
	await expect(source).toHaveValue('dam');
	await expect(objects.getByLabel('River pump capacity for Mill (m³/day)')).toHaveCount(0);
	await source.selectOption('river');
	await objects.getByLabel('Number of pumps for Mill').fill('2');
	await objects.getByLabel('m³/h per pump for Mill').fill('10');
	await expect(objects.getByLabel('River pump capacity for Mill (m³/day)')).toHaveValue('480');
	await objects.getByLabel('Pool at the pump for Mill (m³)').fill('3000');

	const supply = page.getByRole('group', { name: 'Supply', exact: true });
	await supply.getByLabel('Water for the crops').selectOption('river');
	await supply.getByLabel('River pump capacity for the crops (m³/day)').fill('1500');
	await expectNoViolations(page, { include: '.detail' });
	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);

	await page.reload();
	await openNodeForm(page);
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: unit });
	const again = page.getByRole('group', { name: 'Demand objects', exact: true });
	await expect(again.getByLabel('Water for Mill')).toHaveValue('river');
	await expect(again.getByLabel('River pump capacity for Mill (m³/day)')).toHaveValue('480');
	await expect(again.getByLabel('Pool at the pump for Mill (m³)')).toHaveValue(/^3\s000$/);
	const supplyAgain = page.getByRole('group', { name: 'Supply', exact: true });
	await expect(supplyAgain.getByLabel('Water for the crops')).toHaveValue('river');
	await expect(supplyAgain.getByLabel('River pump capacity for the crops (m³/day)')).toHaveValue(/^1\s500$/);
	await expect(supplyAgain.getByLabel('Pool at the pump for the crops (m³)')).toHaveValue('');
	// Under river first the unit's own pump sits in the same group: each field reads apart, and typing a
	// capacity clears that pump's calculator.
	await supplyAgain.getByLabel('Supply rule', { exact: true }).selectOption({ label: 'River first' });
	await supplyAgain.getByLabel('Number of pumps', { exact: true }).fill('1');
	await supplyAgain.getByLabel('m³/h per pump', { exact: true }).fill('20');
	await expect(supplyAgain.getByLabel('River pump capacity (m³/day)', { exact: true })).toHaveValue('480');
	await expect(supplyAgain.getByLabel('River pump capacity for the crops (m³/day)')).toHaveValue(/^1\s500$/);
	await supplyAgain.getByLabel('River pump capacity for the crops (m³/day)').fill('900');
	await expect(supplyAgain.getByLabel('Number of pumps for the crops')).toHaveValue('');
	await expect(supplyAgain.getByLabel('River pump capacity (m³/day)', { exact: true })).toHaveValue('480');
	await page.setViewportSize({ width: 390, height: 844 });
	await expectNoViolations(page, { include: '.detail' });
	await page.setViewportSize({ width: 1440, height: 900 });
	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);

	// The model runs with them (the engine checks its own balance, pools included).
	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('River abstractions');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'River abstractions' })).toBeVisible();
});
