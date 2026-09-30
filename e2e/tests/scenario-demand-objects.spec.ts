// Demand objects through the "Add a change" form (engine ≥ 1.45.0;
// docs/scenarios.md § Op catalogue, docs/ui.md § Scenarios): an editor adds
// a village on Upper farm, sized as people × litres a day, changes its
// share returned and gives it a schedule (the Network form's schedule
// editor), then cuts domestic demand 10 % and the crops 30 % (DWS's %
// restrictions per category, engine 1.45.0); the list reads each change and
// classes it (a baseline assumption until the farm is the proposer's). The
// scenario runs with the village in its model, and the catchment's own model
// is never touched. Synthetic catchment (support/api.ts).
import { expectNoViolations } from '../support/a11y.ts';
import { createRun, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const NAME = 'A village on Upper farm';

test('an editor adds a demand object and changes it through the form, and runs it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Scenario demand objects');
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

	// A village sized as people × litres a day: the count is required.
	await form.getByLabel('Kind of change').selectOption({ label: 'Add a demand object' });
	await form.getByLabel('Hydrological unit').selectOption({ label: 'Upper farm' });
	await form.getByLabel('Name', { exact: true }).fill('Village');
	await form.getByLabel('Category').selectOption({ label: 'Domestic' });
	await form.getByLabel('Demand given as').selectOption({ label: 'a count × litres a day' });
	await form.getByLabel('Litres per unit a day').fill('230');
	await add();
	await expect(form.getByRole('alert')).toHaveText('Enter the count');
	await form.getByLabel('Count (people, head or units)').fill('1200');
	await expectNoViolations(page);
	await add();
	await expect(changes).toHaveCount(1);
	await expect(changes.nth(0)).toContainText(/Upper farm: add the demand object “Village”, Domestic, 1\s200 × 230 l a day/);
	await expect(changes.nth(0)).toContainText('Baseline assumption');

	// Its share returned, typed as %, with what it is now.
	await form.getByLabel('Kind of change').selectOption({ label: 'Change a demand object' });
	await form.getByLabel('Demand object').selectOption({ label: 'Upper farm: Village' });
	await form.getByLabel('Field').selectOption({ label: 'Share returned' });
	await expect(form.getByTestId('op-current')).toHaveText('Now: 0 %');
	await form.getByLabel('Share returned (%)').fill('150');
	await add();
	await expect(form.getByRole('alert')).toHaveText('Must be at most 100 %');
	await form.getByLabel('Share returned (%)').fill('30');
	await add();
	await expect(changes).toHaveCount(2);
	await expect(changes.nth(1)).toContainText('Upper farm, demand object “Village”: Share returned 0 % → 30 %');

	// Its schedule, through the Network form's own schedule editor (weekends off).
	await form.getByLabel('Demand object').selectOption({ label: 'Upper farm: Village' });
	await form.getByLabel('Field').selectOption({ label: 'On/off schedule' });
	const schedule = form.getByTestId('op-schedule');
	await expect(schedule.getByText('Every day at its month’s demand.')).toBeVisible();
	await schedule.getByLabel('Days the new window covers').selectOption('always');
	await schedule.getByRole('button', { name: '+ Add window' }).click();
	await expect(schedule.getByLabel('Window 1')).toHaveValue('Weekends');
	await expectNoViolations(page);
	await add();
	await expect(changes).toHaveCount(3);
	await expect(changes.nth(2)).toContainText('Upper farm, demand object “Village”: On/off schedule none → 1 window (Weekends off)');

	// DWS % restrictions per category: domestic −10 % and the crops −30 % on Upper farm, two changes.
	await form.getByLabel('Kind of change').selectOption({ label: 'Scale demand' });
	await form.getByLabel('Part of their demand').selectOption({ label: 'Domestic demand objects' });
	await form.getByLabel("Demand (% of what they'd take)").fill('90');
	await form.getByTestId('op-demand-nodes').getByLabel('Upper farm').check();
	await add();
	await expect(changes).toHaveCount(4);
	await form.getByLabel('Part of their demand').selectOption({ label: 'Crops (irrigation of the crop areas)' });
	await form.getByLabel("Demand (% of what they'd take)").fill('70');
	await form.getByTestId('op-demand-nodes').getByLabel('Upper farm').check();
	await add();
	await expect(changes).toHaveCount(5);
	await expect(changes.nth(3)).toContainText("Domestic demand objects demand of Upper farm: 90 % of what they'd take (× 0.9)");
	await expect(changes.nth(4)).toContainText("Crops (irrigation of the crop areas) demand of Upper farm: 70 % of what they'd take (× 0.7)");

	// The farm is the proposer's: every change is the proposal.
	await page.getByRole('group', { name: "The proposer's nodes" }).getByLabel('Upper farm').check();
	for (let i = 0; i < 5; i++) await expect(changes.nth(i)).toContainText('Proposal');

	await page.getByRole('button', { name: 'Run scenario' }).click();
	await expect(page.getByRole('region', { name: 'Scenario against its base' }).getByRole('region', { name: 'Headline results' })).toBeVisible();

	// The scenario run's model has the village; the catchment's own model has no demand object.
	const { runs } = (await (await page.request.get(`${API_URL}/projects/${project.id}/runs`)).json()) as { runs: { id: string }[] };
	const scenarioRun = runs.find((r) => r.id !== baseRun)!.id;
	const run = (await (await page.request.get(`${API_URL}/projects/${project.id}/runs/${scenarioRun}`)).json()) as {
		run: { model: { nodes: { id: string; name: string; partDemandFactor?: Record<string, number[]> }[]; demandObjects?: { nodeId: string; name: string; count: number | null; returnPct: number; schedule?: { label: string; factor: number }[] | null }[] } };
	};
	const upper = run.run.model.nodes.find((n) => n.name === 'Upper farm')!.id;
	expect(run.run.model.demandObjects).toEqual([
		expect.objectContaining({ nodeId: upper, name: 'Village', count: 1200, returnPct: 0.3, schedule: [expect.objectContaining({ label: 'Weekends', factor: 0 })] })
	]);
	expect(run.run.model.nodes.find((n) => n.name === 'Upper farm')!.partDemandFactor).toEqual({ domestic: new Array(12).fill(0.9), crops: new Array(12).fill(0.7) });
	const live = (await (await page.request.get(`${API_URL}/projects/${project.id}/model`)).json()) as { demandObjects?: unknown[] };
	expect(live.demandObjects ?? []).toEqual([]);
});
