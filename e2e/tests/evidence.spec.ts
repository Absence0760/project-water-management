// The nominated evidence run (010_run_nomination, docs/ui.md § Evidence
// nomination): an editor nominates a run with a reason, replaces it, and the
// history keeps both; nominated runs can't be deleted; a newer run with a
// different runoff model (an old legacy run, planted: the API can't make one
// since engine 1.0.0) is flagged; compare says which side is the evidence;
// a viewer reads it all but can't nominate.
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { plantLegacyRun } from '../support/db.ts';
import { expect, test } from '../support/fixtures.ts';

test('an editor nominates a run as evidence, replaces it, and the history keeps both', async ({ page, owner, signIn }) => {
	const project = await seedRunnableProject(page.request, 'Evidence');
	const runA = await createRun(page.request, project.id, 'GR4J A');
	const runB = await createRun(page.request, project.id, 'GR4J B');

	await page.goto(`/projects/${project.id}?tab=runs&run=${runA}`);
	const list = page.getByRole('region', { name: 'Runs', exact: true });
	const evidence = page.getByRole('region', { name: 'Evidence', exact: true });
	await expect(page.getByRole('heading', { level: 2, name: 'GR4J A' })).toBeVisible();
	await expect(evidence).toContainText('This run is not nominated as evidence. No run of this project has been nominated yet.');
	await expect(evidence.getByText('No nominations yet.')).toBeVisible();

	// The reason is required.
	const reason = evidence.getByRole('textbox', { name: /^Why this run is the evidence/ });
	const nominateA = evidence.getByRole('button', { name: 'Nominate as evidence' });
	await expect(nominateA).toBeDisabled();
	await reason.fill('Calibrated GR4J against the logger record.');
	await nominateA.click();

	// The run is badged in the list and the header, and can no longer be deleted.
	const rowA = list.getByRole('listitem').filter({ has: page.getByRole('button', { name: /^GR4J A/ }) });
	await expect(rowA.getByText('Evidence', { exact: true })).toBeVisible();
	await expect(rowA.getByRole('button', { name: /^Delete run/ })).toHaveCount(0);
	await expect(page.getByRole('link', { name: /^Nominated as evidence on \d{4}-\d\d-\d\d \d\d:\d\d by Owner \d+\.$/ })).toBeVisible();
	await expect(evidence.getByRole('button', { name: /^Nominate/ })).toHaveCount(0);
	await expect(evidence.getByText('This run is the nominated evidence run.')).toBeVisible();

	// Replace it with B: a new entry, and A's stays in the history.
	await list.getByRole('button', { name: /^GR4J B/ }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'GR4J B' })).toBeVisible();
	await expect(evidence).toContainText('The project\'s evidence run is “GR4J A”.');
	await evidence.getByRole('textbox', { name: /^Why this run is the evidence/ }).fill('Refitted after the logger check.');
	await evidence.getByRole('button', { name: 'Nominate this run instead' }).click();

	const history = evidence.getByRole('list', { name: 'Nomination history, newest first' });
	await expect(history.getByRole('listitem')).toHaveCount(2);
	await expect(history.getByRole('listitem').nth(0)).toContainText(/^Replaced by “GR4J B” on .* by Owner \d+Current/);
	await expect(history.getByRole('listitem').nth(0)).toContainText('GR4J, engine');
	await expect(history.getByRole('listitem').nth(0)).toContainText('Refitted after the logger check.');
	await expect(history.getByRole('listitem').nth(1)).toContainText(/^Nominated “GR4J A” on .* by Owner \d+/);
	await expect(history.getByRole('listitem').nth(1)).toContainText('Calibrated GR4J against the logger record.');
	await expect(rowA.getByText('Former evidence', { exact: true })).toBeVisible();
	const rowB = list.getByRole('listitem').filter({ has: page.getByRole('button', { name: /^GR4J B/ }) });
	await expect(rowB.getByText('Evidence', { exact: true })).toBeVisible();

	// A newer run of another runoff model (a stored legacy run, engine < 1.0.0) is flagged; it can't itself be nominated.
	await expect(page.getByTestId('evidence-drift')).toHaveCount(0);
	const legacy = await createRun(page.request, project.id, 'Legacy');
	await plantLegacyRun(legacy);
	await page.goto(`/projects/${project.id}?tab=runs&run=${legacy}`);
	await expect(page.getByTestId('evidence-drift')).toHaveText(
		'1 run made after the nominated evidence run “GR4J B” uses a different runoff model (legacy (b023 workbook), not GR4J). ' +
			'The nomination still stands: results from those runs are not the evidence unless one is nominated, with a reason.'
	);
	await expect(page.getByRole('heading', { level: 2, name: 'Legacy' })).toBeVisible();
	await expect(evidence.getByText(/legacy runoff model \(removed in engine 1\.0\.0\) is workbook comparison only/)).toBeVisible();
	await expect(evidence.getByRole('button', { name: /^Nominate/ })).toHaveCount(0);

	// Compare says which side is the evidence, and what replaced the other.
	await page.goto(`/compare?a=${project.id}:${runA}&b=${project.id}:${runB}`);
	const notes = page.getByTestId('evidence-note');
	await expect(notes).toHaveCount(2);
	await expect(notes.nth(0)).toHaveText(
		/^Run A was the evidence run, nominated on .* by Owner \d+ \(“Calibrated GR4J against the logger record\.”\), then replaced by “GR4J B” on .* because “Refitted after the logger check\.”\.$/
	);
	await expect(notes.nth(1)).toHaveText(/^Run B is the nominated evidence run, nominated on .* by Owner \d+ \(“Refitted after the logger check\.”\)\.$/);

	// A viewer reads the history but has no nominate action.
	const viewer = await signIn('Evidence viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=runs&run=${runA}`);
	const seen = viewer.page.getByRole('region', { name: 'Evidence', exact: true });
	await expect(seen.getByRole('list', { name: 'Nomination history, newest first' }).getByRole('listitem')).toHaveCount(2);
	await expect(seen.getByRole('textbox')).toHaveCount(0);
	await expect(seen.getByRole('button')).toHaveCount(0);
	void owner;
});

// 097_nomination_withdrawal: withdrawing leaves no evidence run, and the history says so.
test('an editor withdraws the nomination with a reason; the history keeps it and the run can be nominated again', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Evidence withdrawn');
	const runA = await createRun(page.request, project.id, 'GR4J A');

	await page.goto(`/projects/${project.id}?tab=runs&run=${runA}`);
	const list = page.getByRole('region', { name: 'Runs', exact: true });
	const evidence = page.getByRole('region', { name: 'Evidence', exact: true });
	await expect(page.getByRole('heading', { level: 2, name: 'GR4J A' })).toBeVisible();
	// Nothing to withdraw before a nomination.
	await expect(evidence.getByRole('button', { name: /^Withdraw/ })).toHaveCount(0);
	await evidence.getByRole('textbox', { name: /^Why this run is the evidence/ }).fill('Calibrated GR4J against the logger record.');
	await evidence.getByRole('button', { name: 'Nominate as evidence' }).click();

	await evidence.getByRole('button', { name: 'Withdraw the nomination…' }).click();
	const why = evidence.getByRole('textbox', { name: /^Why the nomination is withdrawn/ });
	const confirm = evidence.getByRole('button', { name: 'Withdraw the nomination', exact: true });
	await expect(confirm).toBeDisabled();
	await why.fill('The licence application was withdrawn.');
	await confirm.click();

	await expect(evidence).toContainText('The project\'s nomination was withdrawn: no run is its evidence now.');
	const history = evidence.getByRole('list', { name: 'Nomination history, newest first' });
	await expect(history.getByRole('listitem')).toHaveCount(2);
	await expect(history.getByRole('listitem').nth(0)).toContainText(/^Withdrawn on .* by Owner \d+/);
	await expect(history.getByRole('listitem').nth(0)).toContainText('The licence application was withdrawn.');
	await expect(history.getByRole('listitem').nth(0)).not.toContainText('Current');
	const rowA = list.getByRole('listitem').filter({ has: page.getByRole('button', { name: /^GR4J A/ }) });
	await expect(rowA.getByText('Former evidence', { exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: /; withdrawn on \d{4}-\d\d-\d\d \d\d:\d\d by Owner \d+\.$/ })).toBeVisible();

	// The same run may be nominated again, and is current once more.
	await evidence.getByRole('textbox', { name: /^Why this run is the evidence/ }).fill('Reinstated for the new application.');
	await evidence.getByRole('button', { name: 'Nominate as evidence' }).click();
	await expect(history.getByRole('listitem')).toHaveCount(3);
	await expect(history.getByRole('listitem').nth(0)).toContainText(/^Nominated “GR4J A” on .* by Owner \d+Current/);
	await expect(rowA.getByText('Evidence', { exact: true })).toBeVisible();
});
