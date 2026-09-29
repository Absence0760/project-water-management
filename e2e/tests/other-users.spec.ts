// Other water users (roadmap WP-1.33, docs/model.md §2.7c): add a town to the
// Network tab, give it a monthly demand, a return share and a priority, save,
// reload, run, and read its results and its curtailment row.
import type { Page } from '@playwright/test';
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openNodeTable, saveModelChanges } from '../support/network.ts';

const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });

test('add a town as an other water user, save, run, and see what it took', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Town on the river');
	await page.goto(`/projects/${project.id}?tab=network`);
	await openNodeTable(page);

	await page.getByRole('button', { name: '+ Add other user' }).click();
	const users = page.getByRole('region', { name: /^Other water users/ });
	await expect(users).toBeVisible();
	await users.getByLabel('User name').fill('Town');
	await users.getByLabel('Demand of Town in Oct, m³/day').fill('800');
	await users.getByRole('button', { name: 'Use October’s demand for every month' }).click();
	await expect(users.getByLabel('Demand of Town in Jul, m³/day')).toHaveValue('800');
	await users.getByLabel('Share returned (%)').fill('40');
	await expect(users.getByLabel('Priority', { exact: true })).toHaveValue('senior');
	// In the node table a user has none of the farm fields.
	await expect(page.getByLabel('Kind of Town')).toHaveValue('user');
	const tableRow = page.getByRole('row').filter({ has: page.getByLabel('Kind of Town') });
	await expect(tableRow.getByText('not used for an other water user').first()).toBeAttached();
	// The schematic draws and lists it.
	await expect(page.getByRole('list', { name: 'Drainage tree' }).getByText(/^\s*Town, user, level 2/)).toBeAttached();

	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);
	await page.reload();
	await openNodeTable(page);
	const again = page.getByRole('region', { name: /^Other water users/ });
	await expect(again.getByLabel('Demand of Town in Mar, m³/day')).toHaveValue('800');
	await expect(again.getByLabel('Share returned (%)')).toHaveValue('40');

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('With town');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'With town' })).toBeVisible();
	// Other water users are listed once (issue #137), in the curtailment report on Units & supply (since
	// issue #17): the Summary no longer draws its own table, and links there.
	await expect(page.locator('table.users')).toHaveCount(0);
	const toUsers = page.getByTestId('other-uses-link');
	await expect(toUsers).toHaveText('Other water users: the curtailment targets on Units & supply.');
	await toUsers.getByRole('link').click();
	await expect(page).toHaveURL(/[?&]tab=supply\b.*#res-curtailment$/);
	// Apart from the units, not curtailed (senior), with its demand and the share of it supplied.
	const other = page.getByRole('table', { name: 'Other water users' });
	await expect(other).toHaveCount(1);
	const row = other.getByRole('row', { name: /^Town/ });
	await expect(row).toContainText('senior (not curtailed)');
	await expect(row.getByRole('cell').nth(1)).toHaveText('800');
	await expect(row.getByRole('cell').nth(3)).toHaveText(/^\d+(\.\d)?%$/);
	// No Other uses section: the curtailment table is the page's one copy.
	await expect(page.getByRole('region', { name: 'Other uses of water' })).toHaveCount(0);
	await expect(page.locator('table.users')).toHaveCount(0);
});
