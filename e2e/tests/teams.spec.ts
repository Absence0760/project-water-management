// Teams: create one, add a colleague, create a catchment in the team, and see
// it grouped on both people's project lists; the last admin can't leave.
import { AxeBuilder } from '@axe-core/playwright';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

test('a team owns catchments together', async ({ page, owner, signIn }) => {
	void owner;
	const colleague = await signIn('Team colleague');

	await page.goto('/teams');
	await expect(page.getByText("You're not in any team yet.")).toBeVisible();
	await page.getByRole('button', { name: 'New team' }).first().click();
	const dialog = page.getByRole('dialog', { name: 'New team' });
	await dialog.getByLabel('Team name').fill('Breede Hydrology');
	await dialog.getByRole('button', { name: 'Create team' }).click();

	// Lands on the team page as its admin.
	await expect(page.getByRole('heading', { level: 1, name: 'Breede Hydrology' })).toBeVisible();
	await page.getByLabel('Add member by email').fill(colleague.user.email);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	const members = page.getByRole('region', { name: 'Members' });
	await expect(members.getByRole('rowheader', { name: /Team colleague/ })).toBeVisible();

	// The only admin is told to hand over before leaving (no request sent).
	await page.getByRole('button', { name: 'Leave team' }).click();
	await expect(page.getByRole('alert')).toContainText('You are the only admin');

	// New project in this team: the dialog opens with the team preselected.
	await page.getByRole('link', { name: 'New project in this team' }).click();
	const np = page.getByRole('dialog', { name: 'New project' });
	await expect(np.getByLabel('Belongs to')).toHaveValue(/.+/);
	await expect(np.getByLabel('Belongs to').locator('option:checked')).toHaveText('Breede Hydrology');
	await np.getByLabel('Name').fill('Upper Breede — baseline');
	await np.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Upper Breede — baseline' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Team' })).toContainText('Belongs to Breede Hydrology');

	// The colleague sees it under the team's group, as an editor.
	await colleague.page.goto('/');
	const group = colleague.page.getByRole('region', { name: 'Breede Hydrology' });
	const row = group.getByRole('row').filter({ has: colleague.page.getByRole('rowheader', { name: 'Upper Breede — baseline' }) });
	await expect(row.getByRole('cell', { name: 'editor', exact: true })).toBeVisible();
	await expect(row.getByRole('button', { name: /^Delete/ })).toHaveCount(0);

	// Filter by team and search both narrow the list (and live in the URL).
	await colleague.page.getByRole('navigation', { name: 'Filter by owner' }).getByRole('link', { name: /Breede Hydrology/ }).click();
	await expect(colleague.page).toHaveURL(/owner=team%3A|owner=team:/);
	await colleague.page.getByLabel('Search projects').fill('nothing like this');
	await expect(colleague.page.getByText(/No projects in Breede Hydrology match/)).toBeVisible();
});

test('team pages have no WCAG 2.1 AA violations', async ({ page, owner }) => {
	void owner;
	const res = await page.request.post(`${API_URL}/teams`, { data: { name: 'Accessible team' } });
	const { team } = (await res.json()) as { team: { id: string } };
	for (const path of ['/teams', `/teams/${team.id}`]) {
		await page.goto(path);
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		await expect(page.getByText('Loading…')).toHaveCount(0);
		const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
		expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
	}
});
