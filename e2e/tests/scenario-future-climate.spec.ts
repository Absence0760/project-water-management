// Future climate as a scenario change (issue #621 slice 5, docs/scenarios.md
// § Future climate, docs/ui.md § Scenarios): Add a change → Future climate
// says to draw a catchment boundary first; with one, an editor works out the
// change factors (the `climate_factors` job over the committed synthetic
// NEX-GDDP-CMIP6 copy, invented models SYN-A..C, FUTURE_YIELD=on in
// playwright.config.ts), the form follows the job, then picks a model,
// pathway and window, sees that case's 24 factors and adds it as a
// `climate.delta`, a baseline assumption. Once the boundary is drawn again
// the form says the factors were read over the old one.
import { expectNoViolations } from '../support/a11y.ts';
import { createRun, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { runJobsTick } from '../support/jobs.ts';
import { box } from '../support/map.ts';

const NAME = 'Drier late century';

test('an editor works out the change factors, picks a model, pathway and window, and adds it as a future climate', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Scenario future climate');
	const baseRun = await createRun(page.request, project.id, 'Baseline');

	await page.goto(`/projects/${project.id}?tab=scenarios&new=1`);
	const create = page.getByRole('dialog', { name: 'New scenario' });
	await expect(create.getByLabel('Base run')).toHaveValue(baseRun);
	await create.getByLabel('Name', { exact: true }).fill(NAME);
	await create.getByRole('button', { name: 'Create scenario' }).click();
	await expect(page.getByRole('heading', { level: 2, name: NAME })).toBeVisible();

	// No boundary on the map yet: the factors are read over one, so the form says to draw it, and offers no job.
	const form = page.getByRole('form', { name: 'Add a change' });
	await form.getByLabel('Kind of change').selectOption({ label: 'Future climate (monthly change factors)' });
	const climate = form.getByTestId('op-climate');
	await expect(climate.getByTestId('op-climate-boundary')).toContainText('Draw or upload one there first.');
	await expect(climate.getByRole('button', { name: 'Work out the change factors' })).toHaveCount(0);
	// Nothing picked: the form says what is missing.
	await form.getByRole('button', { name: 'Add change' }).click();
	await expect(form.getByRole('alert')).toHaveText('Work the change factors out first');

	// A boundary inside the synthetic copy's invented block.
	const b = await page.request.post(`${API_URL}/projects/${project.id}/map/features`, {
		data: { kind: 'catchment_boundary', name: 'Synthetic catchment', geometry: { type: 'Polygon', coordinates: [box(21.3, -33.7, 0.1)] } }
	});
	expect(b.status(), await b.text()).toBe(201);
	const boundaryId = ((await b.json()) as { feature: { id: string } }).feature.id;
	await page.reload();
	await form.getByLabel('Kind of change').selectOption({ label: 'Future climate (monthly change factors)' });
	await expect(climate).toContainText('haven’t been worked out for this catchment yet');

	// Work them out: the form follows the job, queued, and (the job run here, deterministically) shows the pickers once it is done.
	await climate.getByRole('button', { name: 'Work out the change factors' }).click();
	await expect(climate.getByTestId('op-climate-job')).toContainText('Working out the change factors. Queued: waiting for the background worker.');
	// Cancel ends the waiting job at once (284_cancel_future_jobs): no failure shown, and it can be queued again.
	await climate.getByRole('button', { name: 'Cancel' }).click();
	await expect(climate.getByTestId('op-climate-job')).toHaveCount(0);
	await expect(climate.getByTestId('op-climate-failed')).toHaveCount(0);
	await climate.getByRole('button', { name: 'Work out the change factors' }).click();
	await expect(climate.getByTestId('op-climate-job')).toContainText('Working out the change factors. Queued: waiting for the background worker.');
	await runJobsTick({ projects: [project.id], schedule: false });
	await expect(climate.getByLabel('Climate model')).toBeVisible();
	await expect(climate.getByLabel('Climate model').getByRole('option')).toHaveText(['Pick one', 'SYN-A', 'SYN-B', 'SYN-C']);
	await expect(climate.getByLabel('Pathway').getByRole('option')).toHaveText(['Pick one', 'SSP2-4.5', 'SSP5-8.5']);
	await expect(climate.getByLabel('Window').getByRole('option')).toHaveText(['Pick one', '2036–2065', '2066–2095']);
	await expect(climate.getByTestId('op-climate-source')).toContainText('3 climate models, worked out');
	await expect(climate.getByTestId('op-climate-source')).toContainText('against the 1985–2014 baseline');
	// The synthetic copy holds a year or two of each window: said, not hidden.
	await expect(climate.getByTestId('op-climate-partial')).toContainText('rest on part of their 30-year windows');

	// One case: its factors, rain and evaporation by calendar month, before it is added.
	await climate.getByLabel('Climate model').selectOption('SYN-B');
	await climate.getByLabel('Pathway').selectOption({ label: 'SSP5-8.5' });
	await climate.getByLabel('Window').selectOption({ label: '2066–2095' });
	const factors = climate.getByTestId('op-climate-factors');
	await expect(factors.getByRole('rowheader')).toHaveText(['Rain', 'Evaporation']);
	await expect(factors.getByRole('columnheader')).toHaveCount(13);
	await expect(factors.getByRole('row').nth(2).getByRole('cell')).toHaveCount(12);
	await expectNoViolations(page);

	await form.getByRole('button', { name: 'Add change' }).click();
	const changes = page.getByRole('list', { name: `Changes in ${NAME}` }).getByRole('listitem');
	await expect(changes).toHaveCount(1);
	await expect(changes).toContainText('Future climate, SYN-B SSP5-8.5 2066–2095: rain ×');
	await expect(changes).toContainText('(NEX-GDDP-CMIP6 monthly change factors, method delta-1, baseline 1985–2014)');
	// The climate is never the proposer's to change.
	await expect(changes).toContainText('Baseline assumption');
	await expect(page.getByTestId('baseline-callout')).toContainText('Baseline assumptions changed');

	// The boundary drawn again: the factors were read over the old one, and the form offers to work them out again.
	const moved = await page.request.patch(`${API_URL}/projects/${project.id}/map/features/${boundaryId}`, { data: { geometry: { type: 'Polygon', coordinates: [box(21.35, -33.7, 0.1)] } } });
	expect(moved.status(), await moved.text()).toBe(200);
	await page.reload();
	await form.getByLabel('Kind of change').selectOption({ label: 'Future climate (monthly change factors)' });
	await expect(climate.getByTestId('op-climate-changed')).toContainText('The catchment boundary has changed since these factors were worked out.');
	await expect(climate.getByRole('button', { name: 'Work them out again' })).toBeVisible();
	// The change already added keeps its own factors.
	await expect(changes).toHaveCount(1);
});
