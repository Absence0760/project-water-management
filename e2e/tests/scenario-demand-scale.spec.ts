// The "Scale demand" change (issue #53 R1, docs/scenarios.md § Demand
// scaling, docs/ui.md § Scenarios): an editor scales one farm's irrigation
// demand to 50 % in two months through the "Add a change" form, sees how the
// list reads and classifies it (a baseline assumption until the farm is the
// proposer's), runs the scenario, and the comparison with its base shows the
// farm's demand cut by exactly the scaled months, the other farm's unchanged.
// The daily demand of the scenario run is the base's × 0.5 in those months
// and the base's everywhere else. A second test limits the scaling to dates
// (engine 1.82.0, issue #514) together with months. Synthetic catchment (support/api.ts).
import type { APIRequestContext, Locator } from '@playwright/test';
import { createRun, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { ungroup } from '../support/format.ts';

const NAME = 'Upper farm takes half';
const SCALE = "Irrigation demand of Upper farm: 50 % of what they'd take (× 0.5), in Jan, Dec";

async function getJson<T>(request: APIRequestContext, path: string): Promise<T> {
	const res = await request.get(`${API_URL}${path}`);
	expect(res.status()).toBe(200);
	return (await res.json()) as T;
}

/** A farm's daily abstraction demand D (the `demand` series) in a run. */
async function dailyDemand(request: APIRequestContext, projectId: string, runId: string, nodeId: string) {
	return getJson<{ startDate: string; values: number[] }>(request, `/projects/${projectId}/runs/${runId}/series?key=demand&nodeId=${nodeId}`);
}

/** The farm table's Demand cell for one farm: run B's value and its change from A, as shown. */
async function demandCell(table: Locator, farm: string): Promise<{ value: number; delta: string }> {
	const cell = table.getByRole('row', { name: new RegExp(`^${farm}`) }).getByRole('cell').first();
	const value = ungroup(await cell.locator('.val').innerText());
	const delta = (await cell.locator('.delta').getAttribute('title')) ?? '';
	return { value, delta };
}

test('an editor scales one farm’s demand to 50 % in two months, runs it, and the comparison shows only those months cut', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Scenario scale demand');
	const baseRun = await createRun(page.request, project.id, 'Baseline');
	const nodes = project.model.nodes as { id: string; name: string }[];
	const upper = nodes.find((n) => n.name === 'Upper farm')!.id;
	const lower = nodes.find((n) => n.name === 'Lower farm')!.id;

	await page.goto(`/projects/${project.id}?tab=scenarios&new=1`);
	const create = page.getByRole('dialog', { name: 'New scenario' });
	await expect(create.getByLabel('Base run')).toHaveValue(baseRun);
	await create.getByLabel('Name', { exact: true }).fill(NAME);
	await create.getByRole('button', { name: 'Create scenario' }).click();
	await expect(page.getByRole('heading', { level: 2, name: NAME })).toBeVisible();

	// The form: farms by default, every farm of the model listed, months Oct first.
	const form = page.getByRole('form', { name: 'Add a change' });
	await form.getByLabel('Kind of change').selectOption({ label: 'Scale demand' });
	await expect(form.getByLabel('Whose demand')).toHaveValue('farm');
	const farms = form.getByRole('group', { name: 'Hydrological units (none ticked: all of them)' });
	await expect(farms.getByRole('checkbox')).toHaveCount(2);
	await expect(farms).toHaveText(/^Hydrological units \(none ticked: all of them\)\s*Upper farm\s*Lower farm$/);
	const months = form.getByRole('group', { name: 'Months (none ticked: every month)' });
	await expect(months.getByRole('checkbox')).toHaveCount(12);
	await expect(months.locator('label').first()).toHaveText('Oct');

	// Out of range is refused in the form, in its own units.
	await form.getByLabel("Demand (% of what they'd take)").fill('250');
	await form.getByRole('button', { name: 'Add change' }).click();
	await expect(form.getByRole('alert')).toHaveText("The demand must be between 0 % and 200 % of what they'd take");

	// Upper farm at 50 % in December and January.
	await form.getByLabel("Demand (% of what they'd take)").fill('50');
	await farms.getByLabel('Upper farm').check();
	await months.getByLabel('Dec').check();
	await months.getByLabel('Jan').check();
	await form.getByRole('button', { name: 'Add change' }).click();
	const changes = page.getByRole('list', { name: `Changes in ${NAME}` }).getByRole('listitem');
	await expect(changes).toHaveCount(1);
	await expect(changes).toContainText(SCALE);

	// A named farm that isn't the proposer's is another party's: a baseline assumption until it is.
	await expect(changes).toContainText('Baseline assumption');
	await expect(page.getByTestId('baseline-callout')).toContainText('Baseline assumptions changed');
	await page.getByRole('group', { name: "The proposer's hydrological units" }).getByLabel('Upper farm').check();
	await expect(changes).toContainText('Proposal');
	await expect(page.getByTestId('baseline-callout')).toHaveCount(0);

	// Saved: the change is still there after a reload.
	await page.reload();
	await expect(changes).toHaveCount(1);
	await expect(changes).toContainText(SCALE);

	await page.getByRole('button', { name: 'Run scenario' }).click();
	const compare = page.getByRole('region', { name: 'Scenario against its base' });
	const table = compare.getByRole('region', { name: 'Hydrological units' }).getByRole('table', { name: 'Change per hydrological unit, run B minus run A' });
	await expect(table).toBeVisible();

	// The stored runs: the scenario's daily demand is the base's × 0.5 in Dec and Jan, the base's on every other day.
	const { runs } = await getJson<{ runs: { id: string }[] }>(page.request, `/projects/${project.id}/runs`);
	const scenarioRun = runs.find((r) => r.id !== baseRun)!.id;
	const [baseUpper, scUpper, baseLower, scLower] = await Promise.all([
		dailyDemand(page.request, project.id, baseRun, upper),
		dailyDemand(page.request, project.id, scenarioRun, upper),
		dailyDemand(page.request, project.id, baseRun, lower),
		dailyDemand(page.request, project.id, scenarioRun, lower)
	]);
	expect(scUpper.startDate).toBe(baseUpper.startDate);
	expect(scUpper.values).toHaveLength(baseUpper.values.length);
	const start = Date.parse(`${baseUpper.startDate}T00:00:00Z`);
	const monthOf = (i: number) => new Date(start + i * 86_400_000).getUTCMonth() + 1;
	let scaledDays = 0;
	baseUpper.values.forEach((v, i) => {
		const scaled = monthOf(i) === 12 || monthOf(i) === 1;
		if (scaled) scaledDays += 1;
		expect(scUpper.values[i]).toBeCloseTo(scaled ? v * 0.5 : v, 9);
	});
	expect(scaledDays).toBe(59); // 31 December days + 28 January days of the synthetic record (to 2022-01-28)
	expect(baseUpper.values.some((v, i) => (monthOf(i) === 12 || monthOf(i) === 1) && v > 1)).toBe(true);
	expect(scLower.values).toEqual(baseLower.values);

	// What the table shows: Upper farm's demand down to the scenario run's mean, Lower farm's unchanged.
	const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
	const up = await demandCell(table, 'Upper farm');
	expect(Math.abs(up.value - mean(scUpper.values))).toBeLessThanOrEqual(0.5);
	expect(up.value).toBeLessThan(mean(baseUpper.values) - 1);
	expect(up.delta).toMatch(/^down [\d\u202f]+$/);
	const low = await demandCell(table, 'Lower farm');
	expect(Math.abs(low.value - mean(baseLower.values))).toBeLessThanOrEqual(0.5);
	expect(low.delta).toBe('no change');
});

// Dates (engine 1.82.0, issue #514): the dry-year stress's one change per drought year. With months ticked
// too, only the days in both are scaled: here 20 Dec 2021 – 10 Jan 2022 in December and January.
test('an editor limits a demand scaling to dates, with months, and the run scales exactly the days in both', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Scenario scale demand by date');
	const baseRun = await createRun(page.request, project.id, 'Baseline');
	const nodes = project.model.nodes as { id: string; name: string }[];
	const upper = nodes.find((n) => n.name === 'Upper farm')!.id;
	const name = 'Upper farm dry spell';

	await page.goto(`/projects/${project.id}?tab=scenarios&new=1`);
	const create = page.getByRole('dialog', { name: 'New scenario' });
	await expect(create.getByLabel('Base run')).toHaveValue(baseRun);
	await create.getByLabel('Name', { exact: true }).fill(name);
	await create.getByRole('button', { name: 'Create scenario' }).click();
	await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();

	const form = page.getByRole('form', { name: 'Add a change' });
	await form.getByLabel('Kind of change').selectOption({ label: 'Scale demand' });
	await form.getByLabel("Demand (% of what they'd take)").fill('150');
	await form.getByRole('group', { name: 'Hydrological units (none ticked: all of them)' }).getByLabel('Upper farm').check();
	const months = form.getByRole('group', { name: 'Months (none ticked: every month)' });
	await months.getByLabel('Dec').check();
	await months.getByLabel('Jan').check();
	// A date that doesn't exist is refused, as Scale rainfall's are.
	await form.getByLabel('From (YYYY-MM-DD)').fill('2021-12-32');
	await form.getByRole('button', { name: 'Add change' }).click();
	await expect(form.getByRole('alert')).toHaveText('From: must be an ISO date (YYYY-MM-DD)');
	await form.getByLabel('From (YYYY-MM-DD)').fill('2021-12-20');
	await form.getByLabel('To (YYYY-MM-DD)').fill('2022-01-10');
	await form.getByRole('button', { name: 'Add change' }).click();
	const changes = page.getByRole('list', { name: `Changes in ${name}` }).getByRole('listitem');
	await expect(changes).toHaveCount(1);
	await expect(changes).toContainText("Irrigation demand of Upper farm: 150 % of what they'd take (× 1.5), in Jan, Dec, 2021-12-20 to 2022-01-10");

	await page.getByRole('button', { name: 'Run scenario' }).click();
	await expect(page.getByRole('region', { name: 'Scenario against its base' }).getByRole('region', { name: 'Hydrological units' })).toBeVisible();

	const { runs } = await getJson<{ runs: { id: string }[] }>(page.request, `/projects/${project.id}/runs`);
	const scenarioRun = runs.find((r) => r.id !== baseRun)!.id;
	const [base, scenario] = await Promise.all([dailyDemand(page.request, project.id, baseRun, upper), dailyDemand(page.request, project.id, scenarioRun, upper)]);
	expect(scenario.startDate).toBe(base.startDate);
	const start = Date.parse(`${base.startDate}T00:00:00Z`);
	const [from, to] = [Date.parse('2021-12-20T00:00:00Z'), Date.parse('2022-01-10T00:00:00Z')];
	let scaledDays = 0;
	base.values.forEach((v, i) => {
		const day = start + i * 86_400_000;
		const scaled = day >= from && day <= to;
		if (scaled) scaledDays += 1;
		expect(scenario.values[i]).toBeCloseTo(scaled ? v * 1.5 : v, 9);
	});
	expect(scaledDays).toBe(22); // 12 December days + 10 January days
	expect(base.values.some((v, i) => start + i * 86_400_000 >= from && start + i * 86_400_000 <= to && v > 1)).toBe(true);
});
