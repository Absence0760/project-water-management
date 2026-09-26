// Scenarios (issue #18, docs/scenarios.md, docs/ui.md § Scenarios): an editor
// starts a scenario on a run, raises a dam 20 % as an override, marks the farm
// as the proposer's so the change is a proposal (the red "Baseline
// assumptions changed" callout goes), undoes an edit, runs it and compares it
// with its base (headline deltas, the per-node overlay, the compare page's
// Scenario overrides); a rebase onto a run without the farm reports the
// change that no longer applies; a viewer reads it all but changes nothing.
// Axe-scanned in both themes and on a phone.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createRun, putModel, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const NAME = 'Upper dam +20 %';
const RAISE = 'Upper farm: Dam capacity 150,000 m³ → 180,000 m³';

const changes = (page: Page) => page.getByRole('list', { name: `Changes in ${NAME}` });

/** A project with one run and a scenario raising the Upper farm dam 20 %, made through the API. */
async function seedScenario(page: Page, projectName: string, ownUpper = true) {
	const project = await seedRunnableProject(page.request, projectName);
	const runId = await createRun(page.request, project.id, 'Baseline');
	const upper = (project.model.nodes as { id: string; name: string }[]).find((n) => n.name === 'Upper farm')!.id;
	const res = await page.request.post(`${API_URL}/projects/${project.id}/scenarios`, {
		data: {
			name: NAME,
			baseRunId: runId,
			ops: [{ op: 'node.set', nodeId: upper, field: 'damCapacityM3', value: 180_000 }],
			ownedNodeIds: ownUpper ? [upper] : []
		}
	});
	expect(res.status()).toBe(201);
	const { scenario } = (await res.json()) as { scenario: { id: string } };
	return { project, runId, upper, scenarioId: scenario.id };
}

test('an editor raises a dam 20 % in a scenario, runs it and compares it with its base', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Scenario golden path');
	await createRun(page.request, project.id, 'Baseline');

	await page.goto(`/projects/${project.id}?tab=scenarios`);
	await expect(page.getByTestId('scenarios-empty')).toHaveText('No scenarios yet. A scenario changes the published baseline without copying it.');

	// Start one on the only run.
	await expect(page.getByLabel('Base run')).toHaveValue(/.+/);
	await page.getByLabel('Name', { exact: true }).fill(NAME);
	await page.getByRole('button', { name: 'Create scenario' }).click();
	await expect(page.getByRole('heading', { level: 2, name: NAME })).toBeVisible();
	await expect(page).toHaveURL(/[?&]scenario=[0-9a-f-]{36}/);
	await expect(page.getByTestId('scenario-base')).toContainText('Based on run Baseline (run ');
	await expect(page.getByTestId('scenario-not-run')).toBeVisible();

	// Raise the Upper farm dam from 150 000 to 180 000 m³ (20 %): the form shows the value it replaces.
	const form = page.getByRole('form', { name: 'Add a change' });
	await expect(form.getByLabel('Kind of change')).toHaveValue('node.set');
	await form.getByLabel('Node').selectOption({ label: 'Upper farm' });
	await form.getByLabel('Field').selectOption({ label: 'Dam capacity' });
	await expect(form.getByTestId('op-current')).toHaveText('Now: 150,000 m³');
	await expect(form.getByLabel('Dam capacity (m³)')).toHaveValue('150000');
	await form.getByLabel('Dam capacity (m³)').fill('180000');
	await form.getByRole('button', { name: 'Add change' }).click();
	await expect(changes(page).getByRole('listitem')).toHaveCount(1);
	await expect(changes(page).getByRole('listitem')).toContainText(RAISE);

	// No node is the proposer's yet, so the raise is a baseline assumption, called out in red.
	await expect(changes(page).getByRole('listitem')).toContainText('Baseline assumption');
	await expect(page.getByTestId('baseline-callout')).toContainText('Baseline assumptions changed');
	await page.getByRole('group', { name: "The proposer's nodes" }).getByLabel('Upper farm').check();
	await expect(changes(page).getByRole('listitem')).toContainText('Proposal');
	await expect(page.getByTestId('baseline-callout')).toHaveCount(0);

	// A second edit, undone.
	await form.getByLabel('Kind of change').selectOption({ label: 'Remove a node' });
	await form.getByLabel('Node').selectOption({ label: 'Lower farm' });
	await form.getByRole('button', { name: 'Add change' }).click();
	await expect(changes(page).getByRole('listitem')).toHaveCount(2);
	await expect(changes(page).getByRole('listitem').nth(1)).toContainText('Remove “Lower farm”');
	await page.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(changes(page).getByRole('listitem')).toHaveCount(1);
	await expect(changes(page).getByRole('listitem')).toContainText(RAISE);

	// A bad value is refused in the form, in the units typed, before anything is saved.
	await form.getByLabel('Kind of change').selectOption({ label: "Change a node's value" });
	await form.getByLabel('Node').selectOption({ label: 'Upper farm' });
	await form.getByLabel('Field').selectOption({ label: 'Dam minimum operating level' });
	await form.getByLabel('Dam minimum operating level (%)').fill('150');
	await form.getByRole('button', { name: 'Add change' }).click();
	await expect(form.getByRole('alert')).toHaveText('Must be at most 100 %');
	await expect(changes(page).getByRole('listitem')).toHaveCount(1);

	// Run it: the compare section shows it against its base.
	await page.getByRole('button', { name: 'Run scenario' }).click();
	const compare = page.getByRole('region', { name: 'Scenario against its base' });
	await expect(compare.getByText(/^A: Baseline \(base, run .+\) · B: Upper dam \+20 % \(this scenario, run .+\)\. Every change is B − A\.$/)).toBeVisible();
	await expect(compare.getByRole('region', { name: 'Headline results' })).toBeVisible();
	const overlay = compare.getByRole('region', { name: 'Daily series' });
	await overlay.getByLabel('Node').selectOption({ label: 'Upper farm' });
	await overlay.getByLabel('Series').selectOption('dam_storage');
	// The bigger dam stores more: B is above A on some day and never below it.
	await expect(overlay.getByTestId('overlay-summary')).toHaveText(/B is higher on [1-9]\d* days? and lower on 0 days; the largest change is \+[\d.,]+ m³ on \d{4}-\d\d-\d\d\.$/);

	// The list and the Runs tab know the run came from the scenario, and the base is kept.
	await expect(page.getByRole('button', { name: new RegExp(`^${NAME.replace('+', '\\+')}`) })).toContainText(/1 change · on Baseline · run /);
	await page.getByRole('link', { name: 'Runs & results' }).click();
	const runsList = page.getByRole('region', { name: 'Runs', exact: true });
	const row = (label: string) => runsList.getByRole('listitem').filter({ has: page.getByRole('button', { name: new RegExp(`^${label}`) }) });
	await expect(row('Upper dam').getByText('Scenario', { exact: true })).toBeVisible();
	await expect(row('Baseline').getByText('Scenario base', { exact: true })).toBeVisible();
	await expect(row('Baseline').getByRole('button', { name: /^Delete run/ })).toHaveCount(0);
	await page.goBack();

	// The full comparison lists the scenario's overrides above "What changed".
	await page.getByRole('link', { name: 'Open the full comparison' }).click();
	const overrides = page.getByRole('region', { name: 'Scenario overrides' });
	await expect(overrides.getByTestId('scenario-overrides-b')).toContainText(`Run B is the scenario ${NAME}, on run A as its base: 1 change.`);
	const recorded = overrides.getByRole('list', { name: `Changes in scenario ${NAME} (run B)` }).getByRole('listitem');
	await expect(recorded).toHaveCount(1);
	await expect(recorded).toContainText(RAISE);
	await expect(recorded).toContainText('Proposal');
	await expect(page.getByRole('region', { name: 'What changed' })).toContainText('Upper farm: dam capacity 150,000 m³ → 180,000 m³');
	await expectNoViolations(page);
});

test('a rebase onto a run without the farm reports the change that no longer applies, and a run is refused until it is fixed', async ({ page, owner }) => {
	void owner;
	const { project, scenarioId } = await seedScenario(page, 'Scenario rebase');
	// The live model loses Upper farm (and its crop area and transfer); run it.
	const model = structuredClone(project.model);
	const upper = model.nodes.find((n) => n.name === 'Upper farm')!.id as string;
	model.nodes = model.nodes.filter((n) => n.id !== upper);
	model.cropAreas = model.cropAreas.filter((a) => a.nodeId !== upper);
	model.transfers = [];
	await putModel(page.request, project.id, model);
	const newer = await createRun(page.request, project.id, 'Without upper');

	await page.goto(`/projects/${project.id}?tab=scenarios&scenario=${scenarioId}`);
	await expect(changes(page).getByRole('listitem')).toContainText(RAISE);
	await page.getByText('Rebase onto another run').click();
	await page.getByLabel('New base run').selectOption(newer);
	await page.getByRole('button', { name: 'Check', exact: true }).click();
	const check = page.getByTestId('rebase-check');
	await expect(check).toContainText("1 change doesn't apply to that run:");
	await expect(check.getByRole('listitem')).toHaveText('op 1 (node.set): node “Upper farm” not found');

	await check.getByRole('button', { name: 'Rebase onto this run' }).click();
	await expect(page.getByTestId('scenario-base')).toContainText('Based on run Without upper');
	await expect(page.getByTestId('scenario-problems')).toHaveText("1 change doesn't apply to the base run, so the scenario can't run until it is removed or the base changes.");
	await expect(changes(page).getByRole('listitem')).toContainText("Doesn't apply: node “Upper farm” not found");
	await expect(page.getByRole('button', { name: 'Run scenario' })).toBeDisabled();

	// The server refuses the run too (422, the problems listed).
	const res = await page.request.post(`${API_URL}/projects/${project.id}/scenarios/${scenarioId}/runs`, { data: {} });
	expect(res.status()).toBe(422);

	// Removing the change that no longer applies leaves nothing to run.
	await changes(page).getByRole('button', { name: /^Remove change 1: / }).click();
	await expect(page.getByTestId('scenario-problems')).toHaveCount(0);
	await expect(changes(page)).toHaveCount(0);
});

test('a viewer reads a scenario and its comparison but changes nothing', async ({ page, owner, signIn }) => {
	void owner;
	const { project, scenarioId } = await seedScenario(page, 'Scenario viewer');
	const run = await page.request.post(`${API_URL}/projects/${project.id}/scenarios/${scenarioId}/runs`, { data: {} });
	expect(run.status()).toBe(201);
	const viewer = await signIn('Scenario viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');

	await viewer.page.goto(`/projects/${project.id}?tab=scenarios`);
	await viewer.page.getByRole('button', { name: /^Upper dam/ }).click();
	await expect(changes(viewer.page).getByRole('listitem')).toContainText(RAISE);
	await expect(changes(viewer.page).getByRole('listitem')).toContainText('Proposal');
	await expect(viewer.page.getByRole('region', { name: 'Scenario against its base' }).getByRole('region', { name: 'Headline results' })).toBeVisible();
	for (const name of ['Create scenario', 'Run scenario', 'Undo', 'Submit', 'Delete scenario', 'Rename', 'Add change']) {
		await expect(viewer.page.getByRole('button', { name, exact: true })).toHaveCount(0);
	}
	await expect(changes(viewer.page).getByRole('button', { name: /^Remove change/ })).toHaveCount(0);
	await expect(viewer.page.getByRole('group', { name: "The proposer's nodes" }).getByLabel('Upper farm')).toBeDisabled();
});

test('submitting freezes a scenario; withdrawn, it can be deleted and its base is released', async ({ page, owner }) => {
	void owner;
	const { project, scenarioId } = await seedScenario(page, 'Scenario status');
	await page.goto(`/projects/${project.id}?tab=scenarios&scenario=${scenarioId}`);
	page.on('dialog', (d) => d.accept());
	await page.getByRole('button', { name: 'Submit', exact: true }).click();
	await expect(page.getByText('Submitted', { exact: true })).toBeVisible();
	await expect(page.getByRole('form', { name: 'Add a change' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Delete scenario' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
	await expect(page.getByText('Withdrawn', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Delete scenario' }).click();
	await expect(page.getByTestId('scenarios-empty')).toBeVisible();
	await expect(page).not.toHaveURL(/scenario=/);
	// The base is no longer cited: the Runs tab (its list reloaded after the delete) offers to delete it again.
	await page.getByRole('link', { name: 'Runs & results' }).click();
	const baseline = page.getByRole('region', { name: 'Runs', exact: true }).getByRole('listitem').filter({ hasText: /^Baseline/ });
	await expect(baseline.getByText('Scenario base', { exact: true })).toHaveCount(0);
	await baseline.getByRole('button', { name: /^Delete run Baseline/ }).click();
	await expect(page.getByRole('region', { name: 'Runs', exact: true }).getByRole('listitem')).toHaveCount(0);
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`the Scenarios tab has no violations (${colorScheme})`, async ({ page, owner }) => {
		void owner;
		await page.emulateMedia({ colorScheme });
		const { project, scenarioId } = await seedScenario(page, `Scenario a11y ${colorScheme}`, false);
		await page.goto(`/projects/${project.id}?tab=scenarios&scenario=${scenarioId}`);
		await expect(page.getByTestId('baseline-callout')).toBeVisible();
		await expect(page.getByRole('form', { name: 'Add a change' })).toBeVisible();
		await expectNoViolations(page);
	});
}

test('the Scenarios tab has no violations on a phone', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 390, height: 844 });
	const { project, scenarioId } = await seedScenario(page, 'Scenario a11y phone');
	await page.request.post(`${API_URL}/projects/${project.id}/scenarios/${scenarioId}/runs`, { data: {} });
	await page.goto(`/projects/${project.id}?tab=scenarios&scenario=${scenarioId}`);
	await expect(page.getByRole('region', { name: 'Scenario against its base' }).getByRole('region', { name: 'Headline results' })).toBeVisible();
	// Stacked: nothing scrolls the page sideways.
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await expectNoViolations(page);
});
