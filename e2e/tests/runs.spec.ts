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
