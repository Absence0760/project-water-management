import { createRun, putSeries, seedRunnableProject, syntheticFlow, syntheticRain } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

test('running the model shows the run with a farm summary and a chart', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Runs');
	await page.goto(`/projects/${project.id}?tab=runs`);
	await expect(page.getByText('No runs yet. Run the model to see results.')).toBeVisible();

	await page.getByLabel(/^Run label/).fill('Baseline');
	await page.getByRole('button', { name: 'Run model' }).click();

	// The run is listed, selected, and its results render.
	const list = page.getByRole('region', { name: 'Runs', exact: true });
	const picked = list.getByRole('button', { name: /^Baseline/ });
	await expect(picked).toHaveAttribute('aria-current', 'true');
	await expect(picked).toContainText('2021-10-01 → 2022-01-28');
	await expect(page).toHaveURL(/[?&]run=[0-9a-f-]{36}/);
	await expect(page.getByRole('heading', { level: 2, name: 'Baseline' })).toBeVisible();

	const summary = page.getByRole('region', { name: 'Run summary' });
	await expect(summary.getByRole('heading', { name: 'Farms' })).toBeVisible();
	const farms = summary.getByRole('table');
	await expect(farms.getByRole('rowheader', { name: /^Upper farm/ })).toBeVisible();
	await expect(farms.getByRole('rowheader', { name: /^Lower farm/ })).toBeVisible();
	await expect(farms.getByRole('rowheader', { name: 'All farms' })).toBeVisible();
	const calibration = page.getByRole('region', { name: 'Calibration against observed flow' });
	await expect(calibration.getByRole('term').filter({ hasText: 'Observations' })).toBeVisible();
	// A gauge record is scored against the simulated outflow, not natural flow.
	await expect(calibration.getByRole('definition').filter({ hasText: 'Simulated outflow at the outlet' })).toBeVisible();
	// The headline fit scores are labelled as in-sample (issue #4).
	await expect(calibration.getByText('Calibration period (in-sample).', { exact: true })).toBeVisible();
	await expect(summary.getByText('calibration period (in-sample)')).toHaveCount(2);

	// The outlet EWR test on the observed record: the 2×2 table, the scores and a per-month breakdown.
	const agreement = page.getByRole('region', { name: 'EWR test: model against observed flow' });
	const matrix = agreement.getByRole('table', { name: 'Observed days by EWR result, model against observed' });
	await expect(matrix.getByRole('rowheader', { name: 'Model below EWR' })).toBeVisible();
	await expect(matrix.getByRole('columnheader', { name: 'Observed below EWR' })).toBeVisible();
	// 120 observed days, every one inside the run.
	await expect(matrix.getByRole('row', { name: /^Total/ }).getByRole('cell').last()).toHaveText('120');
	await expect(agreement.getByRole('term').filter({ hasText: 'Frequency bias' })).toBeVisible();
	const months = agreement.getByRole('table', { name: /by month$/ });
	await expect(months.getByRole('rowheader')).toHaveText(['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']);
	await expect(months.getByRole('row', { name: /^Oct/ }).getByRole('cell').first()).toHaveText('31');

	const chart = page.getByRole('img', { name: /^Catchment · .*: line chart/ });
	await expect(chart.locator('canvas')).toBeVisible();

	// A farm's own series can be charted too.
	await page.getByLabel('Node', { exact: true }).selectOption({ label: 'Upper farm' });
	await expect(page.getByRole('img', { name: /^Upper farm · .*: line chart/ }).locator('canvas')).toBeVisible();

	// The run is stored: a reload shows it again, newest first.
	await page.reload();
	await expect(list.getByRole('button', { name: /^Baseline/ })).toHaveAttribute('aria-current', 'true');
	await expect(summary.getByRole('rowheader', { name: /^Upper farm/ })).toBeVisible();
});

// Regression: a chart effect that re-triggered itself froze the Runs tab
// (thousands of rebuilds a second). With decades of daily data every chart
// must render and the page must stay responsive.
test('the results dashboard renders long records without locking the page', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Runs long record');
	const days = 20 * 365;
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2001-10-01', values: syntheticRain(days) });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2001-10-01', values: syntheticFlow(days) });
	await createRun(page.request, project.id, 'Long');
	await page.goto(`/projects/${project.id}?tab=runs`);

	for (const name of [/^Flow at the outflow gauge/, /^Flow-duration curve/, /^EWR vs simulated outflow/, /^Catchment · /]) {
		await expect(page.getByRole('img', { name }).locator('canvas')).toBeVisible();
	}
	// The main thread answers promptly once the charts are up, and again a moment later.
	for (let i = 0; i < 2; i++) {
		const t0 = Date.now();
		await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
		expect(Date.now() - t0).toBeLessThan(2_000);
	}
});

test('the results menu jumps to each section below the sticky header', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Results menu');
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}?tab=runs`);
	const menu = page.getByRole('navigation', { name: 'Result sections' });
	await expect(menu.getByRole('link')).toHaveText([
		'Summary',
		'Curtailment',
		'Hydrograph',
		'Calibration',
		'Runoff model',
		'Flow duration',
		'EWR vs outflow',
		'EWR by month',
		'EWR vs observed',
		'Farm detail',
		'Explore outputs'
	]);

	await menu.getByRole('link', { name: 'Farm detail' }).click();
	await expect(page).toHaveURL(/[?&]run=[0-9a-f-]{36}#res-farm$/);
	const farm = page.getByRole('region', { name: 'Farm detail' });
	await expect(farm).toBeInViewport();
	// The section's top edge clears the sticky app header.
	const header = await page.getByRole('banner').boundingBox();
	const top = await farm.boundingBox();
	expect(top!.y).toBeGreaterThanOrEqual(header!.y + header!.height);

	await menu.getByRole('link', { name: 'Explore outputs' }).click();
	await expect(page.getByRole('region', { name: 'Explore any output' })).toBeInViewport();
	await expect(page).toHaveURL(/#res-explore$/);
});

test('a run past the cap drops the oldest run from the list straight away', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Runs cap');
	// RUNS_KEPT_PER_PROJECT is 20 (backend/.env.development).
	for (let i = 1; i <= 20; i++) await createRun(page.request, project.id, `Old ${String(i).padStart(2, '0')}`);
	await page.goto(`/projects/${project.id}?tab=runs`);
	const list = page.getByRole('region', { name: 'Runs', exact: true });
	await expect(list.getByRole('button', { name: /^Old 01/ })).toBeVisible();

	await page.getByLabel(/^Run label/).fill('Newest');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(list.getByRole('button', { name: /^Newest/ })).toHaveAttribute('aria-current', 'true');
	await expect(list.getByRole('button', { name: /^Old 01/ })).toHaveCount(0);
	await expect(list.getByRole('button', { name: /^Old 02/ })).toBeVisible();
});
