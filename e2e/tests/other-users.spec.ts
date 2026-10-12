// Other water users (roadmap WP-1.33, docs/model.md §2.7c): add a town to the
// Network tab, give it a monthly demand, a return share, a priority and a fixed
// restriction % (engine 1.86.0, issue #523 B3), save,
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
	const grid = await openNodeTable(page);

	// The node table's own toolbar button: the page header has one too, behind the modal.
	await grid.getByRole('button', { name: '+ Add other user' }).click();
	const users = page.getByRole('region', { name: /^Other water users/ });
	await expect(users).toBeVisible();
	await users.getByLabel('User name').fill('Town');
	await users.getByLabel('Demand of Town in Oct, m³/day').fill('800');
	await users.getByRole('button', { name: 'Use October’s demand for every month' }).click();
	await expect(users.getByLabel('Demand of Town in Jul, m³/day')).toHaveValue('800');
	await users.getByLabel('Share returned (%)').fill('40');
	await expect(users.getByLabel('Priority', { exact: true })).toHaveValue('senior');
	// Stored as senior, shown as Priority (issue #507 item 4).
	await expect(users.getByLabel('Priority', { exact: true }).locator('option:checked')).toHaveText('Priority (default): hydrological units upstream pass its demand first');
	// A new user is a priority user, a claim on every unit upstream: the form says so (issue #507).
	await expect(users.getByTestId('user-priority-note')).toHaveText(
		'Priority is the default. Every hydrological unit upstream passes its demand before filling its dam or irrigating, so adding a priority user changes what the farms upstream get.'
	);
	// A Priority user's fixed restriction % (engine 1.86.0, issue #523 B3): blank is uncurtailed; a % has no
	// basic-needs floor; a Non-priority user has none, and switching to it clears the %.
	const restriction = users.getByLabel('Fixed restriction (%)');
	await expect(restriction).toHaveValue('');
	await expect(users.getByTestId('user-restriction-note')).toHaveText('Blank is uncurtailed: its EWR charge stands and the drought restriction rule doesn’t cut it.');
	await restriction.fill('25');
	await restriction.blur();
	await expect(users.getByTestId('user-restriction-note')).toHaveText(
		'Restricted, it gives up 25 % of its demand: in a curtailment, and while the drought restriction rule is in force. No basic-needs floor: the model doesn’t know the people it serves.'
	);
	await users.getByLabel('Priority', { exact: true }).selectOption('junior');
	await expect(users.getByLabel('Fixed restriction (%)')).toHaveCount(0);
	await users.getByLabel('Priority', { exact: true }).selectOption('senior');
	await expect(restriction).toHaveValue('');
	await restriction.fill('25');
	await restriction.blur();
	// In the node table a user has none of the farm fields.
	await expect(page.getByLabel('Kind of Town')).toHaveValue('user');
	const tableRow = page.getByRole('row').filter({ has: page.getByLabel('Kind of Town') });
	await expect(tableRow.getByText('not used for an other water user').first()).toBeAttached();
	// The schematic draws and lists it.
	await expect(page.getByRole('list', { name: 'Drainage tree' }).getByText(/^\s*Town, other water user, level 2/)).toBeAttached();

	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);
	await page.reload();
	await openNodeTable(page);
	const again = page.getByRole('region', { name: /^Other water users/ });
	await expect(again.getByLabel('Demand of Town in Mar, m³/day')).toHaveValue('800');
	await expect(again.getByLabel('Share returned (%)')).toHaveValue('40');
	await expect(again.getByLabel('Fixed restriction (%)')).toHaveValue('25');

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('With town');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'With town' })).toBeVisible();
	// Other water users are listed once (issue #137), in the curtailment report on Hydrological units (since
	// issue #17): the Summary no longer draws its own table, and links there.
	await expect(page.locator('table.users')).toHaveCount(0);
	const toUsers = page.getByTestId('other-uses-link');
	await expect(toUsers).toHaveText('Other water users: the curtailment targets on Hydrological units.');
	await toUsers.getByRole('link').click();
	await expect(page).toHaveURL(/[?&]tab=supply\b.*#res-curtailment$/);
	// Apart from the units, a priority user curtailed only by its fixed %, with no basic-needs floor, with its
	// demand and the share of it supplied.
	const other = page.getByRole('table', { name: 'Other water users' });
	await expect(other).toHaveCount(1);
	const row = other.getByRole('row', { name: /^Town/ });
	await expect(row).toContainText('Priority (25 %: fixed %, no basic-needs floor)');
	await expect(row.getByRole('cell').nth(1)).toHaveText('800');
	await expect(row.getByRole('cell').nth(3)).toHaveText(/^\d+(\.\d)?%$/);
	// No Other uses section: the curtailment table is the page's one copy.
	await expect(page.getByRole('region', { name: 'Other uses of water' })).toHaveCount(0);
	await expect(page.locator('table.users')).toHaveCount(0);
});
