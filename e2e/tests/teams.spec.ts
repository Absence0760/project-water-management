// Teams: create one, add a colleague, create a catchment in the team, and see
// it grouped on both people's project lists; the last admin can't leave.
import { AxeBuilder } from '@axe-core/playwright';
import { uniqueEmail } from '../support/api.ts';
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

test('a team admin invites an address with no account and revokes it', async ({ page, owner }) => {
	void owner;
	const res = await page.request.post(`${API_URL}/teams`, { data: { name: 'Invite Hydrology' } });
	const { team } = (await res.json()) as { team: { id: string } };
	const email = uniqueEmail('team-invitee');

	await page.goto(`/teams/${team.id}`);
	await page.getByLabel('Add member by email').fill(email);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.getByText(`Invitation sent to ${email}.`)).toBeVisible();
	// Member count is unchanged: an invite isn't a member.
	await expect(page.getByText('1 member ·')).toBeVisible();

	const pending = page.getByRole('region', { name: /Pending invitations/ });
	await expect(pending.getByRole('listitem').filter({ hasText: email })).toContainText('member');

	page.once('dialog', (d) => void d.accept());
	await pending.getByRole('button', { name: `Revoke invitation to ${email}` }).click();
	await expect(page.getByText(`Invitation to ${email} revoked.`)).toBeVisible();
	await expect(pending).toHaveCount(0);
});

test('a team viewer reads the team’s catchments but can’t add to the team', async ({ page, owner, signIn }) => {
	void owner;
	const res = await page.request.post(`${API_URL}/teams`, { data: { name: 'Review Board' } });
	const { team } = (await res.json()) as { team: { id: string } };
	expect((await page.request.post(`${API_URL}/projects`, { data: { name: 'Reviewed catchment', teamId: team.id } })).status()).toBe(201);
	const reviewer = await signIn('Team reviewer');

	// The admin adds them read-only with the role picker.
	await page.goto(`/teams/${team.id}`);
	await page.getByLabel('Add member by email').fill(reviewer.user.email);
	await page.getByLabel('Role', { exact: true }).selectOption('viewer');
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.getByText('Team reviewer added as viewer.')).toBeVisible();
	await expect(page.getByLabel('Team role for Team reviewer')).toHaveValue('viewer');
	await expect(page.getByRole('region', { name: 'Members' }).getByRole('definition')).toHaveText([
		"Reads every team project and its runs, but can't change or run anything.",
		'Edits every team project: model, data and runs.',
		'Owner of every team project (delete, share, move) and manages this team.'
	]);

	// They see the team's project as a viewer, with no way to delete it.
	await reviewer.page.goto('/');
	const group = reviewer.page.getByRole('region', { name: 'Review Board' });
	const row = group.getByRole('row').filter({ has: reviewer.page.getByRole('rowheader', { name: 'Reviewed catchment' }) });
	await expect(row.getByRole('cell', { name: 'viewer', exact: true })).toBeVisible();
	await expect(row.getByRole('button', { name: /^Delete/ })).toHaveCount(0);

	// The team page doesn't offer to add a project, and neither does New project.
	await reviewer.page.goto(`/teams/${team.id}`);
	await expect(reviewer.page.getByRole('heading', { level: 1, name: 'Review Board' })).toBeVisible();
	await expect(reviewer.page.getByText('Only admins can manage members.')).toBeVisible();
	await expect(reviewer.page.getByRole('link', { name: 'New project in this team' })).toHaveCount(0);
	await reviewer.page.goto(`/?owner=team:${team.id}&new=1`);
	const np = reviewer.page.getByRole('dialog', { name: 'New project' });
	await expect(np.getByLabel('Belongs to').locator('option')).toHaveText(['Personal']);

	// Promoted to member, they can.
	await page.getByLabel('Team role for Team reviewer').selectOption('member');
	await expect(page.getByLabel('Team role for Team reviewer')).toHaveValue('member');
	await reviewer.page.goto(`/teams/${team.id}`);
	await expect(reviewer.page.getByRole('link', { name: 'New project in this team' })).toBeVisible();
});
