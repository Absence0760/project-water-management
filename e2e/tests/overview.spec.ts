// The Summary tab (id `overview`, issue #17): results and the setup checklist, built from the lists the project
// page loads (series, runs) and the model being edited. The headline facts, details and who has access moved to
// the Project page (project-page.spec.ts).
import type { Page } from '@playwright/test';
import { createProject, createRun, putModel, seedRunnableProject, updateSettings } from '../support/api.ts';
import { seedSupplyProject } from '../support/supply.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';

const setup = (page: Page) => page.getByRole('region', { name: /^Set(up| up this catchment)/ });
/** The Summary's sections have all loaded (or failed), so the page is at its final height: measure layout only after this. */
const summaryReady = (page: Page) => expect(page.getByTestId('summary-body')).toHaveAttribute('data-ready', 'true');
/** A run's daily dam_storage series (the Dam levels' fallback for a run older than engine 1.2.0). */
const DAM_SERIES = /\/runs\/[^/]+\/series\?key=dam_storage/;

test('a fresh project: nothing loaded, every step to do', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Overview empty');
	await page.goto(`/projects/${project.id}`);
	await expect(setup(page).getByRole('heading', { name: 'Set up this catchment' })).toBeVisible();
	await expect(setup(page)).toContainText('0 of 5 done');
	await expect(setup(page)).toContainText('Upload daily catchment rainfall (mm).');
	await expect(setup(page)).toContainText('Run it to get hydrological unit supply & deficit');
	// The model's facts are on the Project page, one link away.
	await expect(page.getByRole('heading', { level: 2, name: 'The model' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: /^Model facts, details, team and sharing\s+Project$/ })).toHaveAttribute('href', '?tab=project');
});

test('setup complete: the checklist leaves the page for a header pill whose popover lists the steps over the page', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Overview ready');
	await createRun(page.request, project.id, 'Baseline');
	for (const viewport of [
		{ width: 1440, height: 960 },
		{ width: 1280, height: 800 },
		{ width: 390, height: 844 }
	]) {
		await page.setViewportSize(viewport);
		await page.goto(`/projects/${project.id}`);
		await expect(page.getByRole('region', { name: 'Latest run', exact: true })).toBeVisible();
		// The page grows as the run's record, Supply by farm, the alerts and the baseline load: wait for all of them.
		await summaryReady(page);
		// No checklist panel on the page; the pill sits in the section header's status, before the rain pill.
		await expect(setup(page)).toHaveCount(0);
		const status = page.getByTestId('header-status');
		const pill = status.getByRole('button', { name: 'Setup complete' });
		await expect(pill).toHaveAttribute('aria-expanded', 'false');
		expect((await pill.boundingBox())!.height).toBeGreaterThanOrEqual(24);
		const height = () => page.evaluate(() => document.documentElement.scrollHeight);
		const before = await height();

		// Keyboard: focus it and open it; the five steps, each a link to its tab, over the page.
		await pill.focus();
		await page.keyboard.press('Enter');
		await expect(pill).toHaveAttribute('aria-expanded', 'true');
		const pop = page.locator(`#${await pill.getAttribute('aria-controls')}`);
		await expect(pop).toBeVisible();
		await expect(pop).toContainText('all 5 steps done');
		await expect(pop.getByRole('listitem')).toHaveCount(5);
		await expect(pop.getByRole('link')).toHaveText(['River network', 'Crops & irrigated areas', 'Rainfall & flow data', 'Evaporation, calibration & EWR', 'Run the model']);
		await expect(pop).toContainText('Rainfall and observed flow loaded.');
		await expect(pop).toContainText(/1 run, latest \d{4}-\d{2}-\d{2}\./);
		// Opening it never makes the page taller, and it stays inside the window.
		expect(await height()).toBe(before);
		const box = (await pop.boundingBox())!;
		expect(box.x, `${viewport.width}`).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width, `${viewport.width}`).toBeLessThanOrEqual(viewport.width);

		// Escape closes it and gives focus back to the pill.
		await page.keyboard.press('Escape');
		await expect(pop).toBeHidden();
		await expect(pill).toHaveAttribute('aria-expanded', 'false');
		await expect(pill).toBeFocused();

		// Opened again it lands where it did the first time (the nudge that keeps it inside the
		// window is measured from its own spot, not from wherever the last open left it).
		await page.keyboard.press('Enter');
		await expect(pop).toBeVisible();
		const again = (await pop.boundingBox())!;
		expect(again.x, `${viewport.width} reopened`).toBe(box.x);
		await page.keyboard.press('Escape');
		await expect(pop).toBeHidden();
	}

	// A click outside closes it; a step's link opens its tab.
	const pill = page.getByRole('button', { name: 'Setup complete' });
	await pill.click();
	const pop = page.locator(`#${await pill.getAttribute('aria-controls')}`);
	await expect(pop).toBeVisible();
	await expectNoViolations(page);
	await page.getByRole('heading', { level: 1, name: 'Summary' }).click();
	await expect(pop).toBeHidden();
	await pill.click();
	await pop.getByRole('link', { name: 'Rainfall & flow data' }).click();
	await expect(page).toHaveURL(/\?tab=series$/);
	// The pill is the Summary's alone.
	await expect(page.getByRole('button', { name: 'Setup complete' })).toHaveCount(0);
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
	// The seeded run ends on 28 Jan 2022, long past: the card names that day, not "today" (issue #162).
	await expect(card('Dams on 28 Jan 2022')).toContainText(/\d+%full/);
	await expect(card('Dams today')).toHaveCount(0);
	await expect(latest.locator('dl.stats > div')).toHaveCount(4);
	// Reserve · Irrigation supplied · Dams (on the run's last day) · NSE, in that order; the mean outflow is only on River & reserve
	// (river-page.spec.ts), with its change.
	await expect(latest.locator('dl.stats > div > dt')).toContainText(['EWR not met', 'Irrigation supplied', 'Dams on 28 Jan 2022', 'Calibration NSE']);
	await expect(latest.locator('[data-headline="outflow"]')).toHaveCount(0);
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
	// No run yet: the checklist is the first thing on the tab, and there is no KPI row or reserve strip.
	await expect(setup(page)).toBeVisible();
	const box = async (name: string | RegExp) => (await page.getByRole('region', { name, exact: typeof name === 'string' }).boundingBox())!;
	expect((await box(/^Set(up| up this catchment)/)).y).toBeLessThan((await box('Needs attention')).y);
	await expect(page.getByRole('region', { name: 'Days below the reserve' })).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Latest run', exact: true })).toHaveCount(0);

	await createRun(page.request, project.id, 'Baseline');
	await page.reload();
	// The reserve by month, not the flow chart: that is River & reserve's alone (issue #162).
	await expect(page.getByRole('region', { name: 'Days below the reserve' }).getByRole('listitem').first()).toBeVisible();
	await expect(page.getByRole('region', { name: 'Flow vs reserve' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Setup complete' })).toBeVisible();
	await expect(setup(page)).toHaveCount(0);
	// Each dam's level lives on the Dams page's cards, which the Dams today card and the sidebar open: no
	// third link to it here (issue #177).
	await expect(page.getByRole('link', { name: /^Dam levels for each dam/ })).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Dam levels' })).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Supply by hydrological unit' })).toBeVisible();
	// The bars' % says what it measures.
	await expect(page.getByTestId('supply-bars-what')).toHaveText("Share of each hydrological unit's irrigation demand supplied, latest run");

	// First screen (issue #17 A1, #162): the KPI row, the reserve strip across the page under it, then Needs
	// attention with the active alerts under it, beside Supply by unit (the flow chart that was here is River &
	// reserve's alone).
	await summaryReady(page);
	const kpis = await box('Latest run');
	const strip = await box('Days below the reserve');
	const attention = await box('Needs attention');
	const supply = await box('Supply by hydrological unit');
	const alerts = await box('Active alerts');
	expect(strip.y).toBeGreaterThan(kpis.y + kpis.height - 1);
	expect(Math.abs(strip.width - kpis.width)).toBeLessThan(2);
	expect(attention.y).toBeGreaterThan(strip.y + strip.height - 1);
	expect(Math.round(supply.y)).toBe(Math.round(attention.y));
	expect(supply.x).toBeGreaterThan(attention.x + attention.width);
	expect(alerts.y).toBeGreaterThan(attention.y + attention.height - 1);
	expect(Math.round(alerts.x)).toBe(Math.round(attention.x));
	// It flows with the page (the window's is the one scroll): the alerts start inside the window, and no
	// card is a scroll box of its own.
	expect(alerts.y).toBeLessThan(page.viewportSize()!.height);
	for (const name of ['Needs attention', 'Supply by hydrological unit', 'Active alerts']) {
		const [sh, ch] = await page.getByRole('region', { name, exact: true }).evaluate((el) => [el.scrollHeight, el.clientHeight]);
		expect(sh, name).toBeLessThanOrEqual(ch);
	}

	// Under Supply by unit, in its column (usually the shorter): the published baseline, then the link to the
	// Project page. Nothing else: the rest is on the Project page, and a complete setup is the header's pill.
	await expect(page.getByRole('region', { name: 'Published baseline' })).toHaveAttribute('aria-busy', 'false');
	const baseline = await box('Published baseline');
	expect(baseline.y).toBeGreaterThan(supply.y + supply.height - 1);
	expect(Math.round(baseline.x)).toBe(Math.round(supply.x));
	expect(Math.abs(baseline.width - supply.width)).toBeLessThan(2);
	const projectLink = page.getByRole('link', { name: /^Model facts, details, team and sharing\s+Project$/ });
	const links = (await projectLink.boundingBox())!;
	expect(links.y).toBeGreaterThan(baseline.y + baseline.height);
	expect(Math.round(links.x)).toBe(Math.round(supply.x));
	// So the whole Summary fits a 1440 × 960 window: no page scroll.
	expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(960);
	await expect(page.getByRole('heading', { level: 2, name: 'The model' })).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Members' })).toHaveCount(0);

	// ?tab=summary is the same page.
	await page.goto(`/projects/${project.id}?tab=summary`);
	await expect(page.getByRole('region', { name: 'Latest run', exact: true })).toBeVisible();
});

test('the reserve strip: the days below the EWR in each month of the run, adding up to the KPI card, and a link to River & reserve', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Summary reserve strip');
	const run = await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}`);
	const strip = page.getByRole('region', { name: 'Days below the reserve' });
	// The run is 120 days (1 Oct 2021 – 28 Jan 2022): its four months, each in words for a screen reader.
	await expect(strip.getByTestId('reserve-strip-what')).toHaveText(
		'Days each month the outflow was below the pragmatic EWR (EWR not met), the run’s last 4 months: Oct 2021 – Jan 2022'
	);
	const months = strip.getByRole('listitem');
	await expect(months).toHaveCount(4);
	await expect(months.nth(3)).toHaveAttribute('data-month', '2022-01');
	await expect(months.nth(3)).toContainText(/^Jan 2022: (EWR met every day \(28 days\)|below the EWR on \d+ of 28 days)/);
	// The months add up to the KPI card's count: the same test, one framing ("EWR not met", issue #162).
	const counts = await months.evaluateAll((lis) => lis.map((li) => Number(li.getAttribute('data-not-met'))));
	const card = page.getByRole('region', { name: 'Latest run', exact: true }).locator('[data-headline="ewr"]');
	await expect(card.locator('dt')).toContainText('EWR not met');
	const notMet = Number(/(\d+) of 120 days/.exec((await card.textContent()) ?? '')![1]);
	expect(counts.reduce((a, b) => a + b, 0)).toBe(notMet);
	// Each bar in the EWR traffic light's band for its month (the portfolio's: under 5 % of days green, under 20 % amber),
	// stated in a key under the months.
	const days = [31, 30, 31, 28];
	const bands = await months.evaluateAll((lis) => lis.map((li) => li.getAttribute('data-band')));
	expect(bands).toEqual(counts.map((n, i) => (n * 100 < 5 * days[i]! ? 'green' : n * 100 < 20 * days[i]! ? 'amber' : 'red')));
	await expect(strip.getByTestId('reserve-strip-key').locator('.item')).toHaveText(['Green: under 5% of days below the EWR', 'Amber: 5% to under 20%', 'Red: 20% or more']);

	await strip.getByRole('link', { name: 'More on River & reserve' }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]tab=river&run=${run}$`));
	await expect(page.getByRole('region', { name: 'Flow vs reserve' }).locator('figure.chart')).toHaveAttribute('data-ready', 'true');
});

test('with a Reserve rule table the card judges the Reserve by the table, and the strip is named for the test it counts, the pragmatic EWR', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Summary strip with rules');
	// A synthetic table that asks for nothing: the Reserve rules card is the table's, not the pragmatic EWR's.
	const points = [10, 20, 30, 40, 50, 60, 70, 80, 90, 99];
	await updateSettings(page.request, project.id, {
		ewrRules: [
			{ siteNodeId: null, source: 'Synthetic rule table for tests', component: 'total', unit: 'mcm', points, ewr: Array.from({ length: 12 }, () => points.map(() => 0)), naturalSource: 'run', natural: null, scale: 1 }
		]
	});
	await createRun(page.request, project.id, 'With rules');
	await page.goto(`/projects/${project.id}`);
	const kpis = page.getByRole('region', { name: 'Latest run', exact: true });
	await expect(kpis.locator('[data-headline="reserve"] dt')).toContainText('Reserve rules met');
	await expect(kpis.locator('[data-headline="ewr"]')).toHaveCount(0);
	// No "Days below the reserve": that would call the pragmatic count the Reserve the card beside it judges.
	await expect(page.getByRole('region', { name: 'Days below the reserve' })).toHaveCount(0);
	const strip = page.getByRole('region', { name: 'Days below the pragmatic EWR' });
	await expect(strip.getByRole('list', { name: 'Days below the pragmatic EWR by month, Oct 2021 – Jan 2022' })).toBeVisible();
	await expect(strip.getByTestId('reserve-strip-what')).toHaveText(
		'Days each month the outflow was below the pragmatic EWR (EWR not met), the run’s last 4 months: Oct 2021 – Jan 2022. The Reserve rules card above judges whole months by the rule table instead.'
	);
	await expect(strip.getByRole('listitem').nth(3)).toContainText(/^Jan 2022: (pragmatic EWR met every day \(28 days\)|below the pragmatic EWR on \d+ of 28 days)/);
	await expectNoViolations(page);
});

test('needs attention cards and supply by hydrological unit: coloured by how much it matters, each hydrological unit opens its drawer, and a link to Hydrological units', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Summary side column');
	// Plant far more on Lower farm than its water can serve, so it comes up short.
	const model = { ...project.model, cropAreas: project.model.cropAreas.map((a, i) => (i === 1 ? { ...a, areaM2: 3_000_000 } : a)) };
	await putModel(page.request, project.id, model);
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}`);

	// The short unit is the Irrigation supplied card's sub-line and Supply by unit's first row, not a Needs
	// attention card as well (issue #177); the stale rain still is one.
	const attention = page.getByRole('region', { name: 'Needs attention', exact: true });
	await expect(attention.locator('[data-attention="stale-data"]')).toHaveAttribute('data-tone', 'warning');
	await expect(attention.locator('[data-attention]')).toHaveCount(2);
	expect(await attention.locator('[data-attention]').evaluateAll((lis) => lis.map((li) => li.getAttribute('data-attention')))).toEqual(['run-warnings', 'stale-data']);
	await expect(attention).not.toContainText('below 95%');
	await expect(page.getByRole('region', { name: 'Latest run', exact: true }).locator('[data-headline="supply"]')).toContainText('1 of 2 hydrological units below 95%');

	const supply = page.getByRole('region', { name: 'Supply by hydrological unit' });
	const rows = supply.getByRole('listitem');
	await expect(rows).toHaveCount(2);
	// Emptiest first (the card shows the first eight), in the Network's supply bands, with a key to them.
	await expect(rows.first()).toContainText('Lower farm');
	await expect(rows.last()).toContainText('Upper farm');
	await expect(rows.first()).toHaveAttribute('data-band', /^(short|low)$/);
	const pcts = await rows.evaluateAll((lis) => lis.map((li) => parseFloat(li.querySelector('.pct')!.textContent!)));
	expect(pcts[0]!).toBeLessThan(pcts[1]!);
	// Two units: nothing to show all.
	await expect(supply.getByRole('button', { name: /^Show all/ })).toHaveCount(0);
	await expect(supply).toContainText(/supplied/);
	// The whole picture is on Units & supply, for the same run (issue #17).
	await expect(supply.getByRole('link', { name: 'More on Hydrological units' })).toHaveAttribute('href', /^\?tab=supply&run=[0-9a-f-]{36}$/);

	// A farm's name opens its planted areas over the Summary.
	await rows.first().getByRole('link', { name: 'Lower farm' }).click();
	await expect(page).toHaveURL(new RegExp(`\\?farm=${project.model.nodes[2]!.id}$`));
	await expect(page.getByRole('dialog', { name: 'Lower farm: planted areas' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);

	// The whole card is the link: a click on its detail follows the main action (Add data for the stale rain).
	await attention.locator('[data-attention="stale-data"]').click({ position: { x: 16, y: 34 } });
	await expect(page).toHaveURL(/[?&]tab=series$/);
});

test('a catchment with many units: Supply by unit shows the eight emptiest and opens the rest in place, with no card scrolling inside itself', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedSupplyProject(page.request, 'Summary many units', 30);
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}`);
	const supply = page.getByRole('region', { name: 'Supply by hydrological unit' });
	const rows = supply.getByRole('listitem');
	await expect(rows).toHaveCount(8);
	await summaryReady(page);
	// The emptiest lead: the eight shown are no fuller than any hidden one.
	const shownPcts = await rows.evaluateAll((lis) => lis.map((li) => parseFloat(li.querySelector('.pct')!.textContent!)));
	expect([...shownPcts].sort((a, b) => a - b)).toEqual(shownPcts);
	const scrolls = async (name: string) =>
		page.getByRole('region', { name, exact: true }).evaluate((el) => [el.scrollHeight, el.clientHeight, getComputedStyle(el).overflowY]);
	for (const name of ['Needs attention', 'Supply by hydrological unit']) {
		const [sh, ch, overflow] = await scrolls(name);
		expect(sh, name).toBeLessThanOrEqual(ch as number);
		expect(overflow, name).toBe('visible');
	}
	// What follows Needs attention is on the first screen: the alerts' heading is inside the window.
	const alertsHeading = (await page.getByRole('heading', { level: 2, name: 'Active alerts' }).boundingBox())!;
	expect(alertsHeading.y + alertsHeading.height).toBeLessThanOrEqual(960);

	const all = supply.getByRole('button', { name: 'Show all 32 hydrological units' });
	await expect(all).toHaveAttribute('aria-expanded', 'false');
	await all.click();
	await expect(rows).toHaveCount(32);
	const fewer = supply.getByRole('button', { name: 'Show the 8 emptiest' });
	await expect(fewer).toHaveAttribute('aria-expanded', 'true');
	await expect(fewer).toBeFocused();
	const allPcts = await rows.evaluateAll((lis) => lis.map((li) => li.getAttribute('data-band') === 'none' ? Infinity : parseFloat(li.querySelector('.pct')!.textContent!)));
	expect(allPcts.slice(0, 8)).toEqual(shownPcts);
	expect(Math.min(...allPcts.slice(8))).toBeGreaterThanOrEqual(Math.max(...shownPcts));
	// Open, the card grows with the page rather than scrolling inside itself.
	const [sh, ch] = await scrolls('Supply by hydrological unit');
	expect(sh).toBeLessThanOrEqual(ch as number);
	await fewer.click();
	await expect(rows).toHaveCount(8);
	await expect(all).toHaveAttribute('aria-expanded', 'false');
	await expectNoViolations(page);
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
			await expect(page.getByRole('region', { name: 'Days below the reserve' }).getByRole('listitem').first()).toBeVisible();
			await expect(page.getByRole('region', { name: 'Latest run', exact: true }).locator('[data-headline="dams"]')).toContainText('full');
			await expect(page.getByRole('region', { name: 'Supply by hydrological unit' })).toBeVisible();
			if (label === 'phone') expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
			await expectNoViolations(page);
		});
	}
});

test('Dams today is every dam together, and the card opens the Dams page', async ({ page, owner }) => {
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
	await expect(today.getByRole('term')).toHaveText('Dams on 28 Jan 2022');
	await expect(today).toContainText(/in 30 days/);
	// Before the Dams page, whose sparklines and chart do read the series.
	expect(damSeries).toEqual([]);
	// The table moved to the Dams page (dams-page.spec.ts checks it, and that this figure is its capacity-weighted total).
	await expect(page.getByRole('region', { name: 'Dam levels' })).toHaveCount(0);
	// The card and the sidebar open the Dams page; the one-line link that did too went in issue #177.
	await expect(page.getByRole('link', { name: /^Dam levels for each dam/ })).toHaveCount(0);

	// The card is a link to the Dams page, from anywhere on it.
	await today.click({ position: { x: 20, y: 60 } });
	await expect(page).toHaveURL(/\?tab=dams$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Dams' })).toBeVisible();
	await page.goBack();
	await expect(today).toContainText('full');
	await expectNoViolations(page);
});

test('Dams today: a run from before the summary kept dam figures still shows it, from the daily series', async ({ page, owner, fetchRoute }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Summary dams, older run');
	await createRun(page.request, project.id, 'Baseline');
	// Strip the dam figures from the run's summary, as a run saved before engine 1.2.0 has none.
	await fetchRoute(page, /\/runs\/[0-9a-f-]+$/, async (route) => {
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
