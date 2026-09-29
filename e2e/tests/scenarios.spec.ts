// Scenarios (issue #18, docs/scenarios.md, docs/ui.md § Scenarios): an editor
// starts a scenario on a run, raises a dam 20 % as an override, marks the farm
// as the proposer's so the change is a proposal (the red "Baseline
// assumptions changed" callout goes), undoes an edit, runs it and compares it
// with its base (headline deltas, the per-node overlay, the compare page's
// Scenario overrides); a rebase onto a run without the farm reports the
// change that no longer applies; a licence what-if puts a farm on river first
// with a 1,200 m³/day pump (WP-3.8), its pumping compared with the base's
// none as 0 (issue #54); a trigger farm goes straight to run of river one
// change at a time (an edit group: the half-made edit says why, the finished
// one applies); a viewer reads it all but changes nothing.
// Axe-scanned in both themes and on a phone.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createRun, putModel, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { answerConfirm } from '../support/confirm.ts';

const NAME = 'Upper dam +20 %';
const RAISE = 'Upper farm: Dam capacity 150\u202f000 m³ → 180\u202f000 m³';

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

	// Start one on the only run: + New scenario in the section header opens the create dialog.
	await page.getByTestId('section-header').getByRole('link', { name: '+ New scenario', exact: true }).click();
	const create = page.getByRole('dialog', { name: 'New scenario' });
	await expect(create.getByLabel('Base run')).toHaveValue(/.+/);
	await create.getByLabel('Name', { exact: true }).fill(NAME);
	await create.getByRole('button', { name: 'Create scenario' }).click();
	await expect(page.getByRole('heading', { level: 2, name: NAME })).toBeVisible();
	await expect(page).toHaveURL(/[?&]scenario=[0-9a-f-]{36}/);
	await expect(page.getByTestId('scenario-base')).toContainText('Based on run Baseline (run ');
	await expect(page.getByTestId('scenario-not-run')).toBeVisible();

	// Raise the Upper farm dam from 150 000 to 180 000 m³ (20 %): the form shows the value it replaces.
	const form = page.getByRole('form', { name: 'Add a change' });
	await expect(form.getByLabel('Kind of change')).toHaveValue('node.set');
	await form.getByLabel('Node').selectOption({ label: 'Upper farm' });
	await form.getByLabel('Field').selectOption({ label: 'Dam capacity' });
	await expect(form.getByTestId('op-current')).toHaveText('Now: 150\u202f000 m³');
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

	// GR4J's PE input (issue #39): a monthly row needs its source; the change is a baseline assumption.
	await form.getByLabel('Kind of change').selectOption({ label: 'Change a setting' });
	await form.getByLabel('Setting').selectOption({ label: 'GR4J potential evaporation' });
	await expect(form.getByTestId('op-current')).toHaveText('Now: pan coefficient × A-pan');
	await form.getByLabel('PE comes from').selectOption('monthly');
	await form.getByLabel('Monthly PE (mm, Oct to Sep)').fill('100');
	await form.getByRole('button', { name: 'Add change' }).click();
	await expect(form.getByRole('alert')).toHaveText('GR4J potential evaporation: say where the monthly PE comes from: its source is required');
	await form.getByLabel('Source of the monthly PE (required)').fill('Invented station ET₀');
	await form.getByRole('button', { name: 'Add change' }).click();
	await expect(changes(page).getByRole('listitem')).toHaveCount(2);
	const pe = changes(page).getByRole('listitem').nth(1);
	await expect(pe).toContainText('GR4J potential evaporation: pan coefficient × A-pan → monthly, entered directly: 1\u202f200 mm a year (Invented station ET₀)');
	await expect(pe).toContainText('Baseline assumption');
	await expect(page.getByTestId('baseline-callout')).toContainText('Baseline assumptions changed');
	await page.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(changes(page).getByRole('listitem')).toHaveCount(1);
	await expect(page.getByTestId('baseline-callout')).toHaveCount(0);

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
	const headline = compare.getByRole('region', { name: 'Headline results' });
	await expect(headline.getByRole('heading', { name: 'Water balance' })).toBeVisible();
	// The water balance only: a what-if's fit against the real gauge is no outcome of the scenario (issue #177).
	await expect(headline.getByRole('heading', { name: 'Calibration against observed flow' })).toHaveCount(0);
	await expect(headline.getByRole('heading', { name: /^WR2012 check/ })).toHaveCount(0);
	const overlay = compare.getByRole('region', { name: 'Daily series' });
	await overlay.getByLabel('Node').selectOption({ label: 'Upper farm' });
	await overlay.getByLabel('Series').selectOption('dam_storage');
	// The bigger dam stores more: B is above A on some day and never below it.
	await expect(overlay.getByTestId('overlay-summary')).toHaveText(/B is higher on [1-9]\d* days? and lower on 0 days; the largest change is \+[\d.\u202f]+ m³ on \d{4}-\d\d-\d\d\.$/);

	// The list and the Runs tab know the run came from the scenario, and the base is kept.
	await expect(page.getByRole('button', { name: new RegExp(`^${NAME.replace('+', '\\+')}`) })).toContainText(/1 change · on Baseline · run /);
	// The refused change is still in the form: leaving the scenario asks first (the leave guard, issue #162).
	await page.getByRole('link', { name: 'Runs & results' }).click();
	await answerConfirm(page, true, 'You have unsaved changes (a change not yet added to the scenario). Leave and go to the Runs & results page?');
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
	await expect(page.getByRole('region', { name: 'What changed' })).toContainText('Upper farm: dam capacity 150\u202f000 m³ → 180\u202f000 m³');
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
	// After a reload the new base can't name the farm, but the scenario kept its name with the change.
	await page.reload();
	await expect(changes(page).getByRole('listitem')).toContainText("Doesn't apply: node “Upper farm” not found");
	await expect(changes(page).getByRole('listitem')).toContainText('Upper farm: Dam capacity → 180\u202f000 m³');

	// The server refuses the run too (422, the problems listed).
	const res = await page.request.post(`${API_URL}/projects/${project.id}/scenarios/${scenarioId}/runs`, { data: {} });
	expect(res.status()).toBe(422);

	// Removing the change that no longer applies leaves nothing to run.
	await changes(page).getByRole('button', { name: /^Remove change 1: / }).click();
	await expect(page.getByTestId('scenario-problems')).toHaveCount(0);
	await expect(changes(page)).toHaveCount(0);
});

test('a licence what-if: the proposer\'s farm pumps from the river first at 1,200 m³/day (WP-3.8)', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Scenario river pump');
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}?tab=scenarios&new=1`);
	const name = 'Upper river pump';
	const create = page.getByRole('dialog', { name: 'New scenario' });
	await create.getByLabel('Name', { exact: true }).fill(name);
	await create.getByRole('button', { name: 'Create scenario' }).click();
	await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
	const list = page.getByRole('list', { name: `Changes in ${name}` });

	// The supply rule, in run comparison's words, with the value it replaces.
	const form = page.getByRole('form', { name: 'Add a change' });
	await form.getByLabel('Node').selectOption({ label: 'Upper farm' });
	await form.getByLabel('Field').selectOption({ label: 'Supply rule' });
	await expect(form.getByTestId('op-current')).toHaveText('Now: dam only');
	await form.getByLabel('Supply rule').selectOption({ label: 'river first' });
	await form.getByRole('button', { name: 'Add change' }).click();
	await expect(list.getByRole('listitem')).toHaveCount(1);
	await expect(list.getByRole('listitem')).toContainText('Upper farm: Supply rule dam only → river first');

	// The pump, in m³/day; blank would be no limit.
	await form.getByLabel('Node').selectOption({ label: 'Upper farm' });
	await form.getByLabel('Field').selectOption({ label: 'River pump capacity' });
	await expect(form.getByTestId('op-current')).toHaveText('Now: no limit');
	await expect(form.getByLabel('River pump capacity (m³/day)')).toHaveAttribute('placeholder', 'empty for no limit');
	await form.getByLabel('River pump capacity (m³/day)').fill('1200');
	await form.getByRole('button', { name: 'Add change' }).click();
	await expect(list.getByRole('listitem')).toHaveCount(2);
	await expect(list.getByRole('listitem').nth(1)).toContainText('Upper farm: River pump capacity no limit → 1\u202f200 m³/day');

	// On the proposer's own farm, how it takes water is the proposal.
	await page.getByRole('group', { name: "The proposer's nodes" }).getByLabel('Upper farm').check();
	await expect(list.getByRole('listitem').nth(0)).toContainText('Proposal');
	await expect(list.getByRole('listitem').nth(1)).toContainText('Proposal');
	await expect(page.getByTestId('baseline-callout')).toHaveCount(0);

	// Run it; the full comparison lists both changes and the input diff names them.
	await page.getByRole('button', { name: 'Run scenario' }).click();
	const compare = page.getByRole('region', { name: 'Scenario against its base' });
	await expect(compare.getByRole('region', { name: 'Headline results' })).toBeVisible();

	// The base (dam first) has no river pump, so its pumping reads as 0 rather than being left out (issue #54):
	// the farm row shows the scenario's mean pumped against the base's none…
	const farmRow = compare.getByRole('region', { name: 'Hydrological units' }).getByRole('row', { name: /^Upper farm/ });
	await expect(farmRow.getByTestId('farm-feature-avgRiverAbstractionM3Day')).toContainText('A: none (0)');
	await expect(compare.getByTestId('farm-feature-note')).toHaveText('Pumped from the river: a run with no river pump at a hydrological unit reads as 0 there (“none”).');
	// …and the daily overlay offers the farm's river pumping, the base drawn as zeros and said so.
	const overlay = compare.getByRole('region', { name: 'Daily series' });
	await overlay.getByLabel('Node').selectOption({ label: 'Upper farm' });
	const series = overlay.getByLabel('Series');
	await expect(series.locator('option[value="river_abstraction"]')).toHaveText('Pumped from the river below the dam (part of supplied) (m³/day) · run B only');
	await series.selectOption('river_abstraction');
	await expect(overlay.getByTestId('overlay-zero-note')).toContainText('Not in run A: shown as 0. Run A has no such feature at Upper farm');
	await expect(overlay.getByTestId('overlay-summary')).toHaveText(/^Over the [\d\u202f]+ days both runs have: mean A 0, mean B /);
	await page.getByRole('link', { name: 'Open the full comparison' }).click();
	const recorded = page.getByRole('region', { name: 'Scenario overrides' }).getByRole('list', { name: `Changes in scenario ${name} (run B)` }).getByRole('listitem');
	await expect(recorded).toHaveCount(2);
	const changed = page.getByRole('region', { name: 'What changed' });
	await expect(changed).toContainText('Upper farm: supply rule dam only → river first');
	await expect(changed).toContainText('Upper farm: river pump capacity no limit → 1\u202f200 m³/day');
});

test('a dam raise carries the enlarged dam\'s own survey curve, pasted as the Network tab reads it (engine 1.20.0)', async ({ page, owner }) => {
	void owner;
	const { project, scenarioId } = await seedScenario(page, 'Scenario surveyed raise');
	await page.goto(`/projects/${project.id}?tab=scenarios&scenario=${scenarioId}`);
	await expect(changes(page).getByRole('listitem')).toHaveCount(1);
	await expect(changes(page).getByRole('listitem')).toContainText(RAISE);

	const form = page.getByRole('form', { name: 'Add a change' });
	await form.getByLabel('Node').selectOption({ label: 'Upper farm' });
	await form.getByLabel('Field').selectOption({ label: 'Dam survey curve' });
	await expect(form.getByTestId('op-current')).toHaveText('Now: none (power law)');
	const rows = form.getByLabel('Dam survey curve');
	// Rows the engine couldn't use are refused in the form, before anything is saved.
	await rows.fill('level, area, volume\n0, 0, 0');
	await form.getByRole('button', { name: 'Add change' }).click();
	await expect(form.getByRole('alert')).toHaveText('Dam survey curve: a survey curve needs at least two rows');
	await expect(changes(page).getByRole('listitem')).toHaveCount(1);
	// The raised dam's survey (a header line and tabs, as pasted from a spreadsheet), topping out at the new 180 000 m³.
	await rows.fill('level\tarea\tvolume\n0\t0\t0\n3\t35000\t60000\n6.5\t52000\t180000');
	await form.getByRole('button', { name: 'Add change' }).click();
	await expect(changes(page).getByRole('listitem')).toHaveCount(2);
	await expect(changes(page).getByRole('listitem').nth(1)).toContainText('Upper farm: Dam survey curve none (power law) → 3 survey rows, 180\u202f000 m³ at the top');
	// The form with the paste box open (the next change starts from the curve now set) passes axe.
	await form.getByLabel('Node').selectOption({ label: 'Upper farm' });
	await form.getByLabel('Field').selectOption({ label: 'Dam survey curve' });
	await expect(rows).toHaveValue('0, 0, 0\n3, 35000, 60000\n6.5, 52000, 180000');
	await expect(rows).toHaveAccessibleDescription(/^Level \(m\), area \(m²\), volume \(m³\), one row per line/);
	await expectNoViolations(page);

	// It runs on the curve as entered: the comparison's input diff names it.
	await page.getByRole('button', { name: 'Run scenario' }).click();
	const compare = page.getByRole('region', { name: 'Scenario against its base' });
	await expect(compare.getByRole('region', { name: 'Headline results' })).toBeVisible();
	await page.getByRole('link', { name: 'Open the full comparison' }).click();
	// The form still holds the curve opened for axe: leaving the scenario asks first (the leave guard).
	await answerConfirm(page, true, 'a change not yet added to the scenario');
	await expect(page.getByRole('region', { name: 'What changed' })).toContainText('dam survey curve none (power law) → 3 rows');
});

test('the survey curve paste box fits a phone, with no sideways scroll, and passes axe', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 390, height: 844 });
	const { project, scenarioId } = await seedScenario(page, 'Scenario survey on a phone');
	await page.goto(`/projects/${project.id}?tab=scenarios&scenario=${scenarioId}`);
	const form = page.getByRole('form', { name: 'Add a change' });
	await form.getByLabel('Node').selectOption({ label: 'Upper farm' });
	await form.getByLabel('Field').selectOption({ label: 'Dam survey curve' });
	await expect(form.getByLabel('Dam survey curve')).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await expectNoViolations(page);
});

test('a trigger farm goes straight to run of river, one change at a time: the half-made edit says why, the finished one applies (docs/scenarios.md § Edit groups)', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Scenario edit group');
	const runId = await createRun(page.request, project.id, 'Baseline');
	const upper = (project.model.nodes as { id: string; name: string }[]).find((n) => n.name === 'Upper farm')!.id;
	const name = 'Upper to run of river';
	const res = await page.request.post(`${API_URL}/projects/${project.id}/scenarios`, {
		data: { name, baseRunId: runId, ops: [{ op: 'node.set', nodeId: upper, field: 'supplyRule', value: 'trigger' }], ownedNodeIds: [upper] }
	});
	expect(res.status()).toBe(201);
	const { scenario } = (await res.json()) as { scenario: { id: string } };
	await page.goto(`/projects/${project.id}?tab=scenarios&scenario=${scenario.id}`);
	const items = page.getByRole('list', { name: `Changes in ${name}` }).getByRole('listitem');
	await expect(items).toHaveCount(1);
	await expect(page.getByTestId('scenario-problems')).toHaveCount(0);

	// The rule alone: run of river has no dam, and Upper farm still has one. It follows the trigger change on the
	// same farm, so the two are one edit, skipped whole until it fits: both say why.
	const form = page.getByRole('form', { name: 'Add a change' });
	await form.getByLabel('Node').selectOption({ label: 'Upper farm' });
	await form.getByLabel('Field').selectOption({ label: 'Supply rule' });
	await form.getByLabel('Supply rule').selectOption({ label: 'run of river' });
	await form.getByRole('button', { name: 'Add change' }).click();
	await expect(items).toHaveCount(2);
	await expect(items.nth(1)).toContainText('Upper farm: Supply rule dam, river when low → run of river');
	for (const i of [0, 1]) await expect(items.nth(i)).toContainText("Doesn't apply: \"Upper farm\": run of river has no dam");
	await expect(page.getByTestId('scenario-problems')).toContainText("2 changes don't apply");
	await expect(page.getByRole('button', { name: 'Run scenario' })).toBeDisabled();

	// The form builds on the half-made edit (the farm reads as run of river); emptying the dam next completes it.
	await form.getByLabel('Node').selectOption({ label: 'Upper farm' });
	await form.getByLabel('Field').selectOption({ label: 'Supply rule' });
	await expect(form.getByTestId('op-current')).toHaveText('Now: run of river');
	await form.getByLabel('Field').selectOption({ label: 'Dam capacity' });
	await form.getByLabel('Dam capacity (m³)').fill('0');
	await form.getByRole('button', { name: 'Add change' }).click();
	await expect(items).toHaveCount(3);
	await expect(items.nth(2)).toContainText('Upper farm: Dam capacity 150\u202f000 m³ → 0 m³');
	await expect(page.getByTestId('scenario-problems')).toHaveCount(0);
	for (const i of [0, 1, 2]) await expect(items.nth(i)).not.toContainText("Doesn't apply");
	await expect(page.getByRole('button', { name: 'Run scenario' })).toBeEnabled();
});

test('override mode records edits in the Network, Crops and Transfers tables as changes, never touching the catchment', async ({ page, owner }) => {
	void owner;
	const { project, scenarioId } = await seedScenario(page, 'Scenario override mode');
	// The catchment's own model, as saved: compared whole before and after recording.
	const liveModel = async () => (await (await page.request.get(`${API_URL}/projects/${project.id}/model`)).json()) as unknown;
	const before = await liveModel();
	// A stray overlay parameter on the Scenarios tab never opens the page's grid or farm drawer (the catchment's model, with its save).
	const lower = (project.model.nodes as { id: string; name: string }[]).find((n) => n.name === 'Lower farm')!.id;
	await page.goto(`/projects/${project.id}?tab=scenarios&scenario=${scenarioId}&grid=nodes&farm=${lower}`);
	await expect(changes(page).getByRole('listitem')).toHaveCount(1);
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await page.getByRole('button', { name: 'Edit in the model tables' }).click();

	// It says plainly that this is the scenario, not the catchment, and starts from the scenario's model (the raise applied).
	const mode = page.getByTestId('override-mode');
	await expect(mode.getByRole('heading', { name: `Editing the scenario “${NAME}”, not the catchment` })).toBeVisible();
	await expect(page.getByRole('form', { name: 'Add a change' })).toHaveCount(0);
	// Override mode shows the node table inline, on the scenario's model: not the map, whose Grids menu and
	// farm links open the page's overlays on the catchment's model (issue #17).
	await expect(page.getByLabel('Dam capacity of Upper farm, m³')).toHaveValue('180000');
	await expect(page.locator('details.grids-menu')).toHaveCount(0);
	await expect(page.getByTestId('node-card')).toHaveCount(0);
	await expect(page.getByRole('dialog')).toHaveCount(0);
	const record = page.getByTestId('override-record');
	await expect(record).toContainText('No edits yet.');

	// One edit in each table.
	await page.getByLabel('Dam capacity of Lower farm, m³').fill('100000');
	await mode.getByRole('button', { name: 'Crops', exact: true }).click();
	await page.getByLabel('Orchard on Lower farm, ha').fill('15');
	await mode.getByRole('button', { name: 'Transfers', exact: true }).click();
	await page.getByLabel('transfer 1 enabled').uncheck();
	const pending = record.getByRole('list', { name: `Edits to record in ${NAME}` }).getByRole('listitem');
	// The capacity edit brings the area the table shows with it (blank = estimated): the
	// capacity change alone would resize the dam's area along its own relation (docs/scenarios.md).
	await expect(pending).toHaveCount(4);
	await expect(pending.nth(0)).toContainText('Lower farm: Dam capacity 90\u202f000 m³ → 100\u202f000 m³');
	await expect(pending.nth(1)).toContainText('Lower farm: Dam area when full 32\u202f296 m² → estimated (capacity ÷ 3 m)');
	await expect(pending.nth(2)).toContainText('Lower farm: Orchard 12 ha → 15 ha');
	await expect(pending.nth(3)).toContainText('The transfer Upper farm → Lower farm:');
	expect(await liveModel()).toEqual(before);

	// An edit no change can express is named, and holds the rest back until it is undone.
	await mode.getByRole('button', { name: 'Network', exact: true }).click();
	await page.getByLabel('Kind of Lower farm').selectOption('user');
	await expect(record.getByRole('status').first()).toContainText("Changing “Lower farm” from a farm to a user: a scenario can't change a node's kind.");
	await expect(record.getByRole('button', { name: /^Record/ })).toBeDisabled();
	await page.getByLabel('Kind of Lower farm').selectOption('farm');

	await record.getByRole('button', { name: 'Record 4 changes' }).click();
	await expect(changes(page).getByRole('listitem')).toHaveCount(5);
	await expect(changes(page).getByRole('listitem').nth(1)).toContainText('Lower farm: Dam capacity 90\u202f000 m³ → 100\u202f000 m³');
	// The tables reload from the scenario as it now is: nothing left to record.
	await expect(record).toContainText('No edits yet.');
	await expect(page.getByLabel('Dam capacity of Lower farm, m³')).toHaveValue('100000');

	// The catchment's own model is untouched, and no edit is waiting for the page's save bar.
	expect(await liveModel()).toEqual(before);
	await expect(page.getByRole('region', { name: 'Unsaved model changes' })).toHaveCount(0);

	// Undo takes the four back as one edit; closing brings the form back.
	await page.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(changes(page).getByRole('listitem')).toHaveCount(1);
	await expectNoViolations(page);
	await mode.getByRole('button', { name: 'Close override mode' }).click();
	await expect(page.getByTestId('override-mode')).toHaveCount(0);
	await expect(page.getByRole('form', { name: 'Add a change' })).toBeVisible();
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
	for (const name of ['Create scenario', 'Run scenario', 'Undo', 'Submit', 'Delete scenario', 'Rename', 'Add change', 'Edit in the model tables']) {
		await expect(viewer.page.getByRole('button', { name, exact: true })).toHaveCount(0);
	}
	await expect(changes(viewer.page).getByRole('button', { name: /^Remove change/ })).toHaveCount(0);
	await expect(viewer.page.getByRole('group', { name: "The proposer's nodes" }).getByLabel('Upper farm')).toBeDisabled();
});

test('submitting freezes a scenario; withdrawn, it can be deleted and its base is released', async ({ page, owner }) => {
	void owner;
	const { project, scenarioId } = await seedScenario(page, 'Scenario status');
	await page.goto(`/projects/${project.id}?tab=scenarios&scenario=${scenarioId}`);
	await page.getByRole('button', { name: 'Submit', exact: true }).click();
	await answerConfirm(page, true, 'Its changes, base run and nodes are then frozen.');
	// The status in the scenario's head (the list row shows the same pill).
	const scenario = page.getByRole('region', { name: NAME, exact: true });
	await expect(scenario.getByText('Submitted', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: new RegExp(`^${NAME.replace('+', '\\+')}`) }).getByText('Submitted', { exact: true })).toBeVisible();
	await expect(page.getByRole('form', { name: 'Add a change' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Delete scenario' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
	await expect(scenario.getByText('Withdrawn', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Delete scenario' }).click();
	await answerConfirm(page, true, 'Its runs stay, as ordinary runs.');
	await expect(page.getByTestId('scenarios-empty')).toBeVisible();
	await expect(page).not.toHaveURL(/scenario=/);
	// The base is no longer cited: the Runs tab (its list reloaded after the delete) offers to delete it again.
	await page.getByRole('link', { name: 'Runs & results' }).click();
	const baseline = page.getByRole('region', { name: 'Runs', exact: true }).getByRole('listitem').filter({ hasText: /^Baseline/ });
	await expect(baseline.getByText('Scenario base', { exact: true })).toHaveCount(0);
	await baseline.getByRole('button', { name: /^Delete run Baseline/ }).click();
	await answerConfirm(page, true);
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
