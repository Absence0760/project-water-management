// River & reserve (issue #17, option A · Outcomes; docs/ui.md § River & reserve): one run's river
// against its EWR. The KPI tiles, the flow chart with its windows and shading, the days below the
// reserve per water year, the panels moved from Runs & results, the run picker, the links in from
// the Summary and Runs & results (old #res-… links included), the empty state and a viewer.
import type { Page } from '@playwright/test';
import { addMember, createProject, createRun, updateSettings } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { openRiver, riverTile, riverTiles, seedRiverProject } from '../support/river.ts';
import { grouped, ungroup } from '../support/format.ts';

/** Visible elements on the page that scroll vertically inside themselves (the window is the page's one scroll). */
const innerScrollers = (page: Page) =>
	page.locator('.page').evaluate((root) =>
		[...root.querySelectorAll('*')]
			.filter((e) => e.checkVisibility() && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1)
			.map((e) => `${e.tagName.toLowerCase()}.${e.className}`)
	);

type Catchment = { ewrDaysNotMet: number; ewrFractionDaysNotMet: number; meanSimulatedOutflowM3Day: number; meanNaturalFlowM3Day: number };

test('the tiles, the flow chart, the water-year bars and the moved panels, for the newest run', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const id = await seedRiverProject(page.request, 'River page');
	await createRun(page.request, id, 'Baseline');
	const second = await createRun(page.request, id, 'Second');
	await openRiver(page, id);

	await expect(page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'River & reserve', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(page.getByRole('heading', { level: 1, name: 'River & reserve' })).toBeVisible();
	const context = page.getByTestId('river-context');
	await expect(context).toContainText('Second');
	await expect(context).toContainText('1 Oct 2019 – 30 Sep 2022');
	await expect(context).toContainText(/engine \d+\.\d+\.\d+/);
	await expect(context).toContainText('EWR: pragmatic, by month');
	await expect(page.getByLabel('Run', { exact: true })).toHaveValue(second);

	// The tiles, from the run's own summary.
	const res = await page.request.get(`${API_URL}/projects/${id}/runs/${second}`);
	const c = ((await res.json()) as { run: { summary: { catchment: Catchment } } }).run.summary.catchment;
	// EWR not met, worded as the Summary's card is (issue #162: this tile said "Reserve met" for the same figure).
	// The Worst month tile is gone (issue #175): it restated the largest share in the EWR by month grid's All years row.
	// So is Days below the reserve (issue #177): it repeated this tile's count, and its days a year are a sub line here.
	await expect(riverTiles(page).locator('dt')).toHaveText(['EWR not met', 'Mean simulated outflow']);
	await expect(riverTile(page, 'ewr')).toContainText(`${(c.ewrFractionDaysNotMet * 100).toFixed(1)}%of days`);
	// Both from the pragmatic test the tile counts: its days of the record, then per average year (1 096 days here).
	const perYear = (c.ewrDaysNotMet * 365.25) / 1096;
	const perYearText = perYear < 10 ? String(Math.round(perYear * 10) / 10) : grouped(Math.round(perYear));
	await expect(riverTile(page, 'ewr').locator('dd.sub')).toContainText([
		`${grouped(c.ewrDaysNotMet)} of 1\u202f096 days at the outflow gauge`,
		`${perYearText} ${perYearText === '1' ? 'day' : 'days'} in an average year`
	]);
	await expect(page.locator('[data-kpi="below"]')).toHaveCount(0);
	await expect(riverTile(page, 'outflow')).toContainText(`${Math.round((100 * c.meanSimulatedOutflowM3Day) / c.meanNaturalFlowM3Day)}% of natural`);
	await expect(page.locator('[data-kpi="worst"]')).toHaveCount(0);
	// Same inputs twice, so every change is zero, against the run before.
	await expect(riverTile(page, 'ewr')).toContainText(/0 pp\s*no change\s*vs previous run/);
	await expect(page.getByText('Changes are against the previous run, Baseline.')).toBeVisible();

	// The chart and the bars, then the panels that were Runs & results' River & Reserve group.
	await expect(page.locator('#res-ewr').getByRole('img', { name: /^EWR vs simulated outflow: line chart of Simulated outflow/ })).toBeVisible();
	const years = page.getByRole('region', { name: 'Days below the reserve, each water year' });
	await expect(years.getByRole('img', { name: /^Days below the reserve per water year\. Second: \d+ days below in 3 water years\.$/ })).toBeVisible();
	// The value axis names its unit, and bars that are all 0 say so on the plot rather than looking empty.
	await expect(years.getByTestId('reserve-years-unit')).toHaveText('days below');
	const total = Number(/Second: (\d+) days below/.exec((await years.getByRole('img').getAttribute('aria-label'))!)![1]);
	await expect(years.getByTestId('reserve-years-none')).toHaveCount(total === 0 ? 1 : 0);
	// The last water year's label sits whole inside the plot, not cut off at its right edge (issue #162: "2024/2…").
	const lastLabel = years.locator('text.x').last();
	await expect(lastLabel).toHaveText('2021/22');
	const svgBox = (await years.locator('svg').boundingBox())!;
	const labelBox = (await lastLabel.boundingBox())!;
	expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(svgBox.x + svgBox.width);
	await expect(page.getByRole('region', { name: /^EWR compliance by month/ })).toBeVisible();
	await expect(page.getByTestId('uncertainty-panel')).toBeVisible();
	await expect(page.getByTestId('outcome-matrix')).toBeVisible();
	await expect(page.getByRole('region', { name: 'Water account' })).toBeVisible();
	// No rule table: no Reserve compliance panel.
	await expect(page.locator('#res-reserve')).toHaveCount(0);

	// The page flows in the window's one scroll (it was fitted to the window until 2026-09-29, and read as the
	// whole page): the chart has a fixed, generous height with the bars beside it as tall, and the next panel's top
	// edge shows inside 1440 × 960, so there is visibly more below.
	const vh = page.viewportSize()!.height;
	const chart = (await page.getByRole('region', { name: 'Flow vs reserve' }).boundingBox())!;
	const bars = (await years.boundingBox())!;
	expect(bars.x).toBeGreaterThan(chart.x + chart.width);
	expect(Math.abs(chart.y + chart.height - (bars.y + bars.height))).toBeLessThan(2);
	expect(chart.height).toBeGreaterThan(500);
	expect((await page.locator('#res-ewr figure.chart .u-over').boundingBox())!.height).toBeGreaterThan(300);
	expect((await page.locator('#res-ewr-grid').boundingBox())!.y).toBeLessThan(vh);
	expect(await innerScrollers(page)).toEqual([]);
});

test('the flow chart: 30 days / 1 year / All, and the days below the reserve shaded to the EWR not met tile’s count', async ({ page, owner }) => {
	void owner;
	const id = await seedRiverProject(page.request, 'River chart');
	await createRun(page.request, id, 'Baseline');
	await openRiver(page, id);
	const flow = page.getByRole('region', { name: 'Flow vs reserve' });
	const fig = flow.locator('figure.chart');
	const windows = flow.getByRole('group', { name: 'Time window' });
	await expect(windows.getByRole('button', { name: '1 year' })).toHaveAttribute('aria-pressed', 'true');
	await expect(fig).toHaveAttribute('data-view-end', '2022-09-30');
	await expect(fig).toHaveAttribute('data-view-start', '2021-09-30');
	await windows.getByRole('button', { name: '30 days' }).click();
	await expect(fig).toHaveAttribute('data-view-start', '2022-08-31');
	await expect(windows.getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true');
	await windows.getByRole('button', { name: 'All' }).click();
	await expect(fig).toHaveAttribute('data-view-start', '2019-10-01');
	await expect(windows.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');

	const below = /^([\d\u202f]+) of /.exec((await riverTile(page, 'ewr').locator('dd.sub').first().textContent())!)![1]!.replace(/\D/g, '');
	expect(Number(below)).toBeGreaterThan(0);
	await expect(fig).toHaveAttribute('data-shaded', /^\d+$/);
	await expect(fig).toContainText(`Shaded: the ${grouped(Number(below))} days the outflow was below the pragmatic EWR line (EWR not met).`);
});

test('the flow chart keeps the Runs tab’s controls: m³/s ↔ m³/day, and Earlier / Later by the window', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const id = await seedRiverProject(page.request, 'River chart controls');
	await createRun(page.request, id, 'Baseline');
	await openRiver(page, id);
	const flow = page.getByRole('region', { name: 'Flow vs reserve' });
	const fig = flow.locator('figure.chart');
	const units = flow.getByRole('group', { name: 'Flow units' });
	const move = flow.getByRole('group', { name: 'Move through the record' });
	const windows = flow.getByRole('group', { name: 'Time window' });
	const simulated = fig.locator('.u-legend tr.u-series', { has: page.locator('.u-label', { hasText: /^Simulated outflow/ }) });
	const shaded = await fig.getAttribute('data-shaded');
	const caption = /Shaded: the [\d\u202f]+ days/.exec((await fig.textContent()) ?? '')![0];

	// Units: the legend names the unit and a hovered day's value is 86 400 times larger in m³/day.
	await expect(units.getByRole('button', { name: 'm³/s' })).toHaveAttribute('aria-pressed', 'true');
	await expect(simulated.locator('.u-label')).toHaveText('Simulated outflow (m³/s)');
	const plot = fig.locator('.u-over');
	const box = (await plot.boundingBox())!;
	const valueAt = async () => {
		await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
		await expect(simulated.locator('.u-value')).not.toHaveText('–');
		return ungroup((await simulated.locator('.u-value').textContent())!);
	};
	const perSecond = await valueAt();
	await units.getByRole('button', { name: 'm³/day' }).click();
	await expect(units.getByRole('button', { name: 'm³/day' })).toHaveAttribute('aria-pressed', 'true');
	await expect(simulated.locator('.u-label')).toHaveText('Simulated outflow (m³/day)');
	await expect(flow.getByRole('img', { name: /^EWR vs simulated outflow: line chart of Simulated outflow/ })).toBeVisible();
	await expect(fig).toHaveAttribute('data-ready', 'true');
	const perDay = await valueAt();
	expect(perDay / perSecond).toBeGreaterThan(86_400 * 0.98);
	expect(perDay / perSecond).toBeLessThan(86_400 * 1.02);
	// The shading is days, not flows: the same in either unit.
	await expect(fig).toHaveAttribute('data-shaded', shaded!);
	await expect(fig).toContainText(caption);
	await page.mouse.move(0, 0);

	// Earlier / Later step by the window picked and stop at the ends. The chart opens on the last year.
	const later = move.getByRole('button', { name: /Later/ });
	const earlier = move.getByRole('button', { name: /Earlier/ });
	await expect(fig).toHaveAttribute('data-view-end', '2022-09-30');
	await expect(later).toBeDisabled();
	await earlier.click();
	await expect(fig).toHaveAttribute('data-view-start', '2020-09-30');
	await expect(fig).toHaveAttribute('data-view-end', '2021-09-30');
	await expect(windows.getByRole('button', { name: '1 year' })).toHaveAttribute('aria-pressed', 'true');
	await earlier.click();
	// Two years back reaches the first day: the window stops there.
	await expect(fig).toHaveAttribute('data-view-start', '2019-10-01');
	await expect(earlier).toBeDisabled();
	await later.click();
	await later.click();
	await expect(fig).toHaveAttribute('data-view-end', '2022-09-30');
	await expect(later).toBeDisabled();
	// 30 days steps a month at a time.
	await windows.getByRole('button', { name: '30 days' }).click();
	await expect(fig).toHaveAttribute('data-view-start', '2022-08-31');
	await earlier.click();
	await expect(fig).toHaveAttribute('data-view-start', '2022-08-01');
	await expect(fig).toHaveAttribute('data-view-end', '2022-08-31');
	await expect(windows.getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true');
	await expect(later).toBeEnabled();
	// All shows the whole record: nowhere to move, so Earlier / Later step aside (as on every chart).
	await windows.getByRole('button', { name: 'All' }).click();
	await expect(fig).toHaveAttribute('data-view-start', '2019-10-01');
	await expect(move).toHaveCount(0);
});

test('the flow chart is drawn once, here: the Summary shows the days below by month instead (issue #162)', async ({ page, owner }) => {
	void owner;
	const id = await seedRiverProject(page.request, 'River summary chart');
	await createRun(page.request, id, 'Baseline');
	await page.goto(`/projects/${id}`);
	const strip = page.getByRole('region', { name: 'Days below the reserve' });
	await expect(strip.getByRole('listitem')).toHaveCount(12);
	await expect(page.getByRole('region', { name: 'Flow vs reserve' })).toHaveCount(0);
	await expect(page.locator('figure.chart')).toHaveCount(0);
});

test('the run picker: another run is a URL, Back returns, a reload keeps it', async ({ page, owner }) => {
	void owner;
	const id = await seedRiverProject(page.request, 'River picker');
	const baseline = await createRun(page.request, id, 'Baseline');
	await createRun(page.request, id, 'Second');
	await openRiver(page, id);
	const context = page.getByTestId('river-context');
	await expect(context).toContainText('Second');

	await page.getByLabel('Run', { exact: true }).selectOption(baseline);
	await expect(page).toHaveURL(new RegExp(`[?&]tab=river&run=${baseline}$`));
	await expect(context).toContainText('Baseline');
	// The oldest run: nothing before it to compare with.
	await expect(page.getByText(/^Changes are against the previous run/)).toHaveCount(0);
	await expect(riverTile(page, 'ewr')).not.toContainText('vs previous run');
	await expect(page.getByRole('region', { name: 'Days below the reserve, each water year' }).getByRole('img', { name: /Baseline: \d+ days below/ })).toBeVisible();

	await page.reload();
	await expect(context).toContainText('Baseline');
	await expect(page.getByLabel('Run', { exact: true })).toHaveValue(baseline);

	await page.goBack();
	await expect(page).toHaveURL(/[?&]tab=river$/);
	await expect(context).toContainText('Second');
	await expect(page.getByLabel('Run', { exact: true })).not.toHaveValue(baseline);
});

test('Runs & results links here for its run, and an old link to a moved panel lands on it here', async ({ page, owner }) => {
	void owner;
	const id = await seedRiverProject(page.request, 'River from runs');
	const baseline = await createRun(page.request, id, 'Baseline');
	await createRun(page.request, id, 'Second');

	// The run header links here, keeping the run.
	await page.goto(`/projects/${id}?tab=runs&run=${baseline}`);
	await expect(page.getByRole('heading', { level: 2, name: 'Baseline' })).toBeVisible();
	const link = page.getByRole('navigation', { name: 'Outcomes for this run' }).getByRole('link', { name: 'River & reserve for this run' });
	await expect(link).toHaveAttribute('href', `?tab=river&run=${baseline}`);
	await link.click();
	await expect(page).toHaveURL(new RegExp(`[?&]tab=river&run=${baseline}$`));
	await expect(page.getByTestId('river-context')).toContainText('Baseline');

	// A bookmark to EWR by month on Runs & results: here instead, same run, the panel scrolled to with focus on it.
	await page.goto(`/projects/${id}?tab=runs&run=${baseline}#res-ewr-grid`);
	await expect(page).toHaveURL(new RegExp(`[?&]tab=river&run=${baseline}#res-ewr-grid$`));
	const heading = page.locator('#res-ewr-grid').getByRole('heading', { name: /^EWR compliance by month/ });
	await expect(heading).toBeFocused();
	await expect(heading).toBeInViewport();
});

test('the Summary links here: its reserve strip', async ({ page, owner }) => {
	void owner;
	const id = await seedRiverProject(page.request, 'River from summary');
	const run = await createRun(page.request, id, 'Baseline');
	await page.goto(`/projects/${id}`);
	// (The Summary's mean outflow line, which linked here too, was dropped in #171; the outflow is this page's tile.)
	await page.getByRole('region', { name: 'Days below the reserve' }).getByRole('link', { name: 'More on River & reserve' }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]tab=river&run=${run}$`));
	await expect(riverTiles(page)).toHaveCount(2);
});

test('before the first run: the frame, and a way to run the model', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'River empty');
	await page.goto(`/projects/${project.id}?tab=river`);
	await expect(page.getByRole('heading', { level: 1, name: 'River & reserve' })).toBeVisible();
	const empty = page.getByRole('region', { name: 'No run yet' });
	await expect(empty).toContainText('After a run, this page shows the simulated outflow against the EWR');
	await expect(empty.getByRole('link', { name: 'Run the model' })).toHaveAttribute('href', '?tab=runs');
	await expect(page.getByLabel('Run', { exact: true })).toHaveCount(0);
	await expectNoViolations(page);
});

test('a viewer reads it too, with no run button', async ({ page, owner, signIn }) => {
	void owner;
	const id = await seedRiverProject(page.request, 'River viewer');
	const viewer = await signIn('River viewer');
	await addMember(page.request, id, viewer.user.email, 'viewer');

	await viewer.page.goto(`/projects/${id}?tab=river`);
	await expect(viewer.page.getByRole('region', { name: 'No run yet' })).toContainText('An editor can run the model.');
	await expect(viewer.page.getByRole('link', { name: 'Run the model' })).toHaveCount(0);

	await createRun(page.request, id, 'Baseline');
	await viewer.page.goto(`/projects/${id}`);
	await viewer.page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'River & reserve', exact: true }).click();
	await expect(riverTiles(viewer.page)).toHaveCount(2);
	await expect(viewer.page.getByTestId('river-context')).toContainText('Baseline');
	await expect(viewer.page.getByRole('region', { name: /^EWR compliance by month/ })).toBeVisible();
});

test.describe('nothing scrolls inside a card, and no accessibility violations', () => {
	for (const [label, viewport] of [
		['desktop', { width: 1440, height: 960 }],
		['phone', { width: 390, height: 844 }]
	] as const) {
		test(label, async ({ page, owner }) => {
			void owner;
			await page.setViewportSize(viewport);
			const id = await seedRiverProject(page.request, `River a11y ${label}`);
			await createRun(page.request, id, 'Baseline');
			await createRun(page.request, id, 'Second');
			await openRiver(page, id);
			await expect(page.getByRole('region', { name: 'Days below the reserve, each water year' }).getByRole('img')).toBeVisible();
			await expect(page.getByTestId('outcome-matrix')).toBeVisible();
			await expect(page.getByRole('region', { name: 'Water account' })).toBeVisible();
			if (label === 'phone') expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
			expect(await innerScrollers(page)).toEqual([]);
			await expectNoViolations(page);
		});
	}
});

const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
const POINTS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 99];

test('twenty water years with a rule table: every table grows with the page, and Month by month shows two years, then Show all', async ({ page, owner }) => {
	void owner;
	// Seeding and running twenty years of daily data is most of the time.
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 1440, height: 960 });
	const id = await seedRiverProject(page.request, 'River twenty years', 20 * 365 + 5);
	// Synthetic: asks for nothing but in January, where it asks for more than the river carries.
	await updateSettings(page.request, id, {
		ewrRules: [{ siteNodeId: null, source: 'Synthetic rule table', component: 'total', unit: 'mcm', points: POINTS, ewr: MONTHS.map((m) => POINTS.map(() => (m === 'Jan' ? 1000 : 0))), naturalSource: 'run', natural: null, scale: 1 }]
	});
	await createRun(page.request, id, 'Long record');
	await openRiver(page, id);
	const years = page.getByRole('region', { name: 'Days below the reserve, each water year' });
	await expect(years.getByRole('img', { name: /in 20 water years\.$/ })).toBeVisible();
	const reserve = page.getByRole('region', { name: /^Reserve compliance by month/ });
	await expect(reserve.getByRole('table', { name: /^Each month at the outlet/ }).locator('tbody tr')).toHaveCount(20);
	await expect(page.getByRole('region', { name: /^EWR compliance by month/ })).toBeVisible();
	expect(await innerScrollers(page)).toEqual([]);

	// The water-year table under the bars: all twenty rows in the page, the chart keeping its height beside it.
	const chartH = (await page.getByRole('region', { name: 'Flow vs reserve' }).boundingBox())!.height;
	await years.getByText('Show as a table').click();
	await expect(years.getByRole('table').locator('tbody tr')).toHaveCount(20);
	await expect(years.getByRole('table').locator('tbody tr').last()).toHaveText(/^2038\/39/);
	expect((await page.getByRole('region', { name: 'Flow vs reserve' }).boundingBox())!.height).toBeCloseTo(chartH, 0);
	expect(await innerScrollers(page)).toEqual([]);

	// Month by month: 240 rows would add seven screens, so the first 24, then all of them in place, and back.
	await reserve.getByText(/^Month by month \(240 months\)/).click();
	const each = reserve.getByRole('table', { name: /^Each complete month/ });
	await expect(each.locator('tbody tr')).toHaveCount(24);
	await expect(each.locator('tbody tr').first()).toHaveText(/^Oct 2019/);
	const more = reserve.getByRole('button', { name: 'Show all 240 months' });
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	await expect(more).toHaveAttribute('aria-controls', (await each.locator('xpath=..').getAttribute('id'))!);
	expect(await innerScrollers(page)).toEqual([]);
	await more.click();
	await expect(each.locator('tbody tr')).toHaveCount(240);
	await expect(each.locator('tbody tr').last()).toHaveText(/^Sep 2039/);
	const fewer = reserve.getByRole('button', { name: 'Show the first 24 months' });
	await expect(fewer).toHaveAttribute('aria-expanded', 'true');
	expect(await innerScrollers(page)).toEqual([]);
	await expectNoViolations(page);
	await fewer.click();
	await expect(each.locator('tbody tr')).toHaveCount(24);

	// On a phone: stacked, nothing scrolling inside itself or sideways.
	await page.setViewportSize({ width: 390, height: 844 });
	await openRiver(page, id);
	await expect(years.getByRole('img')).toBeVisible();
	await expect(page.getByRole('region', { name: /^EWR compliance by month/ })).toBeVisible();
	expect(await innerScrollers(page)).toEqual([]);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
