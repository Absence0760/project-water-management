// Where the focus goes after an action that takes away what had it, and what a link to something gone
// opens on (issue #521, round 4's UX hunt). Synthetic data.
//
// - A sheet a link opens through the URL (`?settings=1`, `?grid=…`, `?new=1`): SvelteKit's navigation put
//   the focus on <body> before the sheet opened, so closing it left the focus at the top of the page.
//   It goes back to the link (common/Dialog.svelte).
// - A delete takes its row, and the button that had the focus, away: the row now in its place takes it.
// - Removing a hydrological unit from its sheet left `node=` naming it in the URL.
// - A link to a deleted scenario or run said so with a Try again that could never work.
import type { Page } from '@playwright/test';
import { acceptInvites, addMember, createProject, createRun, seedRunnableProject, uniqueEmail } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll, resizeTo } from '../support/reflow.ts';
import { createScenario } from '../support/scenarios.ts';

const GONE = '00000000-0000-0000-0000-000000000000';
const openSheet = (page: Page) => page.locator('dialog[open]');

test('a sheet opened by a link hands the focus back to that link when it closes', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Focus sheets');
	await createRun(page.request, project.id, 'Base');

	// The planted-areas grid, from Crops & demand's Edit areas.
	await page.goto(`/projects/${project.id}?tab=crops`);
	const editAreas = page.getByRole('link', { name: 'Edit areas' });
	await editAreas.click();
	await expect(openSheet(page)).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(openSheet(page)).toHaveCount(0);
	await expect(editAreas).toBeFocused();

	// The new-scenario dialog, from the header's + New scenario.
	await page.goto(`/projects/${project.id}?tab=scenarios`);
	const newScenario = page.getByRole('link', { name: '+ New scenario' });
	await newScenario.click();
	await expect(page.getByRole('dialog', { name: 'New scenario' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog', { name: 'New scenario' })).toBeHidden();
	await expect(newScenario).toBeFocused();
});

test('the team settings sheet and a team member removed leave the focus on the page', async ({ page, owner, signIn }) => {
	void owner;
	const { team } = (await (await page.request.post(`${API_URL}/teams`, { data: { name: 'Focus Board' } })).json()) as { team: { id: string } };
	const colleague = await signIn('Focus colleague');
	expect((await page.request.post(`${API_URL}/teams/${team.id}/members`, { data: { email: colleague.user.email, role: 'member' } })).status()).toBe(201);
	await acceptInvites(colleague.user.email, team.id);
	await page.goto(`/teams/${team.id}`);

	const settingsLink = page.getByRole('link', { name: 'Team settings', exact: true });
	const sheet = page.getByRole('dialog', { name: 'Team settings' });
	await settingsLink.click();
	await expect(sheet).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(sheet).toBeHidden();
	await expect(settingsLink).toBeFocused();

	// Delete team asks once the sheet has closed: Cancel puts the focus back on what opens the sheet.
	await settingsLink.click();
	await sheet.getByRole('button', { name: /Delete team/ }).click();
	await answerConfirm(page, false, 'Delete team?');
	await expect(settingsLink).toBeFocused();

	// The colleague's row goes; the row now in its place (yours, the last) takes the focus, on its role.
	await page.getByRole('button', { name: 'Remove Focus colleague' }).click();
	await answerConfirm(page, true, 'Remove this member?');
	await expect(page.getByRole('button', { name: 'Remove Focus colleague' })).toHaveCount(0);
	await expect(page.locator('tr[data-member] select')).toBeFocused();
});

test('deleting a run, a series or a scenario puts the focus on what took its place', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Focus deletes');
	// The scenario's base first: once the rain record is deleted the model can't run.
	const base = await createRun(page.request, project.id, 'Base');
	const scenario = await createScenario(page.request, project.id, { name: 'Focus scenario', baseRunId: base });
	const first = await createRun(page.request, project.id, 'First');
	await createRun(page.request, project.id, 'Second');

	// Runs, newest first: Second, First. Deleting Second puts the focus on First, now in its place.
	await page.goto(`/projects/${project.id}?tab=runs&run=${first}`);
	await page.getByRole('button', { name: 'Delete run Second' }).click();
	await answerConfirm(page, true);
	await expect(page.getByRole('button', { name: 'Delete run Second' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: /^First/ })).toBeFocused();
	// The last row: the row before it.
	await page.getByRole('button', { name: 'Delete run First' }).click();
	await answerConfirm(page, true);
	await expect(page.getByRole('button', { name: /^Base/ })).toBeFocused();

	// Data: the rain record goes; the flow record's View takes the focus.
	await page.goto(`/projects/${project.id}?tab=series`);
	const rows = page.locator('#series-rows tr[data-series]');
	await expect(rows).toHaveCount(2);
	const keptView = rows.filter({ hasText: 'Flow — observed gauge' }).getByRole('button', { name: 'View', exact: true });
	await rows.filter({ hasText: 'Rainfall — catchment' }).getByRole('button', { name: /^Delete / }).click();
	await answerConfirm(page, true);
	await expect(rows).toHaveCount(1);
	await expect(keptView).toBeFocused();

	// Scenarios: the editor goes with it; the list's heading takes the focus.
	await page.goto(`/projects/${project.id}?tab=scenarios&scenario=${scenario}`);
	await page.getByRole('button', { name: 'Delete scenario' }).click();
	await answerConfirm(page, true);
	await expect(page.getByRole('heading', { name: 'All scenarios' })).toBeFocused();
});

test('deleting a project from the list puts the focus on the project in its place', async ({ page, owner }) => {
	void owner;
	await createProject(page.request, 'Focus Alpha');
	await createProject(page.request, 'Focus Beta');
	await page.goto('/?sort=name');
	const alpha = page.getByRole('link', { name: 'Focus Alpha', exact: true });
	await expect(alpha).toBeVisible();
	await page.getByRole('button', { name: 'More actions for Focus Alpha' }).click();
	await page.getByRole('button', { name: 'Delete Focus Alpha' }).click();
	await answerConfirm(page, true);
	await expect(alpha).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Focus Beta', exact: true })).toBeFocused();
	// The last one: the list makes way for Get started, and the page's heading takes the focus.
	await page.getByRole('button', { name: 'More actions for Focus Beta' }).click();
	await page.getByRole('button', { name: 'Delete Focus Beta' }).click();
	await answerConfirm(page, true);
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeFocused();
});

test('removing a hydrological unit from its sheet drops it from the URL', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Remove from sheet');
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')!;
	await page.goto(`/projects/${project.id}?tab=network`);
	await page.getByRole('button', { name: 'Edit Upper farm' }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]edit=${upper.id}`));
	await expect(page).toHaveURL(new RegExp(`[?&]node=${upper.id}`));
	await page.getByRole('button', { name: 'Remove Upper farm' }).click();
	await answerConfirm(page, true);
	await expect(page).not.toHaveURL(/[?&]edit=/);
	await expect(page).not.toHaveURL(/[?&]node=/);
	await expect(page.getByRole('heading', { name: 'All hydrological units' })).toBeFocused();
});

test('a link to a deleted scenario or run says so and offers the newest, not a Try again', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Gone links');
	const run = await createRun(page.request, project.id, 'Base');
	await createScenario(page.request, project.id, { name: 'Still here', baseRunId: run });

	await page.goto(`/projects/${project.id}?tab=scenarios&scenario=${GONE}`);
	const gone = page.getByTestId('scenario-gone');
	await expect(gone).toHaveText(/^This scenario no longer exists: it was deleted, or you no longer have access to it\./);
	await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
	// The message and its button wrap on a phone.
	for (const width of [320, 390]) {
		await resizeTo(page, { width, height: 740 });
		await expectNoSidewaysScroll(page);
	}
	await resizeTo(page, { width: 1280, height: 800 });
	await gone.getByRole('button', { name: 'Open the newest' }).click();
	await expect(page.getByRole('heading', { name: 'Still here' })).toBeVisible();
	await expect(page).not.toHaveURL(new RegExp(GONE));

	await page.goto(`/projects/${project.id}?tab=runs&run=${GONE}`);
	const alert = page.getByRole('alert').filter({ hasText: 'This run no longer exists' });
	await expect(alert).toBeVisible();
	await expect(alert.getByRole('button', { name: 'Try again' })).toHaveCount(0);
	for (const width of [320, 390]) {
		await resizeTo(page, { width, height: 740 });
		await expectNoSidewaysScroll(page);
	}
	await resizeTo(page, { width: 1280, height: 800 });
	await alert.getByRole('button', { name: 'Show the newest run' }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]run=${run}`));
	await expect(page.getByRole('heading', { level: 2, name: 'Base' })).toBeVisible();
});

test('the Project page’s notes and registration checks offer Try again after a failed load, and it recovers', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Retry lists');
	// Each list's reads fail until the server is back.
	let down = true;
	await page.route(new RegExp(`/projects/${project.id}/(notes|registration-checks)(\\?|$)`), (r) =>
		r.request().method() === 'GET' && down ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Server unavailable"}' }) : r.fallback()
	);
	await page.goto(`/projects/${project.id}?tab=project`);
	const notes = page.getByRole('region', { name: 'Recent notes' });
	const checks = page.getByTestId('registration-checks');
	await expect(notes.getByRole('alert')).toHaveText(/^Couldn’t load the notes: Server unavailable/);
	await expect(checks.getByRole('alert')).toHaveText(/^Server unavailable/);
	for (const width of [320, 390]) {
		await resizeTo(page, { width, height: 740 });
		await expectNoSidewaysScroll(page);
	}
	await resizeTo(page, { width: 1280, height: 800 });
	down = false;
	await notes.getByRole('button', { name: 'Try again' }).click();
	await expect(notes).toContainText('No notes yet.');
	await expect(notes.getByRole('alert')).toHaveCount(0);

	await checks.getByRole('button', { name: 'Try again' }).click();
	await expect(checks).toContainText('No check recorded yet.');
	await expect(checks.getByRole('alert')).toHaveCount(0);
});

test('removing a project member, revoking an invitation and a farmer’s invitation keep the focus in the panel', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Focus members');
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')!;
	const colleague = await signIn('Focus editor');
	await addMember(page.request, project.id, colleague.user.email, 'editor');
	// Two invitations to addresses without an account, as members and as farmers.
	for (const name of ['First', 'Second']) {
		expect((await page.request.post(`${API_URL}/projects/${project.id}/members`, { data: { email: uniqueEmail(`${name} invitee`), role: 'viewer' } })).status()).toBe(201);
		expect((await page.request.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: uniqueEmail(`${name} farmer`), nodeIds: [upper.id], locale: 'en', role: 'farmer' } })).status()).toBe(201);
	}
	await page.goto(`/projects/${project.id}?tab=project`);

	// Members: the editor's row goes; yours, now in its place (the last), takes the focus on its role.
	await page.getByRole('row', { name: /Focus editor/ }).getByRole('button', { name: 'Remove' }).click();
	await answerConfirm(page, true, 'Remove this member?');
	await expect(page.getByRole('row', { name: /Focus editor/ })).toHaveCount(0);
	await expect(page.getByRole('combobox', { name: /^Role for / })).toBeFocused();

	// The members' pending invitations: the first goes, the second's Revoke takes the focus; the last, the add field.
	const memberInvites = page.getByRole('region', { name: /^Pending invitations/ });
	const memberRevokes = memberInvites.getByRole('button', { name: /^Revoke invitation to / });
	await expect(memberRevokes).toHaveCount(2);
	await memberRevokes.first().click();
	await answerConfirm(page, true, 'Revoke this invitation?');
	await expect(memberRevokes).toHaveCount(1);
	await expect(memberRevokes).toBeFocused();
	await memberRevokes.click();
	await answerConfirm(page, true, 'Revoke this invitation?');
	await expect(page.getByLabel('Add member by email')).toBeFocused();

	// The farmers' pending invitations: the same, and the panel's heading once none is left.
	const farmerInvites = page.getByRole('region', { name: /^Pending farmer invitations/ });
	const farmerRevokes = farmerInvites.getByRole('button', { name: /^Revoke invitation to / });
	await expect(farmerRevokes).toHaveCount(2);
	await farmerRevokes.first().click();
	await answerConfirm(page, true, 'Revoke this invitation?');
	await expect(farmerRevokes).toHaveCount(1);
	await expect(farmerRevokes).toBeFocused();
	await farmerRevokes.click();
	await answerConfirm(page, true, 'Revoke this invitation?');
	await expect(page.getByRole('heading', { name: /^Farmers/ })).toBeFocused();
});

// Issue #586: a revoked key and a withdrawn link keep their rows but lose their buttons, and a removed schedule
// goes with its row; each left the focus on <body>. The next one's button takes it, then the panel's add action.
test('revoking an API key, removing a scheduled report and withdrawing a share link keep the focus in the panel', async ({ page, owner }) => {
	const project = await seedRunnableProject(page.request, 'Focus keys links schedules');
	const post = async (path: string, data: object) => expect((await page.request.post(`${API_URL}/projects/${project.id}/${path}`, { data })).status()).toBe(201);
	for (const name of ['Gate A', 'Gate B']) await post('api-keys', { name, allowedSeries: null, expiresInDays: 30 });
	for (const hour of [6, 7]) await post('report-schedules', { frequency: 'weekly', weekday: 1, hour, timezone: 'UTC', recipients: [owner.id] });
	for (const label of ['Forum A', 'Forum B']) await post('share-links', { label, expiresInDays: 7 });

	// All three are on the Project page (API keys and Scheduled reports moved from Settings, issue #586).
	await page.goto(`/projects/${project.id}?tab=project`);
	const keys = page.getByRole('region', { name: 'API keys' });
	const revokes = keys.getByRole('button', { name: /^Revoke Gate / });
	await expect(revokes).toHaveCount(2);
	await revokes.first().click();
	await answerConfirm(page, true, 'Revoke this API key?');
	await expect(revokes).toHaveCount(1);
	await expect(revokes).toBeFocused();
	await revokes.click();
	await answerConfirm(page, true, 'Revoke this API key?');
	await expect(revokes).toHaveCount(0);
	await expect(keys.getByRole('button', { name: 'Make a key' })).toBeFocused();

	const schedules = page.getByRole('region', { name: 'Scheduled reports' });
	const removes = schedules.getByRole('button', { name: /^Remove schedule: / });
	await expect(removes).toHaveCount(2);
	await removes.first().click();
	await answerConfirm(page, true, 'Remove this schedule?');
	await expect(removes).toHaveCount(1);
	await expect(removes).toBeFocused();
	await removes.click();
	await answerConfirm(page, true, 'Remove this schedule?');
	await expect(removes).toHaveCount(0);
	await expect(schedules.getByRole('button', { name: 'Add a schedule' })).toBeFocused();

	const links = page.getByRole('region', { name: 'Share links' });
	const withdraws = links.getByRole('button', { name: /^Withdraw Forum / });
	await expect(withdraws).toHaveCount(2);
	await withdraws.first().click();
	await answerConfirm(page, true, 'Withdraw this link?');
	await expect(withdraws).toHaveCount(1);
	await expect(withdraws).toBeFocused();
	await withdraws.click();
	await answerConfirm(page, true, 'Withdraw this link?');
	await expect(withdraws).toHaveCount(0);
	await expect(links.getByLabel('Who it’s for')).toBeFocused();
});
