// The later scenario ops through the "Add a change" form (engine ≥ 1.34.0,
// issue #73; docs/scenarios.md § Op catalogue, docs/ui.md § Scenarios): an
// editor moves a farm to drain into another, inserts a new dam on the reach
// above the outflow gauge, changes a crop's own irrigation efficiency and
// asks for a registered volume on a farm. The list reads each one and
// classes it (a move of another party's farm and a crop's efficiency are
// baseline assumptions; the new dam is the proposal, and so is the volume
// once the farm is the proposer's); the scenario runs, and the catchment's
// own model is never touched. Synthetic catchment (support/api.ts).
import { expectNoViolations } from '../support/a11y.ts';
import { createRun, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const NAME = 'A weir dam and a licence';

test('an editor moves and inserts nodes, changes a crop and sets a registered volume through the form, and runs it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Scenario later ops');
	const baseRun = await createRun(page.request, project.id, 'Baseline');

	await page.goto(`/projects/${project.id}?tab=scenarios&new=1`);
	const create = page.getByRole('dialog', { name: 'New scenario' });
	await expect(create.getByLabel('Base run')).toHaveValue(baseRun);
	await create.getByLabel('Name', { exact: true }).fill(NAME);
	await create.getByRole('button', { name: 'Create scenario' }).click();
	await expect(page.getByRole('heading', { level: 2, name: NAME })).toBeVisible();

	const form = page.getByRole('form', { name: 'Add a change' });
	const changes = page.getByRole('list', { name: `Changes in ${NAME}` }).getByRole('listitem');
	const add = () => form.getByRole('button', { name: 'Add change' }).click();

	// Move Lower farm to drain into Upper farm: "Now" says where it drains.
	await form.getByLabel('Kind of change').selectOption({ label: 'Move a node (what it drains into)' });
	await form.getByLabel('Node', { exact: true }).selectOption({ label: 'Lower farm' });
	await expect(form.getByTestId('op-current')).toHaveText('Now: drains into Outflow gauge');
	await add();
	await expect(form.getByRole('alert')).toHaveText('Pick what it will drain into');
	await form.getByLabel('Drains into').selectOption({ label: 'Upper farm' });
	await add();
	await expect(changes).toHaveCount(1);
	await expect(changes.nth(0)).toContainText('Move “Lower farm”: drains into Outflow gauge → Upper farm');
	await expect(changes.nth(0)).toContainText('Baseline assumption');

	// Insert a dam above the gauge: Upper farm (with Lower farm behind it now) drains into it.
	await form.getByLabel('Kind of change').selectOption({ label: 'Insert a node on a reach' });
	await form.getByLabel('Name', { exact: true }).fill('Weir dam');
	await form.getByLabel('Drains into').selectOption({ label: 'Outflow gauge' });
	const ups = form.getByRole('group', { name: /^What drains into it/ });
	await expect(ups.getByRole('checkbox')).toHaveCount(1);
	await ups.getByLabel('Upper farm').check();
	await form.getByLabel('Dam capacity (m³)').fill('50000');
	await expectNoViolations(page);
	await add();
	await expect(changes).toHaveCount(2);
	await expect(changes.nth(1)).toContainText(/Insert the hydrological unit “Weir dam” above Outflow gauge, taking what Upper farm drains, dam 50\s000 m³/);
	await expect(changes.nth(1)).toContainText('Proposal');

	// A crop's own irrigation efficiency: it applies on every farm growing it, so a baseline assumption.
	await form.getByLabel('Kind of change').selectOption({ label: 'Change a crop' });
	await form.getByLabel('Crop', { exact: true }).selectOption({ label: 'Orchard' });
	await form.getByLabel('Field').selectOption({ label: 'Irrigation efficiency' });
	await form.getByLabel('Irrigation efficiency (%)').fill('90');
	await add();
	await expect(changes).toHaveCount(3);
	await expect(changes.nth(2)).toContainText("Crop Orchard: Irrigation efficiency the hydrological unit's → 90 %");
	await expect(changes.nth(2)).toContainText('Baseline assumption');

	// A new registered volume on Upper farm: the proposal once the farm is the proposer's.
	await form.getByLabel('Kind of change').selectOption({ label: 'Set a registered volume' });
	await form.getByLabel('Registered volume').selectOption({ label: 'A new registered volume' });
	await form.getByLabel('Hydrological unit or user').selectOption({ label: 'Upper farm' });
	await form.getByLabel('Volume (m³ a year)').fill('-5');
	await add();
	await expect(form.getByRole('alert')).toHaveText('The volume must be a number of m³ from 0 to below 10¹²');
	await form.getByLabel('Volume (m³ a year)').fill('100000');
	await add();
	await expect(changes).toHaveCount(4);
	await expect(changes.nth(3)).toContainText(/Upper farm: add a registered volume, surface 100\s000 m³\/a/);
	await expect(changes.nth(3)).toContainText('Baseline assumption');
	await page.getByRole('group', { name: "The proposer's nodes" }).getByLabel('Upper farm').check();
	await expect(changes.nth(3)).toContainText('Proposal');

	// Kept over a reload, then run.
	await page.reload();
	await expect(changes).toHaveCount(4);
	await page.getByRole('button', { name: 'Run scenario' }).click();
	await expect(page.getByRole('region', { name: 'Scenario against its base' }).getByRole('region', { name: 'Headline results' })).toBeVisible();

	// The scenario run's model has the weir dam on the reach; the catchment's own model is unchanged.
	const { runs } = (await (await page.request.get(`${API_URL}/projects/${project.id}/runs`)).json()) as { runs: { id: string }[] };
	const scenarioRun = runs.find((r) => r.id !== baseRun)!.id;
	const run = (await (await page.request.get(`${API_URL}/projects/${project.id}/runs/${scenarioRun}`)).json()) as {
		run: { model: { nodes: { id: string; name: string; downstreamNodeId: string | null }[]; allocations?: { volumeM3PerYear: number }[] } };
	};
	const nodes = run.run.model.nodes;
	const byName = (n: string) => nodes.find((x) => x.name === n)!;
	expect(byName('Upper farm').downstreamNodeId).toBe(byName('Weir dam').id);
	expect(byName('Lower farm').downstreamNodeId).toBe(byName('Upper farm').id);
	expect(byName('Weir dam').downstreamNodeId).toBe(byName('Outflow gauge').id);
	expect(run.run.model.allocations?.map((a) => a.volumeM3PerYear)).toEqual([100_000]);
	const live = (await (await page.request.get(`${API_URL}/projects/${project.id}/model`)).json()) as { nodes: { name: string }[] };
	expect(live.nodes.map((n) => n.name).sort()).toEqual(['Lower farm', 'Outflow gauge', 'Upper farm']);
});
