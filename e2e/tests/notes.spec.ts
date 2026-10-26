// Notes and comments (WP-2.7, docs/ui.md § Notes): the WUA keeps notes on a
// farm from its Network row, one for the team and one shown to the farm; the
// farmer's page lists only the farm-visible one under "Notes about your
// farm", and the farmer's own note reaches the WUA. Notes are plain text:
// markup shows as typed, and line breaks are kept. Settings groups take notes
// too, and the Project page lists the newest. The notes open in a side sheet
// with the add form on top and Close pinned, so thirty notes push neither
// off the screen.
import { API_URL } from '../support/env.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { acceptInvites, createProject, createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { answerConfirm } from '../support/confirm.ts';

test('a farm note shown to the farm reaches its farmer; a team note never does', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Notes on a farm');
	const runId = await createRun(page.request, project.id, 'Baseline');
	expect((await page.request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId } })).status()).toBe(201);
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')!.id as string;
	const farmer = await signIn('Notes farmer');
	expect((await page.request.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: farmer.user.email, nodeIds: [upper] } })).status()).toBe(201);
	await acceptInvites(farmer.user.email, project.id);

	await page.goto(`/projects/${project.id}?tab=network&grid=nodes`);
	await page.getByRole('button', { name: 'Notes on Upper farm', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Notes on Upper farm' });
	await expect(dialog).toContainText('No notes yet.');
	await dialog.getByLabel('Add a note').fill('Owner disputes the dam volume\n<b>check survey</b>');
	await dialog.getByRole('button', { name: 'Add note' }).click();
	await expect(dialog.getByRole('list', { name: 'Notes' }).getByRole('listitem')).toHaveCount(1);
	await dialog.getByLabel('Add a note').fill('Dam raised in 2019 per owner');
	await dialog.getByLabel('Also show to this hydrological unit’s farmers').check();
	await dialog.getByRole('button', { name: 'Add note' }).click();
	const items = dialog.getByRole('list', { name: 'Notes' }).getByRole('listitem');
	await expect(items).toHaveCount(2);
	await expect(items.first()).toContainText('Dam raised in 2019 per owner');
	await expect(items.first()).toContainText('Shown to its farmers');
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
	const notes = farmer.page.getByRole('region', { name: 'Notes about your hydrological unit' });
	await expect(notes.getByRole('list', { name: 'Notes' }).getByRole('listitem')).toHaveCount(1);
	await expect(notes).toContainText('Dam raised in 2019 per owner');
	await expect(notes).not.toContainText('Owner disputes');
	// The farmer adds their own; it is always shown to the farm.
	await notes.getByLabel('Add a note').fill('Logger moved in March');
	await notes.getByRole('button', { name: 'Add note' }).click();
	await expect(notes.getByRole('list', { name: 'Notes' }).getByRole('listitem').first()).toContainText('Logger moved in March');
	await expect(notes.getByRole('list', { name: 'Notes' }).getByRole('listitem').first()).toContainText('You');

	// The WUA sees it on the Project page's recent notes, against the farm.
	await page.goto(`/projects/${project.id}?tab=project`);
	const recent = page.getByRole('region', { name: 'Recent notes' });
	await expect(recent.getByRole('listitem').first()).toContainText('Logger moved in March');
	await expect(recent.getByRole('listitem').first().getByRole('link', { name: 'Upper farm' })).toHaveAttribute('href', `?tab=network&node=${upper}`);
});

test('a settings group and a run take notes, and the author edits and deletes their own', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Notes on settings');
	await createRun(page.request, project.id, 'Baseline');

	await page.goto(`/projects/${project.id}?tab=settings`);
	await page.getByRole('button', { name: 'Notes on EWR', exact: true }).click();
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
	// The groups whose sources and determinations most need a "why" take notes too (WR2012, Reserve rules, restrictions, Evidence).
	// Every panel but EWR the results are judged by takes notes (issue #586, C12), and Notes is the last thing in each panel's head,
	// after the panel's own action.
	for (const group of ['Reserve rule tables', 'Drought restrictions', 'Reporting', 'Evidence', 'Outcome matrix', 'Seasonal outlook', 'Automatic runs']) {
		await expect(page.getByRole('button', { name: `Notes on ${group}`, exact: true })).toBeVisible();
	}
	const lastInHead = (id: string) => page.locator(`${id} .panel-head`).first().locator('button:visible, a:visible').last();
	for (const [id, group] of [
		['#set-reserve', 'Reserve rule tables'],
		['#set-auto', 'Automatic runs']
	] as const) {
		await expect(lastInHead(id), id).toHaveAccessibleName(`Notes on ${group}`);
	}
	const reserveHead = page.locator('#set-reserve .panel-head').first();
	const [add, notes] = [(await reserveHead.getByRole('button', { name: 'Add a rule table' }).boundingBox())!, (await reserveHead.locator('.notes-btn').boundingBox())!];
	expect(add.x).toBeLessThan(notes.x);
	// Label in Name (WCAG 2.5.3): the button shows "Notes", and its accessible name starts with it.
	const reportingNotes = page.locator('#set-reporting .notes-btn');
	await expect(reportingNotes).toHaveText('Notes');
	await expect(reportingNotes).toHaveAccessibleName('Notes on Reporting');
	// The panels that set up a fit take notes on Calibration (issue #586 round 3), Notes last in each head there too.
	await page.goto(`/projects/${project.id}?tab=calibration`);
	for (const group of ['Flow calibration', 'Calibration record', 'Fit the parameters', 'WR2012 check']) {
		await expect(page.getByRole('button', { name: `Notes on ${group}`, exact: true })).toBeVisible();
	}
	for (const [id, group] of [
		['#set-wr2012', 'WR2012 check'],
		['#set-fit', 'Fit the parameters']
	] as const) {
		await expect(lastInHead(id), id).toHaveAccessibleName(`Notes on ${group}`);
	}

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByRole('button', { name: 'Notes on this run', exact: true }).click();
	const runDialog = page.getByRole('dialog', { name: 'Notes on run Baseline' });
	await runDialog.getByLabel('Add a note').fill('Checked against the weir log');
	await runDialog.getByRole('button', { name: 'Add note' }).click();
	const runItem = runDialog.getByRole('list', { name: 'Notes' }).getByRole('listitem');
	await expect(runItem).toContainText('Checked against the weir log');
	await runItem.getByRole('button', { name: /^Delete/ }).click();
	await answerConfirm(page, true, 'Delete this note?');
	await expect(runDialog).toContainText('No notes yet.');
	// A half-typed note: Escape asks first, and Keep editing keeps it; Close asks too, and Discard closes.
	await runDialog.getByLabel('Add a note').fill('Half a thought');
	await page.keyboard.press('Escape');
	await answerConfirm(page, false, 'Discard your note?');
	await expect(runDialog.getByLabel('Add a note')).toHaveValue('Half a thought');
	await runDialog.getByRole('button', { name: 'Close', exact: true }).click();
	await answerConfirm(page, true, 'Discard your note?');
	await expect(runDialog).toBeHidden();
	await expect(page.getByRole('button', { name: 'Notes on this run', exact: true })).toBeVisible();
	// Opened again, it starts empty and closes without a question.
	await page.getByRole('button', { name: 'Notes on this run', exact: true }).click();
	await expect(runDialog.getByLabel('Add a note')).toHaveValue('');
	await runDialog.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(runDialog).toBeHidden();
});

for (const size of [
	{ name: 'desktop', width: 1440, height: 960 },
	{ name: 'phone', width: 390, height: 844 }
]) {
	test(`thirty notes: a side sheet with the form on top, the notes scrolling under it and Close in view; no a11y violations (${size.name})`, async ({ page, owner }) => {
		void owner;
		await page.setViewportSize({ width: size.width, height: size.height });
		const project = await createProject(page.request, `Notes drawer ${size.name}`);
		for (let i = 1; i <= 30; i++) {
			const body = i % 5 === 0 ? `Logger at the weir moved ${i} m downstream after the flood; readings before and after are not directly comparable.\nChecked by the field team.` : `Note ${i}: dam raised per owner`;
			expect((await page.request.post(`${API_URL}/projects/${project.id}/notes`, { data: { body, visibility: 'team' } })).status()).toBe(201);
		}
		await page.goto(`/projects/${project.id}?tab=project`);
		const button = page.getByRole('button', { name: 'Notes on the project (30)' });
		await button.click();
		const dialog = page.getByRole('dialog', { name: 'Project notes' });
		const items = dialog.getByRole('list', { name: 'Notes' }).getByRole('listitem');
		await expect(items).toHaveCount(30);
		await expect(items.first()).toContainText('Logger at the weir moved 30 m');

		// A sheet down the right edge, the full height; the whole width on a phone.
		const box = (await dialog.boundingBox())!;
		expect(Math.round(box.y)).toBe(0);
		expect(Math.round(box.height)).toBe(size.height);
		expect(Math.round(box.x + box.width)).toBeGreaterThanOrEqual(size.width - 16);
		if (size.name === 'phone') expect(Math.round(box.x)).toBe(0);
		// The form comes first, inside the first screen; the notes scroll inside the sheet, which doesn't grow.
		const add = dialog.getByRole('button', { name: 'Add note' });
		await expect(add).toBeInViewport();
		expect((await dialog.getByLabel('Add a note').boundingBox())!.y).toBeLessThan((await items.first().boundingBox())!.y);
		const body = dialog.locator(':scope > .body');
		expect(await body.evaluate((b) => b.scrollHeight > b.clientHeight)).toBe(true);
		await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
		await body.evaluate((b) => (b.scrollTop = b.scrollHeight));
		await expect(items.last()).toBeInViewport();
		await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
		expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

		await expectNoViolations(page, { include: 'dialog[open]' });

		// A new note lands at the top of the list, right under the form.
		await body.evaluate((b) => (b.scrollTop = 0));
		await dialog.getByLabel('Add a note').fill('Weir recalibrated');
		await add.click();
		await expect(items).toHaveCount(31);
		await expect(items.first()).toContainText('Weir recalibrated');
		await expect(items.first()).toBeInViewport();

		// Escape closes it and gives focus back to the button, whose count follows.
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(page.getByRole('button', { name: 'Notes on the project (31)' })).toBeFocused();
	});
}

test('the Project page’s empty Recent notes links to the Network, where a unit takes notes (issue #586)', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'No notes farm');
	await page.goto(`/projects/${project.id}?tab=project`);
	const recent = page.getByRole('region', { name: 'Recent notes' });
	await expect(recent).toContainText('No notes yet.');
	await recent.getByRole('link', { name: 'Network' }).click();
	await expect(page).toHaveURL(`/projects/${project.id}?tab=network`);
});
