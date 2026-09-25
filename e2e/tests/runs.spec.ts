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
		'Where the water went',
		'Self-checks',
		'Curtailment',
		'Hydrograph',
		'Calibration',
		'Runoff model',
		'Run notes',
		'Flow duration',
		'EWR vs outflow',
		'EWR by month',
		'EWR vs observed',
		'Farm detail',
		'Explore outputs'
	]);

	// The menu sits in the rail beside the results and stays in view as the page scrolls,
	// marking the section being read.
	await expect(menu.getByRole('link', { name: 'Summary' })).toHaveAttribute('aria-current', 'location');
	await menu.getByRole('link', { name: 'Hydrograph' }).click();
	await expect(page.getByRole('img', { name: /^Flow at the outflow gauge/ })).toBeInViewport();
	await expect(menu).toBeInViewport();
	await expect(menu.getByRole('link', { name: 'Hydrograph' })).toHaveAttribute('aria-current', 'location');
	await expect(menu.getByRole('link', { name: 'Summary' })).not.toHaveAttribute('aria-current', 'location');

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

test('with a long runs list the whole results menu stays in view on a laptop screen', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Runs rail');
	// RUNS_KEPT_PER_PROJECT is 20, the most a project can hold.
	for (let i = 1; i <= 20; i++) await createRun(page.request, project.id, `Run ${String(i).padStart(2, '0')}`);
	await page.setViewportSize({ width: 1280, height: 768 });
	await page.goto(`/projects/${project.id}?tab=runs`);

	const menu = page.getByRole('navigation', { name: 'Result sections' });
	await expect(menu.getByRole('link', { name: 'Explore outputs' })).toBeVisible();
	// The list scrolls inside its own panel rather than pushing the menu down.
	const runs = page.getByRole('region', { name: 'Runs', exact: true }).getByRole('list');
	expect(await runs.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
	await expect(menu.getByRole('link', { name: 'Summary' })).toBeInViewport({ ratio: 1 });

	// Once the rail is stuck under the header, the list and every menu link fit on screen.
	await menu.getByRole('link', { name: 'EWR by month' }).click();
	await expect(page.getByRole('region', { name: 'Runs', exact: true })).toBeInViewport();
	// The rail needs no scrollbar of its own: nothing in it is clipped (a fixed 16rem list overflowed by 17px here).
	const rail = page.getByRole('complementary');
	await expect.poll(() => rail.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(0);
	for (const name of ['Summary', 'Explore outputs']) await expect(menu.getByRole('link', { name })).toBeInViewport({ ratio: 1 });
});

test('a run tells where its water went on the catchment picture', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Where the water went');
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByRole('navigation', { name: 'Result sections' }).getByRole('link', { name: 'Where the water went' }).click();
	const panel = page.getByRole('region', { name: 'Where the water went' });
	await expect(panel).toBeInViewport();
	await expect(panel.getByRole('img', { name: /An illustrated catchment/ })).toBeVisible();

	// Eight stops, rain to outlet, each with this run's figure or why there is none.
	const stops = panel.getByRole('listitem').filter({ has: page.getByRole('heading', { level: 3 }) });
	await expect(stops).toHaveCount(8);
	await expect(stops.nth(0)).toContainText(/Rain on the catchment\s*[\d.,]+ Mm³ a year\./);
	await expect(stops.nth(2)).toContainText(/Natural flow\s*[\d.,]+ Mm³ a year\./);
	await expect(stops.nth(5)).toContainText('add up to nothing');
	await expect(stops.nth(7)).toContainText(/Outflow at the outlet\s*[\d.,]+ Mm³ a year\.\s*\d+% of the natural flow reached the outlet/);
});

test('an editor writes a run note that is still there after a reload, with who changed it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Run notes');
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}?tab=runs`);

	const notes = page.getByRole('region', { name: 'Run notes' });
	const box = notes.getByRole('textbox', { name: 'Run notes' });
	const save = notes.getByRole('button', { name: 'Save notes' });
	await expect(save).toBeDisabled();
	await box.fill('  The quaternary includes an irrigated tributary outside the model.  ');
	await save.click();
	await expect(notes.getByRole('status')).toHaveText('Saved.');
	await expect(save).toBeDisabled();

	await page.reload();
	await expect(box).toHaveValue('The quaternary includes an irrigated tributary outside the model.');
	await expect(notes).toContainText(/Last changed \d{4}-\d\d-\d\d \d\d:\d\d by Owner/);
});
