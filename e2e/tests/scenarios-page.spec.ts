// The Scenarios page's layout (?tab=scenarios, issue #17 option A; the
// scenario editor's own behaviour is scenarios.spec.ts): the section header
// carries the counts and + New scenario, which opens the create dialog at
// `new=1` (Back closes it); the list is a rail beside the scenario, as tall as
// the window, its rows scrolling inside it and staying in view while the
// scenario scrolls; with none picked the newest opens in place; Run, the
// status moves and Delete sit in the scenario's head row; override mode
// brings its banner into view clear of the record bar. Thirty scenarios at
// 1440 × 960, 1280 × 800 and on a phone; a viewer; axe in both themes and on
// a phone. The Applicant view with thirty applications: New application is
// its section header's action, on the first screen. Synthetic data only.
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { createScenario, header, newDialog, openScenarios, rail, scenarioList, seedManyScenarios } from '../support/scenarios.ts';

test('the header counts the scenarios; + New scenario opens a dialog that Back and Esc close, and creating picks the new one', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Scenarios page header');
	const runId = await createRun(page.request, project.id, 'Baseline');
	const first = await createScenario(page.request, project.id, { name: 'Older what-if', baseRunId: runId });
	expect((await page.request.patch(`${API_URL}/projects/${project.id}/scenarios/${first}`, { data: { status: 'submitted' } })).status()).toBe(200);
	const newest = await createScenario(page.request, project.id, { name: 'Newest what-if', baseRunId: runId });

	// None picked: the newest opens, in place.
	await openScenarios(page, project.id);
	await expect(page).toHaveURL(new RegExp(`[?&]scenario=${newest}`));
	await expect(page.getByRole('heading', { level: 2, name: 'Newest what-if' })).toBeVisible();
	await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
	await expect(header(page).getByTestId('section-context')).toHaveText('2 scenarios · 1 draft · 1 submitted · none run yet');
	await expect(scenarioList(page).getByRole('button')).toHaveText([/^Newest what-if\s*Draft/, /^Older what-if\s*Submitted/]);

	// + New scenario: a link to `new=1`; Back closes the dialog and stays on the scenario.
	await header(page).getByRole('link', { name: '+ New scenario', exact: true }).click();
	await expect(page).toHaveURL(/[?&]new=1/);
	const dialog = newDialog(page);
	await expect(dialog).toBeVisible();
	await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused();
	await expect(dialog.getByLabel('Base run')).toHaveValue(runId);
	await page.goBack();
	await expect(dialog).toBeHidden();
	await expect(page).not.toHaveURL(/new=1/);
	await expect(page).toHaveURL(new RegExp(`[?&]scenario=${newest}`));

	// Esc closes it too, dropping `new` in place.
	await header(page).getByRole('link', { name: '+ New scenario', exact: true }).click();
	await expect(dialog).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(page).not.toHaveURL(/new=1/);

	// Creating: the new scenario is picked, the dialog closed, and Back goes to the one picked before, not the dialog.
	await header(page).getByRole('link', { name: '+ New scenario', exact: true }).click();
	await dialog.getByLabel('Name', { exact: true }).fill('Made in the dialog');
	await dialog.getByRole('button', { name: 'Create scenario' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Made in the dialog' })).toBeVisible();
	await expect(dialog).toBeHidden();
	await expect(page).not.toHaveURL(/new=1/);
	await expect(header(page).getByTestId('section-context')).toHaveText('3 scenarios · 2 drafts · 1 submitted · none run yet');
	await page.goBack();
	await expect(page.getByRole('heading', { level: 2, name: 'Newest what-if' })).toBeVisible();
	await expect(newDialog(page)).toBeHidden();

	// The default pick replaces the bare list in history: Back from it leaves the section.
	await page.getByRole('link', { name: 'Summary', exact: true }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible();
	await page.getByRole('link', { name: 'Scenarios', exact: true }).click();
	await expect(page).toHaveURL(/[?&]scenario=/);
	await page.goBack();
	await expect(page.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible();
});

test('an empty section: the empty state starts one, and with no run there is nothing to start from', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Scenarios page empty');
	await openScenarios(page, project.id);
	await expect(header(page).getByTestId('section-context')).toHaveText('No scenarios yet');
	await expect(page.getByText('Run the model first: a scenario is a set of changes to a run.')).toBeVisible();
	await expect(header(page).getByRole('link', { name: '+ New scenario' })).toHaveCount(0);
	// With nothing to start from, `new=1` opens nothing.
	await openScenarios(page, project.id, '&new=1');
	await expect(page.getByRole('dialog')).toHaveCount(0);

	await createRun(page.request, project.id, 'Baseline');
	await openScenarios(page, project.id);
	await expect(page.getByTestId('scenarios-empty')).toBeVisible();
	await rail(page).getByRole('link', { name: 'Start a scenario', exact: true }).click();
	await expect(newDialog(page)).toBeVisible();
	await expectNoViolations(page);
});

test('thirty scenarios: the rail fills the window and scrolls inside itself, stays in view as the scenario scrolls, and Run is in the head row', async ({ page, owner }) => {
	void owner;
	const project = await seedManyScenarios(page.request, 'Scenarios page big');
	for (const [width, height] of [
		[1440, 960],
		[1280, 800]
	] as const) {
		await page.setViewportSize({ width, height });
		await openScenarios(page, project.id, `&scenario=${project.ids[0]}`);
		await expect(page.getByRole('heading', { level: 2, name: /what-if 1:/ })).toBeVisible();
		await expect(scenarioList(page).getByRole('button')).toHaveCount(30);
		await expect(header(page).getByTestId('section-context')).toHaveText('30 scenarios · 30 drafts · none run yet');

		// The rail reaches the window's bottom; its rows scroll inside it.
		const box = (await rail(page).boundingBox())!;
		expect(box.y + box.height).toBeLessThanOrEqual(height);
		expect(box.y + box.height).toBeGreaterThan(height - 40);
		const list = await scenarioList(page).evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
		expect(list.sh).toBeGreaterThan(list.ch);
		// The oldest (picked) is the last row: in reach by scrolling the list, not the page.
		await scenarioList(page).getByRole('button', { name: /what-if 1:/ }).scrollIntoViewIfNeeded();
		await expect(scenarioList(page).getByRole('button', { name: /what-if 1:/ })).toBeInViewport();

		// Run and the status moves are in the head row, on the first screen, above the changes.
		const run = page.getByTestId('scenario-actions').getByRole('button', { name: 'Run scenario' });
		await expect(run).toBeInViewport();
		const changesY = (await page.getByRole('heading', { level: 3, name: 'Changes' }).boundingBox())!.y;
		expect((await run.boundingBox())!.y).toBeLessThan(changesY);
		await expect(page.getByTestId('scenario-actions').getByRole('button', { name: 'Submit', exact: true })).toBeVisible();

		// Scrolling the scenario keeps the rail in view, and no shorter.
		await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
		const stuck = (await rail(page).boundingBox())!;
		expect(stuck.y).toBeGreaterThanOrEqual(0);
		expect(stuck.y).toBeLessThan(40);
		expect(stuck.height).toBeGreaterThanOrEqual(box.height - 1);
		await expectNoSidewaysScroll(page);
	}
	await expectNoViolations(page);
});

test('on a phone the list stacks above the scenario, a few rows high, scrolling inside itself', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 390, height: 844 });
	const project = await seedManyScenarios(page.request, 'Scenarios page phone', 12);
	await openScenarios(page, project.id);
	await expect(page.getByRole('heading', { level: 2, name: /what-if 12:/ })).toBeVisible();
	const list = (await scenarioList(page).boundingBox())!;
	const heading = (await page.getByRole('heading', { level: 2, name: /what-if 12:/ }).boundingBox())!;
	expect(heading.y).toBeGreaterThan(list.y + list.height);
	const inner = await scenarioList(page).evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
	expect(inner.sh).toBeGreaterThan(inner.ch);
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page);
	await header(page).getByRole('link', { name: '+ New scenario', exact: true }).click();
	await expect(newDialog(page)).toBeVisible();
	await expectNoViolations(page);
});

test('override mode opens with its banner in view, clear of the record bar, at 1280 × 800', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1280, height: 800 });
	const project = await seedManyScenarios(page.request, 'Scenarios page override', 1);
	await openScenarios(page, project.id);
	await page.getByRole('button', { name: 'Edit in the model tables' }).click();
	const close = page.getByTestId('override-mode').getByRole('button', { name: 'Close override mode' });
	await expect(close).toBeInViewport();
	const closeBox = (await close.boundingBox())!;
	const recordBox = (await page.getByTestId('override-record').boundingBox())!;
	expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(recordBox.y);
	await close.click();
	await expect(page.getByTestId('override-mode')).toHaveCount(0);
});

test('a viewer reads the list and a scenario, with no New scenario and no create dialog', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedManyScenarios(page.request, 'Scenarios page viewer', 3);
	const viewer = await signIn('Scenarios page viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await openScenarios(viewer.page, project.id, '&new=1');
	await expect(viewer.page.getByRole('heading', { level: 2, name: /what-if 3:/ })).toBeVisible();
	await expect(viewer.page.getByRole('dialog')).toHaveCount(0);
	await expect(header(viewer.page).getByRole('link', { name: '+ New scenario' })).toHaveCount(0);
	await expect(viewer.page.getByTestId('scenario-actions')).toHaveCount(0);
	await expect(header(viewer.page).getByTestId('section-context')).toHaveText('3 scenarios · 3 drafts · none run yet');
});

test('an applicant with thirty applications: New application in the header on the first screen, and the list scrolls inside its card', async ({ page, owner, signIn }) => {
	void owner;
	const applicant = await signIn('Scenarios page applicant');
	const project = await seedRunnableProject(page.request, 'Scenarios page applications');
	const runId = await createRun(page.request, project.id, 'Baseline');
	expect((await page.request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId } })).status()).toBe(201);
	await addMember(page.request, project.id, applicant.user.email, 'contributor');
	for (let i = 1; i <= 30; i++) await createScenario(applicant.context.request, project.id, { name: `Application ${i}: raise the dam by ${i * 1000} m³`, baseRunId: runId });

	const a = applicant.page;
	for (const [width, height] of [
		[1440, 960],
		[390, 844]
	] as const) {
		await a.setViewportSize({ width, height });
		await a.goto(`/projects/${project.id}`);
		await expect(a.getByTestId('applicant-view')).toBeVisible();
		await expect(scenarioList(a).getByRole('button')).toHaveCount(30);
		// The newest opens; New application is the section header's action, on the first screen.
		await expect(a.getByRole('heading', { level: 2, name: /^Application 30:/ })).toBeVisible();
		await expect(a.getByTestId('section-header').getByRole('link', { name: 'New application', exact: true })).toBeInViewport();
		await expect(rail(a).getByRole('link', { name: 'New application', exact: true })).toHaveCount(0);
		const list = await scenarioList(a).evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
		expect(list.sh).toBeGreaterThan(list.ch);
		if (width > 900) {
			const box = (await rail(a).boundingBox())!;
			expect(box.y + box.height).toBeLessThanOrEqual(height);
		}
		await expectNoSidewaysScroll(a);
	}
	await a.getByTestId('section-header').getByRole('link', { name: 'New application', exact: true }).click();
	const dialog = newDialog(a, 'New application');
	await dialog.getByLabel('Name', { exact: true }).fill('Application 31');
	await dialog.getByRole('button', { name: 'Create application' }).click();
	await expect(a.getByRole('heading', { level: 2, name: 'Application 31' })).toBeVisible();
	await expect(scenarioList(a).getByRole('button')).toHaveCount(31);
	await expectNoViolations(a);
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`the Scenarios page and its create dialog have no violations (${colorScheme})`, async ({ page, owner }) => {
		void owner;
		await page.emulateMedia({ colorScheme });
		await page.setViewportSize({ width: 1440, height: 960 });
		const project = await seedManyScenarios(page.request, `Scenarios page a11y ${colorScheme}`, 8);
		await openScenarios(page, project.id);
		await expect(page.getByRole('heading', { level: 2, name: /what-if 8:/ })).toBeVisible();
		await expectNoViolations(page);
		await header(page).getByRole('link', { name: '+ New scenario', exact: true }).click();
		await expect(newDialog(page)).toBeVisible();
		await expectNoViolations(page);
	});
}

test('a run scenario shows its run’s validation statement under the comparison, folded shut, and passes axe at desktop and phone', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Scenario validation');
	const runId = await createRun(page.request, project.id, 'Baseline');
	const upper = (project.model.nodes as { id: string; name: string }[]).find((n) => n.name === 'Upper farm')!.id;
	const scenarioId = await createScenario(page.request, project.id, {
		name: 'Bigger upper dam',
		baseRunId: runId,
		ops: [{ op: 'node.set', nodeId: upper, field: 'damCapacityM3', value: 180_000 }]
	});
	const ran = await page.request.post(`${API_URL}/projects/${project.id}/scenarios/${scenarioId}/runs`, { data: {} });
	expect(ran.ok()).toBe(true);
	await openScenarios(page, project.id, `&scenario=${scenarioId}`);

	const compare = page.getByRole('region', { name: 'Scenario against its base' });
	await expect(compare.getByRole('region', { name: 'Headline results' })).toBeVisible();
	const panel = compare.getByRole('region', { name: 'Validation statement' });
	await expect(panel.getByText(/^Engine \d+\.\d+\.\d+: its checks/)).toBeVisible();
	await expect(panel.getByRole('heading', { name: 'Known limitations' })).toHaveCount(0);

	await panel.getByRole('heading', { name: 'Validation statement' }).click();
	await expect(panel.getByRole('heading', { level: 4 })).toHaveText(['Calibration', 'Data quality', /^Errata of engine \d+\.\d+\.\d+$/, 'Known limitations']);
	await expect(panel.getByRole('rowheader', { name: 'N1', exact: true })).toBeVisible();
	await expectNoViolations(page);

	await page.setViewportSize({ width: 390, height: 844 });
	await expect(panel.getByRole('heading', { level: 4, name: 'Known limitations' })).toBeVisible();
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page);
});
