// Demand objects (engine 1.7.0, issue #54 item 2b, docs/model.md §2.7f):
// give a unit a town demand in the one-node form, save, reload, run, and read
// its supply in the run's demand-objects table.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openNodeForm, saveModelChanges } from '../support/network.ts';
import { ungroup } from '../support/format.ts';

const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });

test('add a town demand to a unit, save, reload, run, and see what it was supplied', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Demand objects');
	await page.goto(`/projects/${project.id}?tab=network`);
	await openNodeForm(page);
	await page.getByLabel('Node to edit').selectOption({ label: '2. Upper farm · unit' });

	const group = page.getByRole('group', { name: 'Demand objects', exact: true });
	await expect(group.getByText('No demand objects on Upper farm.')).toBeVisible();
	await group.getByLabel('Category of the new demand object').selectOption('municipal');
	await group.getByRole('button', { name: '+ Add demand' }).click();
	await group.getByLabel('Name').fill('Town');
	// A municipal object starts first in line, returning half of what it gets (the 2b research defaults).
	await expect(group.getByLabel('Priority')).toHaveValue('first');
	await expect(group.getByLabel('Share returned (%)')).toHaveValue('50');
	await group.getByLabel('Demand of Town in Oct, m³/day').fill('400');
	await group.getByRole('button', { name: 'Use October’s demand for every month' }).click();
	await expect(group.getByLabel('Demand of Town in Sep, m³/day')).toHaveValue('400');
	await expect(group.getByTestId(/^demand-object-mean-/)).toHaveText('400 m³/day on average.');
	// Piped out: nothing can return, so the share is set to 0 and locked.
	await group.getByLabel('Destination').selectOption('external');
	await expect(group.getByLabel('Share returned (%)')).not.toBeEditable();
	await expect(group.getByLabel('Share returned (%)')).toHaveValue('0');
	await group.getByLabel('Destination').selectOption('internal');
	await group.getByLabel('Share returned (%)').fill('40');
	await expectNoViolations(page, { include: '.detail' });
	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);

	await page.reload();
	await openNodeForm(page);
	await page.getByLabel('Node to edit').selectOption({ label: '2. Upper farm · unit' });
	const again = page.getByRole('group', { name: 'Demand objects', exact: true });
	await expect(again.getByLabel('Name')).toHaveValue('Town');
	await expect(again.getByLabel('Demand of Town in Mar, m³/day')).toHaveValue('400');
	await expect(again.getByLabel('Share returned (%)')).toHaveValue('40');
	// A gauge has none.
	await page.getByLabel('Node to edit').selectOption({ label: '1. Outflow gauge · gauge' });
	await expect(page.getByRole('group', { name: 'Demand objects', exact: true })).toHaveCount(0);

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('With a town');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'With a town' })).toBeVisible();
	await expect(page.getByRole('heading', { level: 3, name: 'Demand objects' })).toBeVisible();
	const row = page.getByTestId('demand-objects-table').getByRole('row', { name: /Town/ });
	await expect(row.getByRole('cell').nth(0)).toHaveText('Upper farm');
	await expect(row.getByRole('cell').nth(2)).toHaveText('400');
	const supplied = ungroup(await row.getByRole('cell').nth(3).innerText());
	expect(supplied).toBeGreaterThan(0);
	expect(supplied).toBeLessThanOrEqual(400);
});
