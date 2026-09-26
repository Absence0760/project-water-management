// Notes and comments (WP-2.7, docs/ui.md § Notes): the WUA keeps notes on a
// farm from its Network row, one for the team and one shown to the farm; the
// farmer's page lists only the farm-visible one under "Notes about your
// farm", and the farmer's own note reaches the WUA. Notes are plain text:
// markup shows as typed, and line breaks are kept. Settings groups take notes
// too, and the Overview lists the newest.
import { API_URL } from '../support/env.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

test('a farm note shown to the farm reaches its farmer; a team note never does', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Notes on a farm');
	const runId = await createRun(page.request, project.id, 'Baseline');
	expect((await page.request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId } })).status()).toBe(201);
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')!.id as string;
	const farmer = await signIn('Notes farmer');
	expect((await page.request.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: farmer.user.email, nodeIds: [upper] } })).status()).toBe(201);

	await page.goto(`/projects/${project.id}?tab=network&view=table`);
	await page.getByRole('button', { name: 'Add a note on Upper farm' }).click();
	const dialog = page.getByRole('dialog', { name: 'Notes on Upper farm' });
	await expect(dialog).toContainText('No notes yet.');
	await dialog.getByLabel('Add a note').fill('Owner disputes the dam volume\n<b>check survey</b>');
	await dialog.getByRole('button', { name: 'Add note' }).click();
	await expect(dialog.getByRole('list', { name: 'Notes' }).getByRole('listitem')).toHaveCount(1);
	await dialog.getByLabel('Add a note').fill('Dam raised in 2019 per owner');
	await dialog.getByLabel('Also show to this farm’s farmers').check();
	await dialog.getByRole('button', { name: 'Add note' }).click();
	const items = dialog.getByRole('list', { name: 'Notes' }).getByRole('listitem');
	await expect(items).toHaveCount(2);
	await expect(items.first()).toContainText('Dam raised in 2019 per owner');
	await expect(items.first()).toContainText('Shown to the farm');
	// Plain text: the markup is shown as typed, and the line break is kept.
	const team = items.nth(1).locator('.body');
	await expect(team).toHaveText('Owner disputes the dam volume\n<b>check survey</b>');
	await expect(team.locator('b')).toHaveCount(0);
	await expect(team).toHaveCSS('white-space', 'pre-line');
	await expectNoViolations(page, { include: 'dialog[open]' });
	await dialog.getByRole('button', { name: 'Close', exact: true }).click();
	// The row's badge counts them.
	await expect(page.getByRole('button', { name: 'Notes on Upper farm (2)' })).toBeVisible();

	// The farmer's page: the farm-visible note only.
	await farmer.page.goto(`/farm/${project.id}`);
	const notes = farmer.page.getByRole('region', { name: 'Notes about your farm' });
	await expect(notes.getByRole('list', { name: 'Notes' }).getByRole('listitem')).toHaveCount(1);
	await expect(notes).toContainText('Dam raised in 2019 per owner');
	await expect(notes).not.toContainText('Owner disputes');
	// The farmer adds their own; it is always shown to the farm.
	await notes.getByLabel('Add a note').fill('Logger moved in March');
	await notes.getByRole('button', { name: 'Add note' }).click();
	await expect(notes.getByRole('list', { name: 'Notes' }).getByRole('listitem').first()).toContainText('Logger moved in March');
	await expect(notes.getByRole('list', { name: 'Notes' }).getByRole('listitem').first()).toContainText('You');

	// The WUA sees it on the Overview's recent notes, against the farm.
	await page.goto(`/projects/${project.id}`);
	const recent = page.getByRole('region', { name: 'Recent notes' });
	await expect(recent.getByRole('listitem').first()).toContainText('Logger moved in March');
	await expect(recent.getByRole('listitem').first().getByRole('link', { name: 'Upper farm' })).toHaveAttribute('href', `?tab=network&node=${upper}`);
});

test('a settings group and a run take notes, and the author edits and deletes their own', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Notes on settings');
	await createRun(page.request, project.id, 'Baseline');

	await page.goto(`/projects/${project.id}?tab=settings`);
	await page.getByRole('button', { name: 'Add a note on EWR' }).click();
	const dialog = page.getByRole('dialog', { name: 'Notes on EWR' });
	await dialog.getByLabel('Add a note').fill('EWR from the 2014 reserve study');
	await dialog.getByRole('button', { name: 'Add note' }).click();
	const item = dialog.getByRole('list', { name: 'Notes' }).getByRole('listitem');
	await expect(item).toContainText('EWR from the 2014 reserve study');
	await item.getByRole('button', { name: /^Edit/ }).click();
	await dialog.getByLabel('Edit note').fill('EWR from the 2015 reserve study');
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(item).toContainText('EWR from the 2015 reserve study');
	await expect(item).toContainText('edited');
	await dialog.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Notes on EWR (1)' })).toBeVisible();

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByRole('button', { name: 'Add a note on this run' }).click();
	const runDialog = page.getByRole('dialog', { name: 'Notes on run Baseline' });
	await runDialog.getByLabel('Add a note').fill('Checked against the weir log');
	await runDialog.getByRole('button', { name: 'Add note' }).click();
	const runItem = runDialog.getByRole('list', { name: 'Notes' }).getByRole('listitem');
	await expect(runItem).toContainText('Checked against the weir log');
	page.once('dialog', (d) => d.accept());
	await runItem.getByRole('button', { name: /^Delete/ }).click();
	await expect(runDialog).toContainText('No notes yet.');
	await runDialog.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Add a note on this run' })).toBeVisible();
});
