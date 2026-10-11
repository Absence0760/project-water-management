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
import { acceptInvites, createProject, createRun, seedRunnableProject } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
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
	const rows = page.locator('#series-rows tbody tr');
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
	await gone.getByRole('button', { name: 'Open the newest' }).click();
	await expect(page.getByRole('heading', { name: 'Still here' })).toBeVisible();
	await expect(page).not.toHaveURL(new RegExp(GONE));

	await page.goto(`/projects/${project.id}?tab=runs&run=${GONE}`);
	const alert = page.getByRole('alert').filter({ hasText: 'This run no longer exists' });
	await expect(alert).toBeVisible();
	await expect(alert.getByRole('button', { name: 'Try again' })).toHaveCount(0);
	await alert.getByRole('button', { name: 'Show the newest run' }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]run=${run}`));
	await expect(page.getByRole('heading', { level: 2, name: 'Base' })).toBeVisible();
});
