// The UX hunt's judgment calls (issue #521, round 5; docs/design/ui-playbook.md
// § 4 "A pick is a step in history"). Synthetic data only.
// - A run, unit or dam picked by the user is a step in history: Back returns to
//   the pick before. Runs replaced its entry while River, Units, Dams and
//   Allocations added one; the default pick still replaces.
// - Sorts and filters live in the URL, so a reload and Back keep them: the Runs
//   label filter (`q=`); a search is one step (its first keystroke after the
//   box takes the focus adds an entry, the rest replace it), as on the project
//   list, which used to replace the entry it came from. (The Applications sort:
//   applications-page.spec.ts.)
// - A failed lookup says what failed and offers Try again: the Outcome matrix's
//   sweep, the Seasonal outlook, the calibration rules' fits.
// - Deleting a note in the notes drawer puts the focus on the note now in its place.
import { API_URL } from '../support/env.ts';
import { createProject, createRun, seedRunnableProject, updateSettings } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { expect, test } from '../support/fixtures.ts';
import { openRiver, seedRiverProject } from '../support/river.ts';
import { openRuns, runsList, seedManyRuns } from '../support/runs.ts';

test('a run picked from the list is a step in history; the default pick is not', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	const project = await seedRunnableProject(page.request, 'Steps runs');
	const first = await createRun(page.request, project.id, 'First');
	const second = await createRun(page.request, project.id, 'Second');
	await page.goto(`/projects/${project.id}?tab=overview`);
	await expect(page.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible();
	await openRuns(page, project.id);
	// The newest is the default, written in place: Back leaves the page rather than stopping on ?tab=runs.
	await expect(page).toHaveURL(new RegExp(`[?&]run=${second}(?:&|$)`));
	await runsList(page).getByRole('button', { name: /^First/ }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]run=${first}(?:&|$)`));
	await expect(page.getByRole('heading', { level: 2, name: 'First' })).toBeVisible();
	await page.goBack();
	await expect(page).toHaveURL(new RegExp(`[?&]run=${second}(?:&|$)`));
	await expect(page.getByRole('heading', { level: 2, name: 'Second' })).toBeVisible();
	await page.goBack();
	await expect(page).toHaveURL(/\?tab=overview$/);
});

test('the runs label filter is in the URL: a reload keeps it, and Back undoes the whole search at once', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	const { id } = await seedManyRuns(page.request, 'Steps run filter', 8);
	await openRuns(page, id);
	const before = page.url();
	const filter = page.getByRole('searchbox', { name: 'Filter runs by label' });
	const items = runsList(page).getByRole('list').getByRole('listitem');
	await expect(items).toHaveCount(8);
	await filter.click();
	await filter.pressSequentially('run 0');
	await expect(page).toHaveURL(/[?&]q=run(?:\+|%20)0(?:&|$)/);
	await filter.pressSequentially('5');
	await expect(page).toHaveURL(/[?&]q=run(?:\+|%20)05(?:&|$)/);
	await expect(items).toHaveCount(1);
	await page.reload();
	await expect(filter).toHaveValue('run 05');
	await expect(items).toHaveCount(1);
	await page.goBack();
	await expect(page).toHaveURL(before);
	await expect(filter).toHaveValue('');
	await expect(items).toHaveCount(8);
});

test('the project list search is one step in history', async ({ page, owner }) => {
	void owner;
	for (const name of ['Steps Alpha catchment', 'Steps Beta catchment']) await createProject(page.request, name);
	await page.goto('/');
	await expect(page.getByRole('rowheader', { name: 'Steps Beta catchment' })).toBeVisible();
	const search = page.getByLabel('Search projects');
	await search.click();
	await search.pressSequentially('alpha');
	await expect(page).toHaveURL(/[?&]q=alpha(?:&|$)/);
	await expect(page.getByRole('rowheader', { name: 'Steps Beta catchment' })).toHaveCount(0);
	await page.reload();
	await expect(search).toHaveValue('alpha');
	await expect(page.getByRole('rowheader', { name: 'Steps Alpha catchment' })).toBeVisible();
	await page.goBack();
	await expect(page).not.toHaveURL(/q=/);
	await expect(search).toHaveValue('');
	await expect(page.getByRole('rowheader', { name: 'Steps Beta catchment' })).toBeVisible();
});

test('the outcome matrix and the seasonal outlook say when their lookup failed, and Try again reads it again', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	const id = await seedRiverProject(page.request, 'Steps lookups');
	await createRun(page.request, id, 'Baseline');
	let failSweeps = true;
	let failOutlooks = true;
	await page.route(new RegExp(`/projects/${id}/sweeps\\?baseRunId=`), (route) => (failSweeps ? route.fulfill({ status: 500, json: { error: 'Something went wrong' } }) : route.continue()));
	await page.route(new RegExp(`/projects/${id}/outlooks\\?baseRunId=`), (route) => (failOutlooks ? route.fulfill({ status: 500, json: { error: 'Something went wrong' } }) : route.continue()));
	await openRiver(page, id);

	const matrix = page.getByTestId('outcome-matrix');
	await expect(matrix.getByTestId('outcome-load-error')).toContainText('Couldn’t look up this run’s demand sweep:');
	failSweeps = false;
	await matrix.getByTestId('outcome-load-error').getByRole('button', { name: 'Try again' }).click();
	await expect(matrix.getByTestId('outcome-load-error')).toHaveCount(0);
	await expect(matrix).toHaveAttribute('data-state', 'empty');

	const outlook = page.getByTestId('seasonal-outlook');
	await expect(outlook.getByTestId('outlook-load-error')).toContainText('Couldn’t look up this run’s seasonal outlook:');
	failOutlooks = false;
	await outlook.getByTestId('outlook-load-error').getByRole('button', { name: 'Try again' }).click();
	await expect(outlook.getByTestId('outlook-load-error')).toHaveCount(0);
	await expect(outlook).toHaveAttribute('data-state', 'empty');
});

test('the calibration rules’ fits say when they couldn’t be read, and Try again reads them', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Steps fits');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	let fail = true;
	await page.route(new RegExp(`/projects/${project.id}/auto-calibrations$`), (route) =>
		fail && route.request().method() === 'GET' ? route.fulfill({ status: 500, json: { error: 'Something went wrong' } }) : route.continue()
	);
	await page.goto(`/projects/${project.id}?tab=calibration`);
	const auto = page.getByRole('region', { name: /^Automated calibration/ });
	await expect(auto.getByTestId('auto-load-error')).toContainText('Couldn’t load the calibration rules’ fits:');
	fail = false;
	const read = page.waitForResponse((r) => r.request().method() === 'GET' && new RegExp(`/projects/${project.id}/auto-calibrations$`).test(r.url()) && r.ok());
	await auto.getByTestId('auto-load-error').getByRole('button', { name: 'Try again' }).click();
	await read;
	await expect(auto.getByTestId('auto-load-error')).toHaveCount(0);
});

test('deleting a note in the notes drawer puts the focus on the note now in its place, then on the add field', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Steps notes');
	for (const body of ['Oldest note', 'Middle note', 'Newest note']) {
		expect((await page.request.post(`${API_URL}/projects/${project.id}/notes`, { data: { body, visibility: 'team' } })).status()).toBe(201);
	}
	await page.goto(`/projects/${project.id}?tab=project`);
	await page.getByRole('region', { name: 'Recent notes' }).getByRole('button', { name: /^Notes/ }).click();
	const dialog = page.getByRole('dialog', { name: 'Project notes' });
	const items = dialog.getByRole('list', { name: 'Notes' }).getByRole('listitem');
	await expect(items).toHaveCount(3);
	// Newest first: deleting the middle one puts the focus on the oldest, now second.
	await items.nth(1).getByRole('button', { name: /^Delete/ }).click();
	await answerConfirm(page, true, 'Delete this note?');
	await expect(items).toHaveCount(2);
	await expect(items.nth(1)).toBeFocused();
	await expect(items.nth(1)).toContainText('Oldest note');
	// The last one: the note before it takes its place.
	await items.nth(1).getByRole('button', { name: /^Delete/ }).click();
	await answerConfirm(page, true, 'Delete this note?');
	await expect(items).toHaveCount(1);
	await expect(items.first()).toBeFocused();
	// None left: the add field.
	await items.first().getByRole('button', { name: /^Delete/ }).click();
	await answerConfirm(page, true, 'Delete this note?');
	await expect(items).toHaveCount(0);
	await expect(dialog.getByLabel('Add a note')).toBeFocused();
});
