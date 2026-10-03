// Teams: create one, add a colleague, create a catchment in the team, and see
// it grouped on both people's project lists; the last admin can't leave.
// The pages as laid out for the app frame (issue #17): the list's cards, the
// team page's projects beside members, and the settings sheet.
import type { APIRequestContext } from '@playwright/test';
import { acceptInvites, createRun, putModel, sampleModel, seedRunnableProject, uniqueEmail } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';
import { closeTeamSettings, openTeamSettings } from '../support/teams.ts';
import { answerConfirm } from '../support/confirm.ts';

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
	// An invitation, even for an account that exists (issue #136): a member once they accept it.
	await expect(page.getByText(`Invitation sent to ${colleague.user.email}. They’ll join as editor once they accept it.`)).toBeVisible();
	const members = page.getByRole('region', { name: 'Members' });
	await expect(members.getByRole('rowheader', { name: /Team colleague/ })).toHaveCount(0);
	expect(await acceptInvites(colleague.user.email, new URL(page.url()).pathname.split('/').at(-1)!)).toBe(1);
	await page.reload();
	await expect(members.getByRole('rowheader', { name: /Team colleague/ })).toBeVisible();

	// The only admin is told to hand over before leaving (no request sent), in the settings sheet.
	const settings = await openTeamSettings(page);
	await settings.getByRole('button', { name: 'Leave team' }).click();
	await expect(settings.getByRole('alert')).toContainText('You are the only owner');
	await closeTeamSettings(page);

	// New project in the header: the dialog opens with the team preselected.
	await page.getByRole('link', { name: 'New project', exact: true }).click();
	const np = page.getByRole('dialog', { name: 'New project' });
	await expect(np.getByLabel('Belongs to')).toHaveValue(/.+/);
	await expect(np.getByLabel('Belongs to').locator('option:checked')).toHaveText('Breede Hydrology');
	await np.getByLabel('Name').fill('Upper Breede — baseline');
	await np.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByTestId('project-name').filter({ hasText: 'Upper Breede — baseline' })).toBeVisible();
	await page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Project', exact: true }).click();
	await expect(page.getByRole('region', { name: 'Team' })).toContainText('Belongs to Breede Hydrology');

	// The colleague sees it under the team's group, as an editor.
	await colleague.page.goto('/');
	const group = colleague.page.getByRole('region', { name: 'Breede Hydrology' });
	const row = group.getByRole('row').filter({ has: colleague.page.getByRole('rowheader', { name: 'Upper Breede — baseline' }) });
	await expect(row.getByTestId('project-role')).toHaveText('editor');
	// Copy and Delete sit in the row's ⋯ menu; only an owner gets Delete.
	await row.getByRole('button', { name: /^More actions for / }).click();
	await expect(row.getByRole('button', { name: /^Copy / })).toBeVisible();
	await expect(row.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
	await colleague.page.keyboard.press('Escape');

	// Filter by team and search both narrow the list (and live in the URL).
	await colleague.page.getByRole('navigation', { name: 'Filter by owner' }).getByRole('link', { name: /Breede Hydrology/ }).click();
	await expect(colleague.page).toHaveURL(/owner=team%3A|owner=team:/);
	await colleague.page.getByLabel('Search projects').fill('nothing like this');
	await expect(colleague.page.getByText(/No projects in Breede Hydrology match/)).toBeVisible();
});

test('a team name that shows as nothing is refused in the form, and a bidi control is dropped (issue #383)', async ({ page, owner }) => {
	void owner;
	await page.goto('/teams');
	await page.getByRole('button', { name: 'New team' }).first().click();
	const dialog = page.getByRole('dialog', { name: 'New team' });
	await dialog.getByLabel('Team name').fill('\u2066\u2069\u200b');
	await dialog.getByRole('button', { name: 'Create team' }).click();
	await expect(dialog.getByRole('alert')).toHaveText('The team needs a name.');
	await dialog.getByLabel('Team name').fill('Berg\u202enimda');
	await dialog.getByRole('button', { name: 'Create team' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Bergnimda' })).toBeVisible();
});

test('team pages have no WCAG 2.1 AA violations', async ({ page, owner }) => {
	void owner;
	const res = await page.request.post(`${API_URL}/teams`, { data: { name: 'Accessible team' } });
	const { team } = (await res.json()) as { team: { id: string } };
	for (const path of ['/teams', `/teams/${team.id}`]) {
		await page.goto(path);
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		await expect(page.getByText('Loading…')).toHaveCount(0);
		await expectNoViolations(page, { tags: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] });
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
	// A team `member` reads as an editor, the project role it gives (#162).
	await expect(pending.getByRole('listitem').filter({ hasText: email })).toContainText('editor');

	await pending.getByRole('button', { name: `Revoke invitation to ${email}` }).click();
	await answerConfirm(page, true, 'Revoke this invitation?');
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
	await expect(page.getByText(`Invitation sent to ${reviewer.user.email}. They’ll join as viewer once they accept it.`)).toBeVisible();
	expect(await acceptInvites(reviewer.user.email, team.id)).toBe(1);
	await page.reload();
	await expect(page.getByLabel('Team role for Team reviewer')).toHaveValue('viewer');
	// One set of role names across teams and projects (#162): the picker and the key say Viewer / Editor / Owner.
	await expect(page.getByLabel('Role', { exact: true }).locator('option')).toHaveText(['viewer', 'editor', 'owner']);
	await expect(page.getByRole('region', { name: 'Members' }).getByRole('term')).toHaveText(['Viewer', 'Editor', 'Owner']);
	await expect(page.getByRole('region', { name: 'Members' }).getByRole('definition')).toHaveText([
		"Reads every team project and its runs, but can't change or run anything.",
		'Edits every team project: model, data and runs.',
		'Owns every team project (delete, share, move) and manages this team.'
	]);

	// They see the team's project as a viewer, with no way to delete it.
	await reviewer.page.goto('/');
	const group = reviewer.page.getByRole('region', { name: 'Review Board' });
	const row = group.getByRole('row').filter({ has: reviewer.page.getByRole('rowheader', { name: 'Reviewed catchment' }) });
	await expect(row.getByTestId('project-role')).toHaveText('viewer');
	// Copy and Delete sit in the row's ⋯ menu; only an owner gets Delete.
	await row.getByRole('button', { name: /^More actions for / }).click();
	await expect(row.getByRole('button', { name: /^Copy / })).toBeVisible();
	await expect(row.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
	await reviewer.page.keyboard.press('Escape');

	// The team page doesn't offer to add a project, and neither does New project.
	await reviewer.page.goto(`/teams/${team.id}`);
	await expect(reviewer.page.getByRole('heading', { level: 1, name: 'Review Board' })).toBeVisible();
	await expect(reviewer.page.getByText('Only owners can manage members.')).toBeVisible();
	await expect(reviewer.page.getByRole('link', { name: 'New project', exact: true })).toHaveCount(0);
	await reviewer.page.goto(`/?owner=team:${team.id}&new=1`);
	const np = reviewer.page.getByRole('dialog', { name: 'New project' });
	await expect(np.getByLabel('Belongs to').locator('option')).toHaveText(['Personal']);

	// Promoted to member, they can. The select shows the new value before the
	// server has saved it, so wait for the save itself.
	const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(`/teams/${team.id}/members/`));
	await page.getByLabel('Team role for Team reviewer').selectOption('member');
	expect((await saved).ok()).toBe(true);
	await expect(page.getByLabel('Team role for Team reviewer')).toHaveValue('member');
	await reviewer.page.goto(`/teams/${team.id}`);
	await expect(reviewer.page.getByRole('link', { name: 'New project', exact: true })).toBeVisible();
});

test('only a team admin edits the EWR traffic lights; a member reads which apply', async ({ page, owner, signIn }) => {
	void owner;
	const res = await page.request.post(`${API_URL}/teams`, { data: { name: 'Lights Board' } });
	const { team } = (await res.json()) as { team: { id: string } };
	const colleague = await signIn('Lights member');
	expect((await page.request.post(`${API_URL}/teams/${team.id}/members`, { data: { email: colleague.user.email, role: 'member' } })).status()).toBe(201);
	await acceptInvites(colleague.user.email, team.id);

	// The admin: the defaults, said to be waiting for the hydrologist, and a form.
	// They live in the team settings sheet, out of the page's reading path; the page states the rule.
	await page.goto(`/teams/${team.id}`);
	await expect(page.getByRole('region', { name: 'Projects' })).toContainText('No projects yet.');
	const panel = (await openTeamSettings(page)).getByRole('region', { name: 'EWR traffic lights' });
	await expect(panel).toContainText('green when it was not met on under 5 % of them, amber under 20 %, red otherwise');
	await expect(panel).toContainText('These are the default thresholds: a provisional default, not yet confirmed by the catchment’s hydrologist.');
	await expect(panel.getByLabel('Green below (%)')).toHaveValue('5');
	await expect(panel.getByLabel('Amber below (%)')).toHaveValue('20');
	const save = panel.getByRole('button', { name: 'Save thresholds' });
	await expect(save).toBeDisabled(); // nothing changed yet
	await expect(panel.getByRole('alert')).toHaveCount(0);
	await expect(panel.getByRole('button', { name: 'Use the defaults' })).toHaveCount(0);

	// Green not below amber: said, and not sendable.
	await panel.getByLabel('Green below (%)').fill('20');
	await expect(panel.getByRole('alert')).toHaveText('The green cut-off must be below the amber one.');
	await expect(panel.getByLabel('Green below (%)')).toHaveAttribute('aria-invalid', 'true');
	await expect(save).toBeDisabled();

	await panel.getByLabel('Green below (%)').fill('2.5');
	await panel.getByLabel('Amber below (%)').fill('12.5');
	await expect(panel.getByRole('alert')).toHaveCount(0);
	await save.click();
	await expect(panel.getByRole('status')).toHaveText('Saved. The team’s projects are now judged by these thresholds.');
	await expect(panel).toContainText('green when it was not met on under 2.5 % of them, amber under 12.5 %, red otherwise');
	await expect(panel).toContainText('These are the team’s own thresholds.');

	// The member reads them, and has no form.
	await colleague.page.goto(`/teams/${team.id}`);
	const theirs = (await openTeamSettings(colleague.page)).getByRole('region', { name: 'EWR traffic lights' });
	await expect(theirs).toContainText('amber under 12.5 %');
	await expect(theirs).toContainText('Only owners can change them.');
	await expect(theirs.getByRole('button')).toHaveCount(0);
	await expect(theirs.getByRole('spinbutton')).toHaveCount(0);

	// Back to the defaults, after a reload (the saved values come from the server; `settings` keeps the sheet open).
	await page.reload();
	await expect(page).toHaveURL(/[?&]settings=1/);
	await expect(panel.getByLabel('Green below (%)')).toHaveValue('2.5');
	await panel.getByRole('button', { name: 'Use the defaults' }).click();
	await expect(panel.getByRole('status')).toHaveText('Saved. The team’s projects are judged by the default thresholds again.');
	await expect(panel.getByLabel('Green below (%)')).toHaveValue('5');
	await expect(panel).toContainText('These are the default thresholds: a provisional default, not yet confirmed by the catchment’s hydrologist.');
	await expectNoViolations(page, { tags: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] });
});

/** A team with one published catchment (a traffic light to show) and one never run. */
async function teamWithProjects(request: APIRequestContext, name: string) {
	const team = (await (await request.post(`${API_URL}/teams`, { data: { name } })).json()).team as { id: string };
	const published = await seedRunnableProject(request, `${name} published`);
	expect((await request.patch(`${API_URL}/projects/${published.id}`, { data: { teamId: team.id } })).status()).toBe(200);
	const runId = await createRun(request, published.id, 'Baseline');
	expect((await request.post(`${API_URL}/projects/${published.id}/publication`, { data: { runId } })).status()).toBe(201);
	expect((await request.post(`${API_URL}/projects`, { data: { name: `${name} empty`, teamId: team.id } })).status()).toBe(201);
	return team;
}

test('the teams list shows each team’s numbers and its projects’ traffic lights', async ({ page, owner }) => {
	void owner;
	const team = await teamWithProjects(page.request, 'Card Board');
	await page.goto('/teams');
	const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Card Board' }) });
	await expect(card.getByRole('definition').first()).toHaveText('2'); // projects
	await expect(card).toContainText(/1 (red|amber|unknown), 1 (unknown|green)/);
	await expect(card.getByRole('list', { name: /^Projects of Card Board/ }).getByRole('link')).toHaveCount(2);
	await expect(card.getByText('Unknown: no run yet')).toBeVisible();
	// The team's catchments in full: the project list filtered to the team, worst EWR first (issue #176).
	await card.getByRole('link', { name: 'Project list' }).click();
	await expect(page).toHaveURL(new RegExp(`/\\?owner=team:${team.id}&sort=status$`));
	await expect(page.getByRole('table').getByRole('rowheader')).toHaveCount(2);
});

for (const [sizeName, viewport] of [
	['desktop', { width: 1440, height: 960 }],
	['phone', { width: 390, height: 844 }]
] as const) {
	test.describe(sizeName, () => {
		test.use({ viewport });

		test('the team page leads with the projects, members beside them on a wide screen and below on a phone', async ({ page, owner }) => {
			void owner;
			const team = await teamWithProjects(page.request, `Layout ${sizeName}`);
			await page.goto(`/teams/${team.id}`);
			const projects = page.getByRole('region', { name: 'Projects' });
			const members = page.getByRole('region', { name: 'Members' });
			await expect(projects.getByRole('list', { name: /^Projects of/ }).getByRole('listitem')).toHaveCount(2);
			await expect(projects.getByText('Unknown: no run yet')).toBeVisible();
			await expect(projects).toContainText('Traffic lights: green when it was not met on under 5 % of them');
			const p = (await projects.boundingBox())!;
			const m = (await members.boundingBox())!;
			if (sizeName === 'desktop') {
				// Side by side, top-aligned, the projects the wider column.
				expect(m.x).toBeGreaterThanOrEqual(p.x + p.width);
				expect(Math.abs(m.y - p.y)).toBeLessThan(2);
				expect(p.width).toBeGreaterThan(m.width * 1.5);
			} else {
				// One column: the projects first, then the members, no sideways scroll.
				expect(m.y).toBeGreaterThanOrEqual(p.y + p.height);
				expect(Math.abs(m.x - p.x)).toBeLessThan(2);
				const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
				expect(scroll).toBeLessThanOrEqual(inner);
			}
			// Rename and leave/delete are out of the reading path, in the settings sheet.
			await expect(page.getByRole('button', { name: 'Delete team' })).toHaveCount(0);
			await expect(page.getByRole('button', { name: 'Rename' })).toHaveCount(0);
			await expectNoViolations(page);
			const sheet = await openTeamSettings(page);
			await expect(sheet.getByRole('button', { name: 'Delete team' })).toBeVisible();
			await expectNoViolations(page);
		});

		test('the teams list has no WCAG 2.2 AA violations', async ({ page, owner }) => {
			void owner;
			await teamWithProjects(page.request, `A11y list ${sizeName}`);
			await page.goto('/teams');
			await expect(page.getByRole('list', { name: /^Projects of/ })).toBeVisible();
			await expectNoViolations(page);
		});
	});
}

// The organisation's privacy contact (168, POPIA s18(1)(b)): set by an admin in the settings sheet, read by a
// member there, and shown to a farmer of a team catchment from the farm page's menu.
test('an admin sets the privacy contact; a member reads it; a farmer finds it from the farm menu', async ({ page, owner, signIn }) => {
	void owner;
	const res = await page.request.post(`${API_URL}/teams`, { data: { name: 'Contact Board' } });
	const { team } = (await res.json()) as { team: { id: string } };
	const colleague = await signIn('Contact member');
	expect((await page.request.post(`${API_URL}/teams/${team.id}/members`, { data: { email: colleague.user.email, role: 'member' } })).status()).toBe(201);
	await acceptInvites(colleague.user.email, team.id);

	await page.goto(`/teams/${team.id}`);
	let panel = (await openTeamSettings(page)).getByRole('region', { name: 'Privacy contact' });
	await panel.getByLabel('Name or office').fill('Information Officer');
	await panel.getByLabel('Email address').fill('io@contact-board.example');
	await panel.getByLabel('Postal address (optional)').fill('PO Box 7, Kloof 1234');
	await panel.getByRole('button', { name: 'Save contact' }).click();
	await expect(panel.getByRole('status')).toHaveText('Saved. Farmers see it from their farm page’s menu, and new invitations name it.');
	await expect(panel.getByRole('button', { name: 'Save contact' })).toBeDisabled();
	await closeTeamSettings(page);

	// A member reads it, and can't change it.
	await colleague.page.goto(`/teams/${team.id}`);
	panel = (await openTeamSettings(colleague.page)).getByRole('region', { name: 'Privacy contact' });
	await expect(panel).toContainText('Information Officer, io@contact-board.example');
	await expect(panel).toContainText('Only owners can change it.');
	await expect(panel.getByRole('button', { name: 'Save contact' })).toHaveCount(0);

	// A farmer of a team catchment: Menu → Who decides about your farm's information.
	const made = await page.request.post(`${API_URL}/projects`, { data: { name: 'Contact catchment', teamId: team.id } });
	expect(made.status(), await made.text()).toBe(201);
	const project = ((await made.json()) as { project: { id: string } }).project;
	const model = sampleModel();
	await putModel(page.request, project.id, model);
	const farmer = await signIn('Contact farmer');
	const farmId = model.nodes.find((n) => n.kind === 'farm')!.id as string;
	const add = await page.request.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: farmer.user.email, nodeIds: [farmId] } });
	expect(add.status(), await add.text()).toBe(201);
	await acceptInvites(farmer.user.email, project.id);
	await farmer.page.goto(`/farm/${project.id}`);
	await farmer.page.getByRole('button', { name: 'Menu' }).click();
	await farmer.page.getByRole('link', { name: 'Who decides about your farm’s information' }).click();
	await expect(farmer.page).toHaveURL(`/farm/${project.id}/who-decides`);
	const card = farmer.page.getByRole('region', { name: 'Contact Board' });
	await expect(card).toContainText('Contact Board decides what is done with your farm’s information in this catchment.');
	await expect(card.getByRole('link', { name: 'io@contact-board.example' })).toHaveAttribute('href', 'mailto:io@contact-board.example');
	await expect(card).toContainText('PO Box 7, Kloof 1234');
	await expectNoViolations(farmer.page);
});

test('an admin renames and deletes the team from the settings sheet; a member leaves it', async ({ page, owner, signIn }) => {
	void owner;
	const res = await page.request.post(`${API_URL}/teams`, { data: { name: 'Settings Board' } });
	const { team } = (await res.json()) as { team: { id: string } };
	const colleague = await signIn('Leaving member');
	expect((await page.request.post(`${API_URL}/teams/${team.id}/members`, { data: { email: colleague.user.email, role: 'member' } })).status()).toBe(201);
	await acceptInvites(colleague.user.email, team.id);

	// Rename: the header follows, and Back closes the sheet rather than leaving the page.
	await page.goto(`/teams/${team.id}`);
	let sheet = await openTeamSettings(page);
	await sheet.getByRole('textbox', { name: 'Team name' }).fill('Settings Board (renamed)');
	await sheet.getByRole('button', { name: 'Rename' }).click();
	await expect(sheet.getByRole('status').first()).toHaveText('Saved.');
	await page.goBack();
	await expect(sheet).toBeHidden();
	await expect(page).toHaveURL(new RegExp(`/teams/${team.id}$`));
	await expect(page.getByRole('heading', { level: 1, name: 'Settings Board (renamed)' })).toBeVisible();

	// The member leaves (the sheet has no admin parts for them) and lands on the list.
	await colleague.page.goto(`/teams/${team.id}`);
	const theirs = await openTeamSettings(colleague.page);
	await expect(theirs.getByRole('button', { name: 'Rename' })).toHaveCount(0);
	await expect(theirs.getByRole('button', { name: 'Delete team' })).toHaveCount(0);
	await theirs.getByRole('button', { name: 'Leave team' }).click();
	await answerConfirm(colleague.page, true);
	await expect(colleague.page).toHaveURL(/\/teams$/);
	await expect(colleague.page.getByText("You're not in any team yet.")).toBeVisible();

	// Delete: the sheet gives way to the confirmation, then the list.
	sheet = await openTeamSettings(page);
	await sheet.getByRole('button', { name: 'Delete team' }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole('alertdialog', { name: 'Delete team?' })).toContainText('Delete Settings Board (renamed)? Its 0 projects stay');
	await answerConfirm(page, true);
	await expect(page).toHaveURL(/\/teams$/);
	await expect(page.getByText("You're not in any team yet.")).toBeVisible();
});
