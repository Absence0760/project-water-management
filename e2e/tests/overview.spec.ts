// The Summary tab (id `overview`, issue #17): results and the setup checklist, built from the lists the project
// page loads (series, runs) and the model being edited. The headline facts, details and who has access moved to
// the Project page (project-page.spec.ts).
import type { Page } from '@playwright/test';
import { createProject, createRun, putModel, seedRunnableProject } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';

const setup = (page: Page) => page.getByRole('region', { name: /^Set(up| up this catchment)/ });
/** A run's daily dam_storage series (the Dam levels' fallback for a run older than engine 1.2.0). */
const DAM_SERIES = /\/runs\/[^/]+\/series\?key=dam_storage/;

test('a fresh project: nothing loaded, every step to do', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Overview empty');
	await page.goto(`/projects/${project.id}`);
	await expect(setup(page).getByRole('heading', { name: 'Set up this catchment' })).toBeVisible();
	await expect(setup(page)).toContainText('0 of 5 done');
	await expect(setup(page)).toContainText('Upload daily catchment rainfall (mm).');
	await expect(setup(page)).toContainText('Run it to get unit supply & deficit');
	// The model's facts are on the Project page, one link away.
	await expect(page.getByRole('heading', { level: 2, name: 'The model' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: /^Model facts, details, team and sharing\s+Project$/ })).toHaveAttribute('href', '?tab=project');
});

test('a project with data and a run: setup complete', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Overview ready');
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}`);
	const done = setup(page);
	await expect(done.getByRole('heading', { name: 'Setup complete' })).toBeVisible();
	await done.getByText('All 5 steps done. Show checklist').click();
	await expect(done).toContainText('Rainfall and observed flow loaded.');
	await expect(done).toContainText(/1 run, latest \d{4}-\d{2}-\d{2}\./);
});

test('the latest run: its headline figures, the change from the run before, and a link to it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Overview latest run');
	await createRun(page.request, project.id, 'Baseline');
	const second = await createRun(page.request, project.id, 'Second');
	await page.goto(`/projects/${project.id}`);

	// Which run it is: the section header's context line (issue #17), under the Summary title.
	const context = page.getByTestId('section-context');
	await expect(context).toContainText('Second');
	await expect(context).toContainText(/\d{1,2} [A-Z][a-z]{2} \d{4} – \d{1,2} [A-Z][a-z]{2} \d{4}/);
	await expect(context).toContainText(/engine \d+\.\d+\.\d+/);
	await expect(context).toContainText('ran today');
	const latest = page.getByRole('region', { name: 'Latest run', exact: true });
	const card = (term: string) => latest.locator('dl.stats > div').filter({ has: page.getByRole('term').filter({ hasText: term }) });
	await expect(card('EWR not met')).toContainText('of days');
	await expect(card('Irrigation supplied')).toContainText('of demand');
	await expect(card('Dams today')).toContainText(/\d+%full/);
	await expect(latest.locator('dl.stats > div')).toHaveCount(4);
	// Reserve · Irrigation supplied · Dams today · NSE, in that order; the mean outflow is a short line under them,
	// its change and the rest on River & reserve (river-page.spec.ts).
	await expect(latest.locator('dl.stats > div > dt')).toContainText(['EWR not met', 'Irrigation supplied', 'Dams today', 'Calibration NSE']);
	await expect(latest.locator('[data-headline="outflow"]')).toContainText(/^Mean simulated outflow [\d.]+ m³\/s \(\d+% of natural\): its change and the reserve in detail are on River & reserve\.$/);
	await expect(latest.locator('[data-headline="outflow"]').getByRole('link', { name: 'River & reserve' })).toHaveAttribute('href', `?tab=river&run=${second}`);
	// Same inputs, so every change is zero, and it says which run it is against.
	await expect(card('Irrigation supplied')).toContainText(/0 pp\s*no change\s*vs previous run/);
	await expect(latest).toContainText('Changes are against the previous run, Baseline.');

	await context.getByRole('link', { name: 'Open in Runs' }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]run=${second}`));
	await expect(page.getByRole('heading', { level: 2, name: 'Second' })).toBeVisible();
});

test('needs attention: stale data links to the Data tab; a project with no runs has no latest-run strip', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Overview attention');
	await page.goto(`/projects/${project.id}`);
	// The seeded rain ends in January 2022, long before today.
	const panel = page.getByRole('region', { name: 'Needs attention', exact: true });
	await expect(panel).toContainText('The newest recorded rain ends 28 Jan 2022');
	await expect(panel.getByRole('link', { name: 'Add data' })).toHaveAttribute('href', '?tab=series');
	await expect(page.getByRole('region', { name: 'Latest run', exact: true })).toHaveCount(0);

	await createRun(page.request, project.id, 'Only run');
	await page.reload();
	const latest = page.getByRole('region', { name: 'Latest run', exact: true });
	await expect(latest.locator('dl.stats > div')).toHaveCount(4);
	await expect(latest).not.toContainText('vs previous run');
});

test('the Summary leads with the results once there is a run, the setup checklist before one', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Summary order');
	await page.goto(`/projects/${project.id}`);
	await expect(page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Summary' })).toHaveAttribute('aria-current', 'page');
	// No run yet: the checklist is the first thing on the tab, and there is no KPI row or flow chart.
	await expect(setup(page)).toBeVisible();
	const box = async (name: string | RegExp) => (await page.getByRole('region', { name, exact: typeof name === 'string' }).boundingBox())!;
	expect((await box(/^Set(up| up this catchment)/)).y).toBeLessThan((await box('Needs attention')).y);
	await expect(page.getByRole('region', { name: 'Flow vs reserve' })).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Latest run', exact: true })).toHaveCount(0);

	await createRun(page.request, project.id, 'Baseline');
	await page.reload();
	const flow = page.getByRole('region', { name: 'Flow vs reserve' });
	await expect(flow.getByRole('img', { name: /^EWR vs simulated outflow: line chart of Simulated outflow/ })).toBeVisible();
	await expect(flow.locator('figure.chart')).toHaveAttribute('data-ready', 'true');
	await expect(setup(page).getByRole('heading', { name: 'Setup complete' })).toBeVisible();
	// The Dam levels table lives on the Dams page; the Summary links there.
	const damsLink = page.getByRole('link', { name: /^Dam levels for each dam\s+Dams$/ });
	await expect(damsLink).toBeVisible();
	await expect(page.getByRole('region', { name: 'Dam levels' })).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Supply by unit' })).toBeVisible();
	// The bars' % says what it measures.
	await expect(page.getByTestId('supply-bars-what')).toHaveText("Share of each unit's irrigation demand supplied, latest run");

	// First screen (board A1): the KPI row, then the chart on the left, Needs attention above Supply by unit on the right.
	const kpis = await box('Latest run');
	const chart = await box('Flow vs reserve');
	const attention = await box('Needs attention');
	const supply = await box('Supply by unit');
	expect(chart.y).toBeGreaterThan(kpis.y + kpis.height - 1);
	expect(attention.x).toBeGreaterThan(chart.x + chart.width);
	expect(Math.abs(attention.y - chart.y)).toBeLessThan(2);
	expect(supply.y).toBeGreaterThan(attention.y + attention.height - 1);
	expect(Math.round(supply.x)).toBe(Math.round(attention.x));
	// It fits the window: the chart and the side column end inside it, on one bottom edge, and fill it.
	const vh = page.viewportSize()!.height;
	expect(chart.y + chart.height).toBeLessThanOrEqual(vh);
	expect(Math.abs(chart.y + chart.height - (supply.y + supply.height))).toBeLessThan(2);
	expect(chart.y + chart.height).toBeGreaterThan(vh - 40);
	expect(chart.height).toBeGreaterThan(450);

	// Below it, compact (issue #17): the alerts beside the published baseline, then one line of links (the Dams
	// page, the Project page), then the one-line setup. Nothing else: the rest is on the Project page.
	const alerts = await box('Active alerts');
	const baseline = await box('Published baseline');
	expect(alerts.y).toBeGreaterThan(chart.y + chart.height);
	expect(Math.round(baseline.y)).toBe(Math.round(alerts.y));
	expect(baseline.x).toBeGreaterThan(alerts.x + alerts.width);
	const projectLink = page.getByRole('link', { name: /^Model facts, details, team and sharing\s+Project$/ });
	const links = (await damsLink.boundingBox())!;
	expect(links.y).toBeGreaterThan(alerts.y + alerts.height);
	expect(Math.round((await projectLink.boundingBox())!.y)).toBe(Math.round(links.y));
	const setupBox = await box(/^Set(up| up this catchment)/);
	expect(setupBox.y).toBeGreaterThan(links.y);
	expect(setupBox.height).toBeLessThan(80);
	await expect(page.getByRole('heading', { level: 2, name: 'The model' })).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Members' })).toHaveCount(0);

	// ?tab=summary is the same page.
	await page.goto(`/projects/${project.id}?tab=summary`);
	await expect(page.getByRole('region', { name: 'Latest run', exact: true })).toBeVisible();
});

test('the flow chart: 30 days / 1 year / All, and the days below the reserve shaded', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Summary flow chart');
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}`);
	const flow = page.getByRole('region', { name: 'Flow vs reserve' });
	const fig = flow.locator('figure.chart');
	await expect(fig).toHaveAttribute('data-ready', 'true');
	const windows = flow.getByRole('group', { name: 'Time window' });
	// The run is 120 days (1 Oct 2021 – 28 Jan 2022): a year shows all of it, and the chart opens on it.
	await expect(windows.getByRole('button', { name: '1 year' })).toHaveAttribute('aria-pressed', 'true');
	await expect(fig).toHaveAttribute('data-view-start', '2021-10-01');
	await expect(fig).toHaveAttribute('data-view-end', '2022-01-28');
	await windows.getByRole('button', { name: '30 days' }).click();
	await expect(fig).toHaveAttribute('data-view-start', '2021-12-29');
	await expect(fig).toHaveAttribute('data-view-end', '2022-01-28');
	await expect(windows.getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true');
	await expect(windows.getByRole('button', { name: '1 year' })).toHaveAttribute('aria-pressed', 'false');
	await windows.getByRole('button', { name: 'All' }).click();
	await expect(fig).toHaveAttribute('data-view-start', '2021-10-01');
	await expect(windows.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');

	// The shaded days are the run's own EWR-not-met days: the caption's count is the KPI card's.
	await expect(fig).toHaveAttribute('data-shaded', /^\d+$/);
	const card = page.getByRole('region', { name: 'Latest run', exact: true }).locator('[data-headline="ewr"]');
	const notMet = /(\d+) of 120 days/.exec((await card.textContent()) ?? '')![1];
	await expect(fig).toContainText(`Shaded: the ${notMet} days the outflow was below the dashed EWR line (EWR not met).`);
});

test('needs attention cards and supply by unit: coloured by how much it matters, each unit opens its drawer, and both lead to Units & supply', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Summary side column');
	// Plant far more on Lower farm than its water can serve, so it comes up short.
	const model = { ...project.model, cropAreas: project.model.cropAreas.map((a, i) => (i === 1 ? { ...a, areaM2: 3_000_000 } : a)) };
	await putModel(page.request, project.id, model);
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}`);

	const attention = page.getByRole('region', { name: 'Needs attention', exact: true });
	const short = attention.locator('[data-attention="short-farms"]');
	await expect(short).toContainText('1 of 2 units below 95%');
	await expect(short).toContainText(/Lower farm got \d+% of its demand in the latest run/);
	await expect(short).toHaveAttribute('data-tone', /^(danger|warning)$/);
	await expect(attention.locator('[data-attention="stale-data"]')).toHaveAttribute('data-tone', 'warning');

	const supply = page.getByRole('region', { name: 'Supply by unit' });
	const rows = supply.getByRole('listitem');
	await expect(rows).toHaveCount(2);
	// Fullest first, emptiest last, in the Network's supply bands, with a key to them.
	await expect(rows.first()).toContainText('Upper farm');
	await expect(rows.last()).toContainText('Lower farm');
	await expect(rows.last()).toHaveAttribute('data-band', /^(short|low)$/);
	const pcts = await rows.evaluateAll((lis) => lis.map((li) => parseFloat(li.querySelector('.pct')!.textContent!)));
	expect(pcts[0]!).toBeGreaterThan(pcts[1]!);
	await expect(supply).toContainText(/supplied/);
	// The whole picture is on Units & supply, for the same run (issue #17).
	await expect(supply.getByRole('link', { name: 'More on Units & supply' })).toHaveAttribute('href', /^\?tab=supply&run=[0-9a-f-]{36}$/);

	// A farm's name opens its planted areas over the Summary.
	await rows.last().getByRole('link', { name: 'Lower farm' }).click();
	await expect(page).toHaveURL(new RegExp(`\\?farm=${project.model.nodes[2]!.id}$`));
	await expect(page.getByRole('dialog', { name: 'Lower farm: planted areas' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);

	// The whole card is the link: a click on its detail follows the main action, Units & supply on the worst unit (issue #17).
	await short.click({ position: { x: 16, y: 34 } });
	await expect(page).toHaveURL(new RegExp(`[?&]tab=supply&run=[0-9a-f-]{36}&unit=${project.model.nodes[2]!.id}$`));
	await expect(page.getByRole('region', { name: 'Unit detail: Lower farm' })).toBeVisible();
});

test.describe('the first screen has no accessibility violations', () => {
	for (const [label, viewport] of [
		['desktop', { width: 1440, height: 960 }],
		['phone', { width: 390, height: 844 }]
	] as const) {
		test(label, async ({ page, owner }) => {
			void owner;
			await page.setViewportSize(viewport);
			const project = await seedRunnableProject(page.request, `Summary a11y ${label}`);
			await createRun(page.request, project.id, 'Baseline');
			await createRun(page.request, project.id, 'Second');
			await page.goto(`/projects/${project.id}`);
			await expect(page.getByRole('region', { name: 'Flow vs reserve' }).locator('figure.chart')).toHaveAttribute('data-ready', 'true');
			await expect(page.getByRole('region', { name: 'Latest run', exact: true }).locator('[data-headline="dams"]')).toContainText('full');
			await expect(page.getByRole('region', { name: 'Supply by unit' })).toBeVisible();
			if (label === 'phone') expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
			await expectNoViolations(page);
		});
	}
});

test('Dams today is every dam together, and it and the one-line link open the Dams page', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Summary dams');
	await createRun(page.request, project.id, 'Baseline');
	// The run summary carries each dam's figures (engine ≥ 1.2.0, issue #55): the Summary fetches no daily series for them.
	const damSeries: string[] = [];
	page.on('request', (r) => {
		if (DAM_SERIES.test(r.url())) damSeries.push(r.url());
	});
	await page.goto(`/projects/${project.id}`);

	const today = page.getByRole('region', { name: 'Latest run', exact: true }).locator('[data-headline="dams"]');
	await expect(today).toContainText('2 dams on 28 Jan 2022');
	await expect(today).toContainText(/in 30 days/);
	// Before the Dams page, whose sparklines and chart do read the series.
	expect(damSeries).toEqual([]);
	// The table moved to the Dams page (dams-page.spec.ts checks it, and that this figure is its capacity-weighted total).
	await expect(page.getByRole('region', { name: 'Dam levels' })).toHaveCount(0);
	const link = page.getByRole('link', { name: /^Dam levels for each dam\s+Dams$/ });
	await expect(link).toHaveAttribute('href', '?tab=dams');
	// Below the flow chart, above the setup checklist.
	const flow = (await page.getByRole('region', { name: 'Flow vs reserve' }).boundingBox())!;
	expect((await link.boundingBox())!.y).toBeGreaterThan(flow.y);
	expect((await link.boundingBox())!.y).toBeLessThan((await setup(page).boundingBox())!.y);
	await link.click();
	await expect(page).toHaveURL(/\?tab=dams$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Dams' })).toBeVisible();

	// The card is a link to the same page, from anywhere on it.
	await page.goBack();
	await expect(today).toContainText('full');
	await today.click({ position: { x: 20, y: 60 } });
	await expect(page).toHaveURL(/\?tab=dams$/);
	await expectNoViolations(page);
});

test('Dams today: a run from before the summary kept dam figures still shows it, from the daily series', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Summary dams, older run');
	await createRun(page.request, project.id, 'Baseline');
	// Strip the dam figures from the run's summary, as a run saved before engine 1.2.0 has none.
	await page.route(/\/runs\/[0-9a-f-]+$/, async (route) => {
		if (route.request().method() !== 'GET') return route.fallback();
		const res = await route.fetch();
		const body = (await res.json()) as { run: { summary: { farms: Record<string, unknown>[] } } };
		for (const f of body.run.summary.farms) for (const k of ['damEndM3', 'damAgoM3', 'damLowM3', 'damLowDate', 'damDaysAtMin']) delete f[k];
		await route.fulfill({ response: res, json: body });
	});
	const damSeries: string[] = [];
	page.on('request', (r) => {
		if (DAM_SERIES.test(r.url())) damSeries.push(r.url());
	});
	await page.goto(`/projects/${project.id}`);
	const today = page.getByRole('region', { name: 'Latest run', exact: true }).locator('[data-headline="dams"]');
	await expect(today).toContainText('2 dams on 28 Jan 2022');
	await expect(today).toContainText(/in 30 days/);
	expect(damSeries).toHaveLength(2);
});

test('data added from the Summary shows up in its checklist straight away', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Overview upload');
	await page.goto(`/projects/${project.id}`);
	await expect(setup(page)).toContainText('Upload daily catchment rainfall (mm).');

	await page.getByRole('button', { name: 'Add data' }).click();
	const dialog = page.getByRole('dialog', { name: 'Add data' });
	await dialog.getByLabel('Kind').selectOption({ label: 'Rainfall — catchment' });
	await dialog.getByLabel('CSV file').setInputFiles({
		name: 'rain.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from('date,value\n2021-10-01,1\n2021-10-02,0\n2021-10-03,4\n')
	});
	await dialog.getByRole('button', { name: 'Upload' }).click();
	await expect(dialog).toBeHidden();

	await expect(setup(page)).toContainText('Rainfall loaded. No observed flow yet');
});
