// A demand object's source (engine 1.56.0, issue #54 Q11, docs/model.md
// §2.7f): the node form records where the number comes from, the source sets
// how the demand is given, and the run's demand-objects table lists it with
// the demand by source.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openNodeForm, saveModelChanges } from '../support/network.ts';

const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });

test('record where a demand comes from: the source sets the sizing, is saved, and is listed in the run', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Demand source');
	await page.goto(`/projects/${project.id}?tab=network`);
	await openNodeForm(page);
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '2. Upper farm · hydrological unit' });

	const group = page.getByRole('group', { name: 'Demand objects', exact: true });
	await group.getByLabel('Category of the new demand object').selectOption('domestic');
	await group.getByRole('button', { name: '+ Add demand' }).click();
	await group.getByLabel('Name').fill('Village');
	const source = group.getByLabel('Source of the number');
	const sizing = group.getByLabel('Demand given as');
	// A new object's source isn't recorded, and the modeller picks the sizing.
	await expect(source).toHaveValue('');
	await expect(sizing).toHaveValue('perUnit');
	await expect(sizing).toBeEnabled();
	// A meter record is a volume: m³/day by month, and the sizing is the source's.
	await source.selectOption('meter');
	await expect(sizing).toHaveValue('monthly');
	await expect(sizing).toBeDisabled();
	await expect(group.getByText('Set by the source.')).toBeVisible();
	await expect(group.getByLabel('Demand of Village in Oct, m³/day')).toBeVisible();
	// Population × litres a day: a count × litres, the Red Book norm to start.
	await source.selectOption('perCapita');
	await expect(sizing).toHaveValue('perUnit');
	await expect(sizing).toBeDisabled();
	await expect(group.getByLabel('Litres per person a day')).toHaveValue('230');
	await group.getByLabel('Number of people').fill('1000');
	await group.getByLabel('Source details').fill('2021 census × Red Book §J');
	await expectNoViolations(page, { include: '.detail' });
	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);

	await page.reload();
	await openNodeForm(page);
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '2. Upper farm · hydrological unit' });
	const again = page.getByRole('group', { name: 'Demand objects', exact: true });
	await expect(again.getByLabel('Source of the number')).toHaveValue('perCapita');
	await expect(again.getByLabel('Demand given as')).toBeDisabled();
	await expect(again.getByLabel('Source details')).toHaveValue('2021 census × Red Book §J');

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('With a village');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'With a village' })).toBeVisible();
	await page.getByTestId('other-uses-link').getByRole('link', { name: 'Other uses on Hydrological units' }).click();
	const uses = page.getByRole('region', { name: 'Other uses of water' });
	const table = uses.getByTestId('demand-objects-table');
	await expect(table.getByRole('columnheader', { name: 'Source' })).toBeVisible();
	await expect(table.getByRole('row', { name: /Village/ }).getByRole('cell', { name: 'Per-capita norm' })).toBeVisible();
	await expect(uses.getByTestId('demand-objects-sources')).toHaveText(/^Of their demand, 100% is from a per-capita norm\./);
});
