// Boreholes and stream depletion (roadmap WP-1.34, docs/model.md §2.7d): give
// a farm boreholes in the one-node form, save, reload, run, and read what it
// pumped and the depletion the river took for it.
import type { Page } from '@playwright/test';
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });

test('edit a farm’s boreholes, run, and see the groundwater and stream depletion', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Boreholes');
	await page.goto(`/projects/${project.id}?tab=network`);
	await page.getByRole('button', { name: 'One node' }).click();
	await page.getByLabel('Node to edit').selectOption({ label: '2. Upper farm · farm' });

	const group = page.getByRole('group', { name: 'Groundwater (boreholes)' });
	await group.getByLabel('Borehole capacity (m³/day)').fill('600');
	await group.getByLabel('Borehole rule').selectOption('primary');
	await group.getByLabel('Stream depletion (%)').fill('50');
	await group.getByLabel('Depletion lag (days)').fill('10');
	await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
	await expect(saveBar(page)).toHaveCount(0);

	await page.reload();
	await page.getByRole('button', { name: 'One node' }).click();
	await page.getByLabel('Node to edit').selectOption({ label: '2. Upper farm · farm' });
	const again = page.getByRole('group', { name: 'Groundwater (boreholes)' });
	await expect(again.getByLabel('Borehole capacity (m³/day)')).toHaveValue('600');
	await expect(again.getByLabel('Borehole rule')).toHaveValue('primary');
	await expect(again.getByLabel('Stream depletion (%)')).toHaveValue('50');
	// A gauge has no groundwater group.
	await page.getByLabel('Node to edit').selectOption({ label: '1. Outflow gauge · gauge' });
	await expect(page.getByRole('group', { name: 'Groundwater (boreholes)' })).toHaveCount(0);

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('Pumping');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Pumping' })).toBeVisible();
	await expect(page.getByRole('heading', { level: 3, name: 'Groundwater' })).toBeVisible();
	const row = page.locator('table.groundwater').getByRole('row', { name: /^Upper farm/ });
	await expect(row).toBeVisible();
	// Primary boreholes pump up to 600 m³/day, and half of it comes out of the river.
	const pumped = Number((await row.getByRole('cell').first().innerText()).replace(/,/g, ''));
	expect(pumped).toBeGreaterThan(0);
	expect(pumped).toBeLessThanOrEqual(600);
	await expect(row.getByRole('cell').nth(2)).not.toHaveText('0');
	// The run warns about the calibration record measured while they pumped.
	await expect(page.getByText(/boreholes that deplete the river/).first()).toBeAttached();
});
