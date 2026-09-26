import { createRun, putModel, putSeries, seedRunnableProject, syntheticFlow, syntheticRain, updateSettings } from '../support/api.ts';
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
	// A compact row: when it ran and the years; the full period is in the results header.
	await expect(picked).toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} · 2021–2022/);
	await expect(picked).toContainText('latest');
	await expect(page.locator('#res-h').locator('..')).toContainText('2021-10-01 → 2022-01-28');
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

test('the hydrograph starts with natural flow hidden and keeps a legend toggle across a rebuild', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Hydrograph legend');
	const days = 2 * 365;
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2001-10-01', values: syntheticRain(days) });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2001-10-01', values: syntheticFlow(days) });
	await createRun(page.request, project.id, 'Legend');
	await page.goto(`/projects/${project.id}?tab=runs`);

	const chart = page.locator('figure', { has: page.getByRole('img', { name: /^Flow at the outflow gauge/ }) });
	await expect(chart.locator('canvas')).toBeVisible();
	const entry = (name: RegExp) => chart.locator('.u-legend tr.u-series', { has: page.locator('.u-label', { hasText: name }) });
	await expect(entry(/^Natural/)).toHaveClass(/u-off/);
	await expect(entry(/^Observed/)).not.toHaveClass(/u-off/);
	await expect(entry(/^Simulated outflow/)).not.toHaveClass(/u-off/);

	await entry(/^Natural/).click();
	await expect(entry(/^Natural/)).not.toHaveClass(/u-off/);
	// Log scale rebuilds the chart; the user's choice survives it.
	await chart.getByRole('button', { name: 'Log scale' }).click();
	await expect(chart.getByRole('button', { name: 'Log scale' })).toHaveAttribute('aria-pressed', 'true');
	await expect(entry(/^Natural/)).not.toHaveClass(/u-off/);
});

test('the hydrograph view moves through the record by Shift+drag and by Earlier / Later, and a plain drag still zooms', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Hydrograph pan');
	const days = 8 * 365;
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2001-10-01', values: syntheticRain(days) });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2001-10-01', values: syntheticFlow(days) });
	await createRun(page.request, project.id, 'Pan');
	await page.goto(`/projects/${project.id}?tab=runs`);

	const chart = page.locator('figure', { has: page.getByRole('img', { name: /^Flow at the outflow gauge/ }) });
	await expect(chart.locator('canvas')).toBeVisible();
	const earlier = chart.getByRole('button', { name: /Earlier/ });
	const later = chart.getByRole('button', { name: /Later/ });
	const range = async () => ({ start: (await chart.getAttribute('data-view-start'))!, end: (await chart.getAttribute('data-view-end'))! });
	const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

	// Opens on the last 3 years, at the end of the record: nothing later.
	const opened = await range();
	expect(daysBetween(opened.start, opened.end)).toBeCloseTo(3 * 365, -1);
	await expect(later).toBeDisabled();
	await expect(earlier).toBeEnabled();

	// Earlier moves half a window back, keeping the width; Later comes back.
	await earlier.click();
	await expect(chart).not.toHaveAttribute('data-view-end', opened.end);
	const back = await range();
	expect(daysBetween(back.end, opened.end)).toBeCloseTo(1.5 * 365, -1);
	expect(daysBetween(back.start, back.end)).toBeCloseTo(daysBetween(opened.start, opened.end), 0);
	await later.click();
	await expect(chart).toHaveAttribute('data-view-end', opened.end);

	// Shift+dragging right pulls earlier data into view.
	const over = chart.locator('.u-over');
	const box = (await over.boundingBox())!;
	const y = box.y + box.height / 2;
	await page.keyboard.down('Shift');
	await page.mouse.move(box.x + box.width * 0.3, y);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width * 0.7, y, { steps: 5 });
	await page.mouse.up();
	await page.keyboard.up('Shift');
	await expect(chart).not.toHaveAttribute('data-view-end', opened.end);
	const dragged = await range();
	expect(daysBetween(dragged.end, opened.end)).toBeGreaterThan(300);
	expect(daysBetween(dragged.start, dragged.end)).toBeCloseTo(daysBetween(opened.start, opened.end), 0);

	// The view survives a rebuild (log scale).
	await chart.getByRole('button', { name: 'Log scale' }).click();
	await expect(chart.getByRole('button', { name: 'Log scale' })).toHaveAttribute('aria-pressed', 'true');
	await expect(chart).toHaveAttribute('data-view-end', dragged.end);

	// A plain drag still draws a box and zooms into it.
	await page.mouse.move(box.x + box.width * 0.4, y);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width * 0.6, y, { steps: 5 });
	await page.mouse.up();
	await expect.poll(async () => { const r = await range(); return daysBetween(r.start, r.end); }).toBeLessThan(daysBetween(dragged.start, dragged.end) / 2);
});

test('every daily results chart moves through the record like the hydrograph, and the flow charts share the m³/s ↔ m³/day switch', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Chart parity');
	const days = 8 * 365;
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2001-10-01', values: syntheticRain(days) });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2001-10-01', values: syntheticFlow(days) });
	await createRun(page.request, project.id, 'Parity');
	await page.goto(`/projects/${project.id}?tab=runs`);

	const figure = (title: RegExp) => page.locator('figure', { has: page.getByRole('img', { name: title }) });
	const hydro = figure(/^Flow at the outflow gauge/);
	const ewr = figure(/^EWR vs simulated outflow/);
	const fdc = figure(/^Flow-duration curve/);
	const explore = page.locator('#res-explore figure');
	const farmSupply = figure(/^Supply vs demand/);

	// Earlier / Later on every windowed daily chart, not just the hydrograph.
	for (const chart of [ewr, explore, farmSupply]) {
		await expect(chart.locator('canvas')).toBeVisible();
		const end = await chart.getAttribute('data-view-end');
		await expect(chart.getByRole('button', { name: /Later/ })).toBeDisabled();
		await chart.getByRole('button', { name: /Earlier/ }).click();
		await expect(chart).not.toHaveAttribute('data-view-end', end!);
		await chart.getByRole('button', { name: /Later/ }).click();
		await expect(chart).toHaveAttribute('data-view-end', end!);
	}
	// The flow-duration curve has no dates to move through.
	await expect(fdc.getByRole('button', { name: /Earlier/ })).toHaveCount(0);

	// The unit switch sits on each flow chart and drives them all.
	for (const chart of [hydro, ewr, fdc, explore]) await expect(chart.getByRole('button', { name: 'm³/s' })).toHaveAttribute('aria-pressed', 'true');
	await ewr.getByRole('button', { name: 'm³/day' }).click();
	for (const chart of [hydro, ewr, fdc, explore]) {
		await expect(chart.getByRole('button', { name: 'm³/day' })).toHaveAttribute('aria-pressed', 'true');
		await expect(chart.locator('.u-legend')).toContainText('(m³/day)');
	}
	// A chart that isn't a flow has no flow-unit switch.
	await expect(farmSupply.getByRole('button', { name: 'm³/s' })).toHaveCount(0);
});

test('the results menu jumps to each section below the sticky header', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Results menu');
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}?tab=runs`);
	const menu = page.getByRole('navigation', { name: 'Result sections' });
	await expect(menu.getByRole('link')).toHaveText([
		'Summary',
		'Notes & evidence',
		'Publication',
		'EWR & flow duration',
		'EWR by month',
		'Curtailment',
		'Farm detail',
		'Hydrograph',
		'Calibration & uncertainty',
		'Runoff model',
		'EWR vs observed',
		'Plausibility checks',
		'Self-checks',
		'Explore outputs'
	]);
	// The panels are grouped by the question they answer, in the menu and on the page alike.
	const groups = ['River & Reserve', 'Farms & users', 'Model quality', 'Dig deeper'];
	await expect(page.getByRole('heading', { level: 2 }).filter({ hasText: /^(River & Reserve|Farms & users|Model quality|Dig deeper)$/ })).toHaveText(groups);
	await expect(menu.getByRole('list', { name: 'River & Reserve' }).getByRole('link')).toHaveText(['EWR & flow duration', 'EWR by month']);
	await expect(menu.getByRole('list', { name: 'Dig deeper' }).getByRole('link')).toHaveText(['Self-checks', 'Explore outputs']);

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
	// RUNS_KEPT_PER_PROJECT is 20 (backend/.env.development). Old 01 first, so it is the oldest;
	// the other 19 together (one API process serves the whole local suite, see the next test).
	await createRun(page.request, project.id, 'Old 01');
	await Promise.all(Array.from({ length: 19 }, (_, i) => createRun(page.request, project.id, `Old ${String(i + 2).padStart(2, '0')}`)));
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
	// RUNS_KEPT_PER_PROJECT is 20, the most a project can hold. Sent together: the full local
	// suite shares one API process, and 20 requests awaited one by one each queue behind the other
	// workers' heavy runs (this setup alone reached the 30 s test timeout). Nothing here needs an order.
	await Promise.all(Array.from({ length: 20 }, (_, i) => createRun(page.request, project.id, `Run ${String(i + 1).padStart(2, '0')}`)));
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

	// A long list gets a filter over the labels.
	const filter = page.getByRole('searchbox', { name: 'Filter runs by label' });
	await filter.fill('RUN 07');
	await expect(runs.getByRole('listitem')).toHaveCount(1);
	await expect(runs.getByRole('button', { name: /^Run 07/ })).toBeVisible();
	await expect(page.getByRole('status').filter({ hasText: 'of 20 runs' })).toHaveText('1 of 20 runs');
	await filter.fill('nothing like this');
	await expect(runs.getByRole('listitem')).toHaveCount(0);
	await expect(page.getByText('No run label matches.')).toBeVisible();
	await filter.fill('');
	await expect(runs.getByRole('listitem')).toHaveCount(20);
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

test('flow shares over 100 % stop the Run button and say why, until they fit', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Over-allocated shares');
	const setShares = async (v: number) => {
		for (const n of project.model.nodes) if (n.kind === 'farm') n.flowShareManual = v;
		await putModel(page.request, project.id, project.model);
	};
	await updateSettings(page.request, project.id, { flowShareMethod: 'manual' });
	await setShares(0.7);
	await page.goto(`/projects/${project.id}?tab=runs`);
	const button = page.getByRole('button', { name: 'Run model' });
	await expect(button).toBeDisabled();
	await expect(page.getByTestId('shares-over')).toHaveText(/The run can't start: farm flow shares sum to 140\.00%, more than 100%/);

	// Positive control: shares that add up to 100 % run.
	await setShares(0.5);
	await page.reload();
	await expect(button).toBeEnabled();
	await expect(page.getByTestId('shares-over')).toHaveCount(0);
});
