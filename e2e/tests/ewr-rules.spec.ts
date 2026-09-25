// EWR compliance by the Reserve's assurance rules (engine 0.21.0, docs/model.md
// §2.9c): paste a rule table into Settings (its checks block Save), run the
// model, read monthly compliance in the headline and the Reserve compliance
// panel, and compare two runs. The table and catchment are synthetic: round,
// invented numbers.
import { AxeBuilder } from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';
import { copyProject, createProject, createRun, putModel, putSeries, sampleModel, syntheticFlow, syntheticRain, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

/** WCAG 2.2 A/AA scan from the top of the page (as wr2012.spec.ts does). */
async function expectNoViolations(page: Page) {
	await page.evaluate(() => window.scrollTo(0, 0));
	const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa']).analyze();
	expect(violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5) }))).toEqual([]);
}

const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
const POINTS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 99];

/** Three whole water years (Oct 2019 – Sep 2022) of the sample catchment: 36 complete months. */
async function seedThreeYears(request: APIRequestContext, name: string): Promise<string> {
	const project = await createProject(request, name);
	await putModel(request, project.id, sampleModel());
	await updateSettings(request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: [2000, 1500, 1000, 1000, 1000, 1500, 2500, 4000, 5000, 5000, 4000, 3000]
	});
	const days = 1096;
	await putSeries(request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2019-10-01', values: syntheticRain(days) });
	await putSeries(request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2019-10-01', values: syntheticFlow(days) });
	return project.id;
}

/**
 * A table that asks for nothing except in January, where it asks for far more
 * than the river carries: every month is met except the three Januaries.
 */
function janOnlyTable(janMm3: number) {
	return {
		siteNodeId: null,
		source: 'Synthetic rule table for tests',
		component: 'total',
		unit: 'mcm',
		points: POINTS,
		ewr: MONTHS.map((m) => POINTS.map(() => (m === 'Jan' ? janMm3 : 0))),
		naturalSource: 'run',
		natural: null,
		scale: 1
	};
}

test('a rule table pasted from a spreadsheet is checked, saved and reloaded', async ({ page, owner }) => {
	void owner;
	const id = await seedThreeYears(page.request, 'Reserve rules settings');
	await page.goto(`/projects/${id}?tab=settings`);

	const section = page.getByRole('region', { name: /^Reserve rule tables/ });
	const save = page.getByRole('button', { name: 'Save settings' });
	await expect(section.getByText('No rule table: runs report the days below the pragmatic EWR only.')).toBeVisible();
	await section.getByRole('button', { name: 'Add a rule table' }).click();

	const table = section.getByRole('group', { name: 'Rule table at Outlet (Outflow gauge)' });
	await expect(table.getByLabel('EWR site').locator('option:checked')).toHaveText('Outlet (Outflow gauge)');
	// A new table needs a source before it can be saved; the save bar links here.
	await expect(table.getByText('Say where the table comes from (Reserve determination, gazette notice, table).')).toBeVisible();
	await expect(save).toBeDisabled();
	await expect(page.getByRole('link', { name: 'Reserve rules: 1 rule table has a problem to fix.' })).toHaveAttribute('href', '#set-reserve');
	await table.getByLabel('Source').fill('Synthetic determination, table 1');

	// Paste a tab-separated table: a heading row of % points and month names in calendar order.
	const cal = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const row = (m: string) => POINTS.map((_, i) => ((12 - i) * (MONTHS.indexOf(m) + 1)) / 100).join('\t');
	const tsv = ['Month\t' + POINTS.map((p) => `${p}%`).join('\t'), ...cal.map((m) => `${m}\t${row(m)}`)].join('\n');
	await table.getByLabel('Paste from a spreadsheet').fill(tsv);
	await table.getByRole('button', { name: 'Fill the EWR values' }).click();
	await expect(table.getByRole('status')).toHaveText('Filled the EWR values: 12 months × 10 % points (rows matched by month name).');
	// Jan is the 4th water-year month: at 50 % (the 5th point) 8 × 4 / 100.
	await expect(table.getByLabel('EWR, Jan, 50 %, Mm³')).toHaveValue('0.32');
	await expect(table.getByLabel('EWR, Oct, 10 %, Mm³')).toHaveValue('0.12');

	// A paste that isn't 12 months says so and changes nothing.
	await table.getByLabel('Paste from a spreadsheet').fill('1\t2\t3');
	await table.getByRole('button', { name: 'Fill the EWR values' }).click();
	await expect(table.getByRole('status')).toHaveText('Expected 12 rows, one per month (Oct … Sep); the paste has 1.');
	await expect(table.getByLabel('EWR, Jan, 50 %, Mm³')).toHaveValue('0.32');

	// The natural flows from the table: a blank grid blocks Save until it is filled.
	await table.getByLabel('Natural-flow percentile from').selectOption('table');
	await expect(table.getByText('Natural flow values must be numbers from 0 to 1,000,000 (Oct has one that isn\'t).')).toBeVisible();
	await expect(save).toBeDisabled();
	// Back to the run's natural flow: the half-typed natural grid is dropped, so it no longer blocks Save.
	await table.getByLabel('Natural-flow percentile from').selectOption('run');
	await expect(table.getByRole('table', { name: /^Natural flow at each % point/ })).toHaveCount(0);
	await expect(save).toBeEnabled();
	await expectNoViolations(page);

	await save.click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
	await page.reload();
	await expect(table.getByLabel('Source')).toHaveValue('Synthetic determination, table 1');
	await expect(table.getByLabel('EWR, Jan, 50 %, Mm³')).toHaveValue('0.32');
	await expect(table.getByLabel('% points')).toHaveValue('10, 20, 30, 40, 50, 60, 70, 80, 90, 99');
	// Every EWR site now has a table (the sample network's only gauge is the outlet).
	await expect(section.getByRole('button', { name: 'Add a rule table' })).toBeDisabled();
});

test('a run reports monthly Reserve compliance in the headline and its own panel', async ({ page, owner }) => {
	void owner;
	const id = await seedThreeYears(page.request, 'Reserve rules run');
	await updateSettings(page.request, id, { ewrRules: [janOnlyTable(1000)] });
	await createRun(page.request, id, 'With rules');
	await page.goto(`/projects/${id}?tab=runs`);
	await expect(page.getByRole('heading', { level: 2, name: 'With rules' })).toBeVisible();

	// The headline: months met at the outlet first, days below the pragmatic EWR second.
	const summary = page.getByRole('region', { name: 'Run summary' });
	await expect(summary.getByText('Reserve rules met')).toBeVisible();
	await expect(summary.getByText('33 of 36 months at the outlet')).toBeVisible();
	await expect(summary.getByText('Days below the pragmatic EWR')).toBeVisible();

	await page.getByRole('navigation', { name: 'Result sections' }).getByRole('link', { name: 'Reserve compliance' }).click();
	const panel = page.getByRole('region', { name: /^Reserve compliance by month/ });
	await expect(panel.getByRole('status').filter({ hasText: 'Met in' })).toHaveText('Outlet (Outflow gauge): Met in 33 of 36 months (91.7%); not met in 3.');
	await expect(panel.getByText('Source: Synthetic rule table for tests')).toBeVisible();
	// Three years of each month: the run says the percentiles rest on few years.
	await expect(panel.getByText(/only 3 complete years in the run \(fewer than 10\)/)).toBeVisible();
	const byMonth = panel.getByRole('table', { name: /^By month of the year/ });
	await expect(byMonth.getByRole('row', { name: /^Jan 3 0 0%/ })).toBeVisible();
	await expect(byMonth.getByRole('row', { name: /^Feb 3 3 100%/ })).toBeVisible();
	await panel.getByText(/^Month by month/).click();
	const each = panel.getByRole('table', { name: /^Each complete month/ });
	await expect(each.getByRole('row')).toHaveCount(37);
	await expect(each.getByRole('row', { name: /^Jan 2020 .* not met$/ })).toBeVisible();
	await expectNoViolations(page);
	// The run's warnings say the same about the short record.
	await expect(page.getByRole('status').filter({ hasText: /warnings? from this run/ })).toContainText('EWR rule table at the outlet (Outflow gauge)');
});

test('run comparison compares Reserve compliance and lists the rule-table change', async ({ page, owner }) => {
	void owner;
	const id = await seedThreeYears(page.request, 'Reserve rules baseline');
	await updateSettings(page.request, id, { ewrRules: [janOnlyTable(1000)] });
	const before = await createRun(page.request, id, 'Jan asks for a lot');
	const copy = await copyProject(page.request, id, 'Reserve rules copy');
	await updateSettings(page.request, copy, { ewrRules: [janOnlyTable(0)] });
	const after = await createRun(page.request, copy, 'Jan asks for nothing');

	await page.goto(`/compare?a=${id}:${before}&b=${copy}:${after}`);
	await expect(page.getByRole('heading', { name: 'Headline results' })).toBeVisible();
	await expect(page.getByText('EWR rule table at the outlet: EWR values changed in Jan')).toBeVisible();
	const section = page.getByRole('region', { name: 'Reserve compliance by month' });
	await expect(section.getByText('The two runs used different rule tables here, so the rates measure against different rules.')).toBeVisible();
	const table = section.getByRole('table', { name: /^Reserve compliance at Outlet/ });
	await expect(table.getByRole('row', { name: /^Months not met 3 0/ })).toBeVisible();
	const months = section.getByRole('table', { name: /^Share of months met per month of the year/ });
	await expect(months.getByRole('row', { name: /^Jan 0% 100%/ })).toBeVisible();
});
