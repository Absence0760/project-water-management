import type { Page } from '@playwright/test';
import { addMember, createProject, createRun, nominateRun, putModel, putSeries, register, sampleModel, seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const row = (page: Page, name: string) =>
	page.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });

/** A real mouse click at the middle of `target` (whatever element is on top there gets it). */
async function clickAt(page: Page, target: ReturnType<Page['locator']>) {
	const box = (await target.boundingBox())!;
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function createThroughDialog(page: Page, name: string, description = '') {
	await page.getByRole('button', { name: 'New project' }).first().click();
	const dialog = page.getByRole('dialog', { name: 'New project' });
	await dialog.getByLabel('Name').fill(name);
	if (description) await dialog.getByLabel(/Description/).fill(description);
	await dialog.getByRole('button', { name: 'Create' }).click();
	// Creating opens the new project's workspace.
	await expect(page.getByTestId('project-name').filter({ hasText: name })).toBeVisible();
	await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Projects' }).click();
	await expect(row(page, name)).toBeVisible();
}

test('several projects for one place: create, copy, delete', async ({ page, owner }) => {
	void owner;
	await page.goto('/');
	await expect(page.getByText('You have no projects yet.')).toBeVisible();

	await createThroughDialog(page, 'Example Valley — baseline', 'Current dams and crops');
	await createThroughDialog(page, 'Example Valley — dam raise');
	await createThroughDialog(page, 'Example Valley — drought');
	await expect(page.getByRole('row')).toHaveCount(4); // header + 3

	// Copy A (with a model, so the copy is meaningful) as D.
	// The name opens the project (the row's Open button folds away when the table is narrow).
	const href = await row(page, 'Example Valley — baseline').getByRole('link', { name: 'Example Valley — baseline', exact: true }).getAttribute('href');
	const idA = href!.split('/').pop()!;
	const model = sampleModel();
	await putModel(page.request, idA, model);

	await row(page, 'Example Valley — baseline').getByRole('button', { name: 'Copy Example Valley — baseline' }).click();
	const dialog = page.getByRole('dialog', { name: 'Copy project' });
	await expect(dialog.getByLabel('Name of the copy')).toHaveValue('Example Valley — baseline (copy)');
	await dialog.getByLabel('Name of the copy').fill('Example Valley — new orchard');
	await dialog.getByRole('button', { name: 'Copy' }).click();
	await expect(dialog).toBeHidden();
	await expect(row(page, 'Example Valley — new orchard')).toBeVisible();
	await expect(page.getByRole('row')).toHaveCount(5);

	// The copy carries A's model but is its own project.
	await row(page, 'Example Valley — new orchard').getByRole('link', { name: 'Example Valley — new orchard', exact: true }).click();
	await expect(page.getByTestId('project-name').filter({ hasText: 'Example Valley — new orchard' })).toBeVisible();
	await expect(page).not.toHaveURL(new RegExp(idA));
	const stat = (term: string) => page.getByRole('term').filter({ hasText: term }).locator('xpath=following-sibling::dd');
	await expect(stat('Outflow gauge')).toHaveText('Outflow gauge');
	await expect(stat('Units')).toHaveText(/^2\s*\+ 1 gauge$/);
	await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Projects' }).click();

	// Delete one (confirm dialog accepted).
	page.once('dialog', (d) => void d.accept());
	await row(page, 'Example Valley — drought').getByRole('button', { name: 'Delete Example Valley — drought' }).click();
	await expect(row(page, 'Example Valley — drought')).toHaveCount(0);
	await expect(page.getByRole('row')).toHaveCount(4);

	// Still gone after a reload (really deleted, not just hidden).
	await page.reload();
	await expect(row(page, 'Example Valley — baseline')).toBeVisible();
	await expect(row(page, 'Example Valley — drought')).toHaveCount(0);
});

// A click anywhere on a row opens the project; the row's own buttons still do their own thing.
test('clicking anywhere on a project row opens it, and its buttons still work', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.context().request, 'Example Ridge');
	await page.goto('/');
	const r = row(page, 'Example Ridge');
	await r.getByRole('button', { name: 'Copy Example Ridge' }).click();
	await expect(page.getByRole('dialog')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page).toHaveURL(/\/$/);
	// Click where a user would, on the plain role cell away from the name: the
	// stretched name link lies over it (Playwright's own click refuses a
	// covered element, so click the screen point).
	await clickAt(page, r.getByRole('cell', { name: 'owner', exact: true }));
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
	await expect(page.getByTestId('project-name').filter({ hasText: 'Example Ridge' })).toBeVisible();
	// On a phone the row folds into the name cell; tapping its meta line opens it too.
	await page.setViewportSize({ width: 390, height: 800 });
	await page.goto('/');
	await clickAt(page, row(page, 'Example Ridge').locator('.meta'));
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
});

test('cancelling the delete confirmation keeps the project', async ({ page, owner }) => {
	void owner;
	await createProject(page.request, 'Keep me');
	await page.goto('/');
	page.once('dialog', (d) => void d.dismiss());
	await row(page, 'Keep me').getByRole('button', { name: 'Delete Keep me' }).click();
	await page.reload();
	await expect(row(page, 'Keep me')).toBeVisible();
});

// Issue #43: a project with a nominated evidence run keeps it. The refusal is
// explained in a dialog that names the run and links to it, not a raw error.
test('deleting a project with a nominated evidence run is refused, and the dialog explains why', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Licence evidence');
	const runId = await createRun(page.request, project.id, 'Calibrated GR4J');
	await nominateRun(page.request, project.id, runId, 'Calibrated against the logger record.');
	await page.goto('/');

	page.once('dialog', (d) => void d.accept());
	await row(page, 'Licence evidence').getByRole('button', { name: 'Delete Licence evidence' }).click();
	const dialog = page.getByRole('dialog', { name: "This project can't be deleted" });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId('evidence-kept')).toHaveText(
		'“Calibrated GR4J” is the nominated evidence run of “Licence evidence”. A project that has nominated evidence keeps it, with its nomination history, for good, so the evidence can still be read and reproduced.'
	);
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(dialog.getByRole('link', { name: 'Open the evidence run' })).toHaveAttribute('href', `/projects/${project.id}?tab=runs&run=${runId}`);

	// Copy project hands over to the copy dialog, for a fresh start without the evidence.
	await dialog.getByRole('button', { name: 'Copy project' }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByRole('dialog', { name: 'Copy project' }).getByLabel('Name of the copy')).toHaveValue('Licence evidence (copy)');
	await page.keyboard.press('Escape');

	// Still there after a reload.
	await page.reload();
	await expect(row(page, 'Licence evidence')).toBeVisible();
});

test('the list shows the role the user has on each project', async ({ page, owner, playwright }) => {
	await createProject(page.request, 'My own catchment');

	const other = await playwright.request.newContext();
	await register(other, 'Colleague');
	const shared = await createProject(other, 'Colleague catchment');
	const readOnly = await createProject(other, 'Colleague reference');
	await addMember(other, shared.id, owner.email, 'editor');
	await addMember(other, readOnly.id, owner.email, 'viewer');
	await other.dispose();

	await page.goto('/');
	const roleCell = (name: string, role: string) => row(page, name).getByRole('cell', { name: role, exact: true });
	await expect(roleCell('My own catchment', 'owner')).toBeVisible();
	await expect(roleCell('Colleague catchment', 'editor')).toBeVisible();
	await expect(roleCell('Colleague reference', 'viewer')).toBeVisible();

	// Own projects are grouped under Personal, the colleague's under Shared with me.
	const group = (name: string) => page.getByRole('region', { name });
	await expect(group('Personal').getByRole('rowheader', { name: 'My own catchment' })).toBeVisible();
	await expect(group('Shared with me').getByRole('row')).toHaveCount(3); // header + 2

	// Only owners get a Delete button; anyone may copy.
	await expect(row(page, 'My own catchment').getByRole('button', { name: /^Delete/ })).toBeVisible();
	await expect(row(page, 'Colleague catchment').getByRole('button', { name: /^Delete/ })).toHaveCount(0);
	await expect(row(page, 'Colleague reference').getByRole('button', { name: /^Delete/ })).toHaveCount(0);
	await expect(row(page, 'Colleague reference').getByRole('button', { name: 'Copy Colleague reference' })).toBeVisible();
});

test('the list shows data freshness and the last run, with an Add data shortcut for editors', async ({ page, owner, signIn }) => {
	void owner;
	const empty = await createProject(page.request, 'Freshness — empty');
	const stale = await createProject(page.request, 'Freshness — stale');
	await putModel(page.request, stale.id, sampleModel());
	const days = 30;
	const series = (kind: string, unit: string) => ({ kind, unit, startDate: '2020-10-01', values: Array(days).fill(1) });
	await putSeries(page.request, stale.id, series('rain_catchment_mm', 'mm'));
	await putSeries(page.request, stale.id, series('flow_observed_m3s', 'm3/s'));
	await updateSettings(page.request, stale.id, { apanMm: Array(12).fill(150) }); // GR4J refuses to run without it
	await createRun(page.request, stale.id, 'baseline');

	await page.goto('/');
	const emptyRow = row(page, 'Freshness — empty');
	await expect(emptyRow).toContainText('no rain yet');
	await expect(emptyRow).toContainText('not run yet');
	const staleRow = row(page, 'Freshness — stale');
	const status = staleRow.getByRole('cell').filter({ hasText: /^rain / });
	await expect(status.getByTitle('Recorded rain runs to 2020-10-30')).toHaveText(/^rain \d+ years old$/);
	await expect(status).toContainText(/last run \d{4}-\d{2}-\d{2}/);

	// "Add data" opens the workspace with the upload dialog requested.
	const add = emptyRow.getByRole('link', { name: 'Add data to Freshness — empty' });
	await expect(add).toHaveAttribute('href', `/projects/${empty.id}?add=data`);

	// Viewers can't upload, so they don't get the shortcut.
	const viewer = await signIn('Freshness viewer');
	await addMember(page.request, stale.id, viewer.user.email, 'viewer');
	await viewer.page.goto('/');
	const vRow = row(viewer.page, 'Freshness — stale');
	await expect(vRow).toContainText(/rain \d+ years old/);
	await expect(vRow.getByRole('link', { name: /^Add data/ })).toHaveCount(0);
});

test.describe('data age under a skewed time zone', () => {
	// Overrides the suite's pinned UTC on purpose (project rule 7): at 12:30 UTC
	// on 6 Feb it is already 02:30 on 7 Feb in UTC+14, so a UTC "today" would
	// be a day behind the viewer's calendar.
	test.use({ timezoneId: 'Pacific/Kiritimati' });

	test('the project list and the workspace header count the same local days', async ({ page, owner }) => {
		void owner;
		const p = await createProject(page.request, 'Skewed clock');
		// 120 days from 2021-10-01: the data runs to 2022-01-28.
		await putSeries(page.request, p.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: Array(120).fill(1) });
		await page.clock.setFixedTime(new Date('2022-02-06T12:30:00Z'));

		await page.goto('/');
		// The row carries the badge twice (wide and narrow layouts); one is shown.
		const badge = row(page, 'Skewed clock').getByTitle('Recorded rain runs to 2022-01-28').filter({ visible: true });
		await expect(badge).toHaveText('rain 10 days old');

		await page.goto(`/projects/${p.id}`);
		// Stale (> 7 days), so a hidden "(older than 7 days)" follows.
		await expect(page.locator('summary').filter({ hasText: 'Rain up to' })).toHaveText(
			'Rain up to 28 Jan 2022 · 10 days ago (older than 7 days)'
		);
	});
});
