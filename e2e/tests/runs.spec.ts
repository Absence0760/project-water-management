import { createRun, putModel, putSeries, seedRunnableProject, syntheticFlow, syntheticRain, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { answerConfirm } from '../support/confirm.ts';

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
	await expect(summary.getByRole('heading', { name: 'Catchment' })).toBeVisible();
	// The per-unit table moved to Hydrological units (issue #17, supply-page.spec.ts): the run header links there for this run.
	await expect(summary.getByRole('heading', { name: 'Hydrological units', exact: true })).toHaveCount(0);
	const runId = new URL(page.url()).searchParams.get('run')!;
	await expect(page.getByRole('link', { name: 'Hydrological units for this run' })).toHaveAttribute('href', `?tab=supply&run=${runId}`);
	const calibration = page.getByRole('region', { name: 'Calibration against observed flow' });
	await expect(calibration.getByRole('term').filter({ hasText: 'Observations' })).toBeVisible();
	// A gauge record is scored against the simulated outflow, not natural flow.
	await expect(calibration.getByRole('definition').filter({ hasText: 'Simulated outflow at the outlet' })).toBeVisible();
	// The headline fit scores say whether they are in-sample (issue #4): these parameters were set by hand, not fitted (issue #45).
	await expect(calibration.getByText('Calibration period (parameters not fitted).', { exact: true })).toBeVisible();
	await expect(summary.getByText('calibration period (parameters not fitted)')).toHaveCount(2);
	await expect(summary.getByText(/in-sample/)).toHaveCount(0);
	await expect(calibration.getByText(/in-sample/)).toHaveCount(0);

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
	await page.getByLabel('Hydrological unit', { exact: true }).selectOption({ label: 'Upper farm' });
	await expect(page.getByRole('img', { name: /^Upper farm · .*: line chart/ }).locator('canvas')).toBeVisible();

	// The run is stored: a reload shows it again, newest first.
	await page.reload();
	await expect(list.getByRole('button', { name: /^Baseline/ })).toHaveAttribute('aria-current', 'true');
	await expect(summary.getByRole('heading', { name: 'Catchment' })).toBeVisible();
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

	for (const name of [/^Flow at the outflow gauge/, /^Flow-duration curve/, /^Catchment · /]) {
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

test('the hydrograph names the gauge and the logger, and shows both when a project has both (issue #45)', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Gauge and logger');
	await createRun(page.request, project.id, 'Gauge only');
	await page.goto(`/projects/${project.id}?tab=runs`);
	await expect(page.getByRole('heading', { level: 2, name: 'Gauge only' })).toBeVisible();
	await expect(page.getByRole('img', { name: 'Flow at the outflow gauge: natural, simulated and observed: line chart of Observed gauge, Natural, Simulated outflow' })).toBeVisible();

	// A logger beside the gauge, chosen as the calibration record.
	await putSeries(page.request, project.id, { kind: 'flow_logger_m3s', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(60) });
	await updateSettings(page.request, project.id, { calibrationFlowKind: 'flow_logger_m3s' });
	await createRun(page.request, project.id, 'Both records');
	await page.goto(`/projects/${project.id}?tab=runs`);
	await expect(page.getByRole('heading', { level: 2, name: 'Both records' })).toBeVisible();
	const chart = page.locator('figure', { has: page.getByRole('img', { name: /^Flow at the outflow gauge/ }) });
	await expect(
		chart.getByRole('img', { name: 'Flow at the outflow gauge: natural, simulated and observed: line chart of Observed logger (calibration record), Observed gauge, Natural, Simulated outflow' })
	).toBeVisible();
	await expect(chart.locator('canvas')).toBeVisible();
	await expect(chart.getByText(/^Observed logger \(calibration record\) is the solid line and Observed gauge the dashed one, shown but not scored/).first()).toBeVisible();
	// The flow-duration curve's observed line is the calibration record, named as such.
	await expect(page.getByRole('rowheader', { name: 'Observed logger (calibration record) (m³/s)', exact: true })).toBeVisible();
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
	// EWR vs outflow moved to River & reserve (river-page.spec.ts), and a unit's supply vs demand to Hydrological units
	// (supply-page.spec.ts), both with the Summary's time windows.
	void owner;
	const project = await seedRunnableProject(page.request, 'Chart parity');
	const days = 8 * 365;
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2001-10-01', values: syntheticRain(days) });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2001-10-01', values: syntheticFlow(days) });
	await createRun(page.request, project.id, 'Parity');
	await page.goto(`/projects/${project.id}?tab=runs`);

	const figure = (title: RegExp) => page.locator('figure', { has: page.getByRole('img', { name: title }) });
	const hydro = figure(/^Flow at the outflow gauge/);
	const fdc = figure(/^Flow-duration curve/);
	const explore = page.locator('#res-explore figure');

	// Earlier / Later on every windowed daily chart, not just the hydrograph.
	await expect(figure(/^EWR vs simulated outflow/)).toHaveCount(0);
	await expect(figure(/^Supply vs demand/)).toHaveCount(0);
	for (const chart of [explore]) {
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
	for (const chart of [hydro, fdc, explore]) await expect(chart.getByRole('button', { name: 'm³/s' })).toHaveAttribute('aria-pressed', 'true');
	await fdc.getByRole('button', { name: 'm³/day' }).click();
	for (const chart of [hydro, fdc, explore]) {
		await expect(chart.getByRole('button', { name: 'm³/day' })).toHaveAttribute('aria-pressed', 'true');
		await expect(chart.locator('.u-legend')).toContainText('(m³/day)');
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
		'Hydrograph',
		'Flow duration',
		'Calibration',
		'Water balance',
		'Runoff model',
		'EWR vs observed',
		'Plausibility',
		'Notes & evidence',
		'Validation',
		'Publication',
		'Self-checks',
		'Outputs'
	]);
	// The panels are grouped by the question they answer, in the menu and on the page alike.
	const groups = ['Model quality', 'Record', 'Dig deeper'];
	await expect(page.getByRole('heading', { level: 2 }).filter({ hasText: /^(River & Reserve|Units & users|Model quality|Record|Dig deeper)$/ })).toHaveText(groups);
	// The river and unit groups have their own pages, linked from the run header (runs-page.spec.ts), not the menu.
	await expect(menu.getByRole('list', { name: 'River & Reserve' })).toHaveCount(0);
	await expect(menu.getByRole('list', { name: 'Units & users' })).toHaveCount(0);
	await expect(menu.getByRole('list', { name: 'Model quality' }).getByRole('link').first()).toHaveText('Hydrograph');
	await expect(menu.getByRole('list', { name: 'Dig deeper' }).getByRole('link')).toHaveText(['Self-checks', 'Outputs']);
	// The summary opens with the model checks, each linking to its panel.
	const checks = page.getByRole('list', { name: 'Model checks' });
	await expect(checks.getByRole('link', { name: /^Self-checks all \d+ passed$/ })).toHaveAttribute('href', '#res-checks');

	// The menu sits above the results, as on Settings & calibration, and stays in view as the
	// page scrolls, marking the section being read.
	await expect(menu.getByRole('link', { name: 'Summary' })).toHaveAttribute('aria-current', 'location');
	await menu.getByRole('link', { name: 'Hydrograph' }).click();
	await expect(page.getByRole('img', { name: /^Flow at the outflow gauge/ })).toBeInViewport();
	await expect(menu).toBeInViewport();
	await expect(menu.getByRole('link', { name: 'Hydrograph' })).toHaveAttribute('aria-current', 'location');
	await expect(menu.getByRole('link', { name: 'Summary' })).not.toHaveAttribute('aria-current', 'location');

	await menu.getByRole('link', { name: 'Calibration' }).click();
	await expect(page).toHaveURL(/[?&]run=[0-9a-f-]{36}#res-calibration$/);
	const calibration = page.locator('#res-calibration');
	await expect(calibration).toBeInViewport();
	// The section's top edge clears the sticky menu (no app bar across the top since the sidebar, issue #17).
	const menuBox = await menu.boundingBox();
	const top = await calibration.boundingBox();
	expect(menuBox!.y).toBeGreaterThanOrEqual(-1);
	expect(top!.y).toBeGreaterThanOrEqual(menuBox!.y + menuBox!.height);

	await menu.getByRole('link', { name: 'Outputs', exact: true }).click();
	await expect(page.getByRole('region', { name: 'Explore any output' })).toBeInViewport();
	await expect(page).toHaveURL(/#res-explore$/);

	// Phone: the menu is one strip that scrolls inside itself, never the page.
	await page.setViewportSize({ width: 390, height: 900 });
	await menu.getByRole('link', { name: 'Calibration' }).click();
	await expect(menu.getByRole('link', { name: 'Calibration' })).toBeInViewport();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
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

test('a runs list that answers after a new run never puts back the list from before it', async ({ page, owner, fetchRoute }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Runs late list');
	await createRun(page.request, project.id, 'First');
	// The page's first load shows the list; the Runs tab then asks again on its own. Hold that
	// answer (fetched now, so it is the list from before the new run) until the new run is in.
	const listUrl = `/projects/${project.id}/runs`;
	let release!: () => void;
	const released = new Promise<void>((resolve) => (release = resolve));
	let lists = 0;
	await fetchRoute(
		page,
		(url) => url.pathname.endsWith(listUrl),
		async (route) => {
			if (route.request().method() !== 'GET' || ++lists === 1) return route.continue();
			const response = await route.fetch();
			await released;
			await route.fulfill({ response });
		}
	);
	await page.goto(`/projects/${project.id}?tab=runs`);
	const list = page.getByRole('region', { name: 'Runs', exact: true });
	await expect(list.getByRole('button', { name: /^First/ })).toBeVisible();
	await expect.poll(() => lists).toBeGreaterThanOrEqual(2);

	await page.getByLabel(/^Run label/).fill('Newest');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(list.getByRole('button', { name: /^Newest/ })).toHaveAttribute('aria-current', 'true');

	let answered = 0;
	page.on('response', (r) => {
		if (r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith(listUrl)) answered++;
	});
	release();
	// The late answer predates the run: the tab asks again rather than showing it, and shows the fresh answer.
	await expect.poll(() => answered).toBeGreaterThanOrEqual(2);
	expect(lists).toBeGreaterThanOrEqual(3);
	await expect(list.getByRole('button', { name: /^Newest/ })).toHaveAttribute('aria-current', 'true');
	await expect(list.getByRole('button', { name: /^First/ })).toBeVisible();
});

test('with a long runs list the runs rail and the whole results menu stay in view on a laptop screen', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Runs rail');
	// RUNS_KEPT_PER_PROJECT is 20, the most a project can hold. Sent together: the full local
	// suite shares one API process, and 20 requests awaited one by one each queue behind the other
	// workers' heavy runs (this setup alone reached the 30 s test timeout). Nothing here needs an order.
	await Promise.all(Array.from({ length: 20 }, (_, i) => createRun(page.request, project.id, `Run ${String(i + 1).padStart(2, '0')}`)));
	await page.setViewportSize({ width: 1280, height: 768 });
	await page.goto(`/projects/${project.id}?tab=runs`);

	const menu = page.getByRole('navigation', { name: 'Result sections' });
	await expect(menu.getByRole('link', { name: 'Outputs', exact: true })).toBeVisible();
	// The list scrolls inside its own panel rather than running off the rail.
	const runs = page.getByRole('region', { name: 'Runs', exact: true }).getByRole('list');
	expect(await runs.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
	await expect(menu.getByRole('link', { name: 'Summary' })).toBeInViewport({ ratio: 1 });

	// Once the rail and the menu are stuck under the header, the list and every menu link fit on screen.
	await menu.getByRole('link', { name: 'Calibration' }).click();
	await expect(page.getByRole('region', { name: 'Runs', exact: true })).toBeInViewport();
	// The rail needs no scrollbar of its own: nothing in it is clipped (a fixed 16rem list overflowed by 17px here).
	// The runs rail (the app sidebar is a complementary landmark too, since issue #17's shell).
	const rail = page.getByRole('region', { name: 'Runs & results' }).getByRole('complementary');
	await expect.poll(() => rail.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(0);
	for (const name of ['Summary', 'Outputs']) await expect(menu.getByRole('link', { name })).toBeInViewport({ ratio: 1 });

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
	await expect(page.getByTestId('shares-over')).toHaveText(/The run can't start: unit flow shares sum to 140\.00%, more than 100%/);

	// Positive control: shares that add up to 100 % run.
	await setShares(0.5);
	await page.reload();
	await expect(button).toBeEnabled();
	await expect(page.getByTestId('shares-over')).toHaveCount(0);
});

test('with a gauge covering part of the run, the flow-duration curves rank the observed days, and the whole run is a click away', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'FDC on observed days');
	// The gauge reads only the second half of the 120-day run.
	const flow = syntheticFlow(120).map((v, i) => (i < 60 ? null : v));
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2021-10-01', values: flow });
	await createRun(page.request, project.id, 'Half gauged');
	await page.goto(`/projects/${project.id}?tab=runs`);
	const fdc = page.locator('#res-fdc');
	const days = fdc.getByRole('group', { name: 'Days the curves rank' });
	await expect(days.getByRole('button', { name: 'Observed days' })).toHaveAttribute('aria-pressed', 'true');
	await expect(fdc).toContainText('Every curve ranks the 60 days with an observed reading, so they compare like with like.');
	await days.getByRole('button', { name: 'Whole run' }).click();
	await expect(fdc).toContainText('Natural and simulated flow rank all 120 days of the run; observed flow only its 60 days with a reading.');
});

test('with a gauge covering the whole run there is no choice of days to make (positive control)', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'FDC fully gauged');
	await createRun(page.request, project.id, 'Fully gauged');
	await page.goto(`/projects/${project.id}?tab=runs`);
	await expect(page.locator('#res-fdc').getByRole('img', { name: /Flow-duration curve/ })).toBeVisible();
	await expect(page.locator('#res-fdc').getByRole('group', { name: 'Days the curves rank' })).toHaveCount(0);
});

// Issue #77: the Runs tab reads its list as it opens. A run deleted before that
// read answers stayed deleted only by luck: the older list, arriving last, put
// the run back and opened it ("not found"). Here the read is taken before the
// delete and held until after it, every time.
test('a run deleted while the list is still loading stays deleted', async ({ page, owner, fetchRoute }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Runs delete race');
	await createRun(page.request, project.id, 'Baseline');
	// The workspace has loaded its shared lists (the tabs render behind that gate).
	await page.goto(`/projects/${project.id}?tab=scenarios`);
	await expect(page.getByTestId('scenarios-empty')).toBeVisible();

	let release = () => {};
	const gate = new Promise<void>((r) => (release = r));
	let served = 0;
	await fetchRoute(
		page,
		(url) => url.pathname === `/projects/${project.id}/runs`,
		async (route) => {
			if (route.request().method() !== 'GET') return route.fallback();
			const res = await route.fetch();
			await gate;
			await route.fulfill({ response: res });
			served++;
		}
	);
	await page.getByRole('link', { name: 'Runs & results' }).click();
	const list = page.getByRole('region', { name: 'Runs', exact: true });
	await list.getByRole('listitem').filter({ hasText: /^Baseline/ }).getByRole('button', { name: /^Delete run Baseline/ }).click();
	await answerConfirm(page, true);
	await expect(list.getByRole('listitem')).toHaveCount(0);

	// The list read before the delete answers now: the tab sees it is stale and reads again.
	release();
	await expect.poll(() => served).toBe(2);
	await expect(list.getByRole('listitem')).toHaveCount(0);
	await expect(page.getByRole('alert').filter({ hasText: /not found|no longer exists/ })).toHaveCount(0);
	await expect(page.getByText('No runs yet. Run the model to see results.')).toBeVisible();
});
