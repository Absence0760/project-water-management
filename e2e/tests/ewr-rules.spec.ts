// EWR compliance by the Reserve's assurance rules (engine 0.21.0, docs/model.md
// §2.9c): paste a rule table into Settings (its checks block Save), run the
// model, read monthly compliance in the headline and the Reserve compliance
// panel, and compare two runs. The table and catchment are synthetic: round,
// invented numbers.
import type { APIRequestContext } from '@playwright/test';
import { copyProject, createProject, createRun, putModel, putSeries, sampleModel, syntheticFlow, syntheticRain, updateSettings } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';
import { whatChanged } from '../support/compare.ts';
import { answerConfirm } from '../support/confirm.ts';
import { saveChanges, saveSettings } from '../support/settings.ts';

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
	const save = saveChanges(page);
	await expect(section.getByText('No rule table: runs report the days below the pragmatic EWR only.')).toBeVisible();
	await section.getByRole('button', { name: 'Add a rule table' }).click();

	const table = section.getByRole('group', { name: 'Rule table at Outlet (Outflow gauge)' });
	await expect(table.getByLabel('EWR site').locator('option:checked')).toHaveText('Outlet (Outflow gauge)');
	// A new table needs a source before it can be saved; the save bar links here.
	await expect(table.getByText('Say where the table comes from (Reserve determination, gazette notice, table).')).toBeVisible();
	await expect(save).toBeDisabled();
	await expect(page.getByRole('link', { name: 'Reserve rule tables: 1 rule table has a problem to fix.' })).toHaveAttribute('href', '#set-reserve');
	await table.getByLabel('Source', { exact: true }).fill('Synthetic determination, table 1');
	// The REC (ER9): a band of two classes that aren't neighbours blocks Save; the typed text is upper-cased.
	const rec = table.getByLabel('Recommended ecological category (REC)');
	await rec.fill('b/d');
	await expect(table.getByText('The REC is one category A to F, or a band of two neighbouring ones such as B/C, or left blank.')).toBeVisible();
	await expect(save).toBeDisabled();
	await rec.fill('b/c');
	await expect(rec).toHaveValue('B/C');
	await expect(save).toBeEnabled();

	// Paste a tab-separated table: a heading row of % points and month names in calendar order.
	const cal = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const row = (m: string) => POINTS.map((_, i) => ((12 - i) * (MONTHS.indexOf(m) + 1)) / 100).join('\t');
	const tsv = ['Month\t' + POINTS.map((p) => `${p}%`).join('\t'), ...cal.map((m) => `${m}\t${row(m)}`)].join('\n');
	await table.getByLabel('Paste from a spreadsheet').fill(tsv);
	await table.getByRole('button', { name: 'Fill the EWR values' }).click();
	await expect(table.getByRole('status', { name: 'Paste result', exact: true })).toHaveText('Filled the EWR values: 12 months × 10 % points (rows matched by month name).');
	// Jan is the 4th water-year month: at 50 % (the 5th point) 8 × 4 / 100.
	await expect(table.getByLabel('EWR, Jan, 50 %, Mm³')).toHaveValue('0.32');
	await expect(table.getByLabel('EWR, Oct, 10 %, Mm³')).toHaveValue('0.12');

	// A paste that isn't 12 months says so and changes nothing.
	await table.getByLabel('Paste from a spreadsheet').fill('1\t2\t3');
	await table.getByRole('button', { name: 'Fill the EWR values' }).click();
	await expect(table.getByRole('status', { name: 'Paste result', exact: true })).toHaveText('Expected 12 rows, one per month (Oct … Sep); the paste has 1.');
	await expect(table.getByLabel('EWR, Jan, 50 %, Mm³')).toHaveValue('0.32');

	// The natural flows from the table: a blank grid blocks Save until it is filled.
	await table.getByLabel('Natural-flow percentile from').selectOption('table');
	await expect(table.getByText('Natural flow values must be numbers from 0 to 1\u202f000\u202f000 (Oct has one that isn\'t).')).toBeVisible();
	await expect(save).toBeDisabled();
	// Back to the run's natural flow: the half-typed natural grid is dropped, so it no longer blocks Save.
	await table.getByLabel('Natural-flow percentile from').selectOption('run');
	await expect(table.getByRole('table', { name: /^Natural flow at each % point/ })).toHaveCount(0);
	await expect(save).toBeEnabled();
	await expectNoViolations(page);

	await saveSettings(page);
	await page.reload();
	await expect(table.getByLabel('Source', { exact: true })).toHaveValue('Synthetic determination, table 1');
	await expect(table.getByLabel('Recommended ecological category (REC)')).toHaveValue('B/C');
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
	// The plain-words summary above the cards leads with the same measure.
	await expect(summary.getByText(/^The Reserve rules were met in 91\.7% of months at the outlet \(33 of 36\)\./)).toBeVisible();
	await expect(summary.getByText('Days below the pragmatic EWR')).toBeVisible();

	// "by month of the year" opens the panel, on River & reserve for this run (issue #17).
	await summary.getByRole('link', { name: 'by month of the year' }).click();
	await expect(page).toHaveURL(/[?&]tab=river&run=[^#]+#res-reserve$/);
	const panel = page.getByRole('region', { name: /^Reserve rules met, by month/ });
	await expect(panel.getByRole('heading', { name: /^Reserve rules met, by month/ })).toBeFocused();
	await expect(panel.getByRole('status').filter({ hasText: 'Met in' })).toHaveText('Outlet (Outflow gauge): Met in 33 of 36 months (91.7%); not met in 3.');
	await expect(panel.getByText('Source: Synthetic rule table for tests')).toBeVisible();
	// Three years of each month: the run says the percentiles rest on few years.
	await expect(panel.getByText(/only 3 complete years in the run \(fewer than 10\)/)).toBeVisible();
	const byMonth = panel.getByRole('table', { name: /^By month of the year/ });
	await expect(byMonth.getByRole('row', { name: /^Jan 3 0 0%/ })).toBeVisible();
	await expect(byMonth.getByRole('row', { name: /^Feb 3 3 100%/ })).toBeVisible();
	await panel.getByText(/^Month by month/).click();
	const each = panel.getByRole('table', { name: /^Each complete month/ });
	// The first two years, then the rest in place (the table grows with the page; it never scrolls in a box).
	await expect(each.getByRole('row')).toHaveCount(25);
	await expect(each.getByRole('row', { name: /^Jan 2020 .* not met$/ })).toBeVisible();
	await panel.getByRole('button', { name: 'Show all 36 months' }).click();
	await expect(each.getByRole('row')).toHaveCount(37);
	await expect(each.getByRole('row', { name: /^Jan 2022 .* not met$/ })).toBeVisible();
	// The flow chart draws the rule requirement the headline is judged by, beside the pragmatic EWR (issue #51).
	const flowFig = page.getByRole('region', { name: 'Flow vs reserve' }).locator('figure.chart');
	const legend = (name: string) => flowFig.locator('.u-legend tr.u-series', { has: page.locator('.u-label', { hasText: new RegExp(`^${name}`) }) });
	await expect(legend('Reserve rule requirement')).toHaveCount(1);
	await expect(legend('Pragmatic EWR')).toHaveCount(1);
	await expect(flowFig).toContainText('The Reserve rule requirement line is each month’s requirement from the rule table');
	await expectNoViolations(page);
	// The run's warnings, back on Runs & results, say the same about the short record.
	await page.goBack();
	await expect(page.getByRole('status').filter({ hasText: /to check before relying on this run/ })).toContainText('EWR rule table at the outlet (Outflow gauge)');
});

test('low flows and a freshet are entered by paste, saved and reloaded (engine 0.33.0)', async ({ page, owner }) => {
	void owner;
	const id = await seedThreeYears(page.request, 'Reserve low and high flows settings');
	await updateSettings(page.request, id, { ewrRules: [janOnlyTable(0)] });
	await page.goto(`/projects/${id}?tab=settings`);
	const section = page.getByRole('region', { name: /^Reserve rule tables/ });
	const save = saveChanges(page);
	const table = section.getByRole('group', { name: 'Rule table at Outlet (Outflow gauge)' });

	// Splitting out the low flows adds a blank grid that blocks Save until it is filled.
	await table.getByRole('checkbox', { name: /^Also enter the low flows/ }).check();
	await expect(table.getByText("Low-flow values must be numbers from 0 to 1\u202f000\u202f000 (Oct has one that isn't).")).toBeVisible();
	await expect(save).toBeDisabled();
	const csv = ['Month,' + POINTS.map((p) => `${p}%`).join(','), ...MONTHS.map((m) => `${m},${POINTS.map(() => '0').join(',')}`)].join('\n');
	await table.getByLabel('Paste from a spreadsheet').fill(csv);
	await table.getByRole('button', { name: 'Fill the low flows' }).click();
	await expect(table.getByRole('status', { name: 'Paste result', exact: true })).toHaveText('Filled the low-flow values: 12 months × 10 % points (rows matched by month name).');

	// A freshet pasted as CSV, heading row and all.
	const high = table.getByRole('group', { name: 'High flows: freshets and floods' });
	await high.getByLabel('Paste high flows').fill('Name,Months,Peak (m3/s),Duration (days),Events per year\nSynthetic freshet,Nov-Jan,0.2,2,1');
	await high.getByRole('button', { name: 'Fill the high flows' }).click();
	await expect(high.getByRole('status', { name: 'High-flow paste result' })).toHaveText('Filled 1 high-flow component.');
	await expect(high.getByLabel('High flow 1 name')).toHaveValue('Synthetic freshet');
	await expect(high.getByLabel('High flow 1 months it may peak in')).toHaveValue('Nov–Jan');
	await expect(save).toBeEnabled();
	await expectNoViolations(page);

	await saveSettings(page);
	await page.reload();
	await expect(table.getByLabel('Low flows (maintenance to drought), Jan, 50 %, Mm³')).toHaveValue('0');
	await expect(high.getByLabel('High flow 1 daily-mean peak, m³/s')).toHaveValue('0.2');
});

test('two EWR sites each get a Reserve heat map, low flows and high flows (engine 0.33.0)', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Reserve two sites');
	// The sample catchment with a second gauge below the upper farm: two EWR sites.
	const model = sampleModel();
	const outlet = model.nodes[0]!;
	const upperGauge = { ...outlet, id: crypto.randomUUID(), name: 'Upper gauge', downstreamNodeId: outlet.id, sortOrder: 4 };
	model.nodes[1]!.downstreamNodeId = upperGauge.id;
	model.nodes.push(upperGauge);
	await putModel(page.request, project.id, model);
	const days = 1096;
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2019-10-01', values: syntheticRain(days) });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2019-10-01', values: syntheticFlow(days) });
	const withParts = (siteNodeId: string | null) => ({
		...janOnlyTable(1000),
		siteNodeId,
		lowFlow: MONTHS.map(() => POINTS.map(() => 0)),
		highFlows: [{ label: 'Synthetic freshet', months: [11, 12, 1], peakM3s: 0.01, durationDays: 1, perYear: 1 }]
	});
	await updateSettings(page.request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrRules: [withParts(null), withParts(upperGauge.id)]
	});
	await createRun(page.request, project.id, 'Two sites');
	await page.goto(`/projects/${project.id}?tab=river`);
	const panel = page.getByRole('region', { name: /^Reserve rules met, by month/ });
	const site = panel.getByLabel('EWR site');
	await expect(site.locator('option')).toHaveText(['Outlet (Outflow gauge)', 'Upper gauge']);

	for (const name of ['Outlet (Outflow gauge)', 'Upper gauge']) {
		await site.selectOption({ label: name });
		// Januaries ask for far more than the river carries, but the low flows (0) are met: only the high flows fail.
		const heat = panel.getByRole('table', { name: /^Each month at / });
		await expect(heat.getByRole('row')).toHaveCount(4);
		await expect(heat.getByRole('cell', { name: 'Jan 2020: low flows met, high flows not met', exact: false })).toBeVisible();
		await expect(panel.getByText('Low flows met', { exact: true })).toBeVisible();
		await expect(panel.getByRole('table', { name: /^High flows: freshets and floods/ }).getByRole('row', { name: /^Synthetic freshet/ })).toBeVisible();
	}
	await expectNoViolations(page);
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
	await expect(whatChanged(page).getByText('EWR rule table at the outlet: EWR values changed in Jan')).toBeVisible();
	const section = page.getByRole('region', { name: 'Reserve compliance by month' });
	await expect(section.getByText('The two runs used different rule tables here, so the rates measure against different rules.')).toBeVisible();
	const table = section.getByRole('table', { name: /^Reserve compliance at Outlet/ });
	await expect(table.getByRole('row', { name: /^Months not met 3 0/ })).toBeVisible();
	const months = section.getByRole('table', { name: /^Share of months met per month of the year/ });
	await expect(months.getByRole('row', { name: /^Jan 0% 100%/ })).toBeVisible();
});

test('Add a rule table sits above the tables; removing a table, or filling over typed values, asks first', async ({ page, owner }) => {
	void owner;
	const id = await seedThreeYears(page.request, 'Reserve rules asks');
	await updateSettings(page.request, id, {
		ewrRules: [{ ...janOnlyTable(2), highFlows: [{ label: 'Synthetic freshet', months: [11, 12, 1], peakM3s: 0.2, durationDays: 2, perYear: 1 }] }]
	});
	await page.goto(`/projects/${id}?tab=settings`);
	const section = page.getByRole('region', { name: /^Reserve rule tables/ });
	const table = section.getByRole('group', { name: 'Rule table at Outlet (Outflow gauge)' });
	await expect(table).toBeVisible();
	// The "new" action is above the first table (in the panel head), not screens down under them.
	const add = (await section.getByRole('button', { name: 'Add a rule table' }).boundingBox())!;
	expect(add.y).toBeLessThan((await table.boundingBox())!.y);
	// The high flows' caption is hidden text, not a repeat of the legend on screen.
	const caption = (await table.locator('caption', { hasText: 'High-flow components at' }).boundingBox())!;
	expect(caption.width * caption.height).toBeLessThanOrEqual(1);

	// Fill over a grid that holds values: asked, naming how many; Cancel keeps them.
	const csv = ['Month,' + POINTS.map((p) => `${p}%`).join(','), ...MONTHS.map((m) => `${m},${POINTS.map(() => '5').join(',')}`)].join('\n');
	await table.getByLabel('Paste from a spreadsheet').fill(csv);
	await table.getByRole('button', { name: 'Fill the EWR values' }).click();
	await answerConfirm(page, false, 'The 10 values in the grid will be replaced by the pasted ones.');
	await expect(table.getByLabel('EWR, Jan, 50 %, Mm³')).toHaveValue('2');
	// The same for the high flows.
	const high = table.getByRole('group', { name: 'High flows: freshets and floods' });
	await high.getByLabel('Paste high flows').fill('Other freshet,Oct,0.5,1,1');
	await high.getByRole('button', { name: 'Fill the high flows' }).click();
	await answerConfirm(page, false, 'The 1 component listed will be replaced by the 1 filled in.');
	await expect(high.getByLabel('High flow 1 name')).toHaveValue('Synthetic freshet');

	// Months that don't read are said under their field, block the save, and are listed in the save bar.
	const months = high.getByLabel('High flow 1 months it may peak in');
	await months.fill('Smarch');
	await expect(months).toHaveAccessibleDescription('Enter the months as names or numbers, e.g. Nov-Jan or Nov Dec Jan.');
	await expect(saveChanges(page)).toBeDisabled();
	await expect(page.getByRole('region', { name: /^Unsaved / }).getByRole('link', { name: /^High flow 1 months it may peak in: Enter the months/ })).toBeVisible();
	await months.fill('Nov-Jan');
	await expect(months).not.toHaveAttribute('aria-invalid', 'true');

	// Remove the table: asked; Cancel keeps it, Remove the table removes it.
	await table.getByRole('button', { name: 'Remove the rule table at Outlet (Outflow gauge)' }).click();
	await answerConfirm(page, false, 'Remove the rule table at Outlet (Outflow gauge)?');
	await expect(table).toBeVisible();
	await table.getByRole('button', { name: 'Remove the rule table at Outlet (Outflow gauge)' }).click();
	await answerConfirm(page, true, 'Its EWR grid, 1 high-flow component and source go with it.');
	await expect(table).toHaveCount(0);
});

test('the EWR results are judged by is chosen first thing in Settings, and the headline follows without a re-run (issue #444)', async ({ page, owner }) => {
	void owner;
	const id = await seedThreeYears(page.request, 'Judge results by');
	await updateSettings(page.request, id, { ewrRules: [janOnlyTable(1000)] });
	const runId = await createRun(page.request, id, 'Judged');
	// The printed report says what it is judged by, and that it is the project's setting at printing.
	await page.goto(`/projects/${id}/report?run=${runId}`);
	const printed = page.getByTestId('report-judged-by');
	await expect(printed).toHaveText(
		'Results are judged by the Reserve rule table at the outlet, Outflow gauge (automatic), the project’s setting when this report was printed.'
	);

	// Automatic: the outlet's rule table heads the Summary, and River & reserve says so at the top.
	await page.goto(`/projects/${id}?tab=overview`);
	const latest = page.getByRole('region', { name: 'Latest run' });
	await expect(latest.getByText('Reserve rules met')).toBeVisible();
	await page.goto(`/projects/${id}?tab=river`);
	const judged = page.getByTestId('river-judged-by');
	await expect(judged).toHaveText(/^Results are judged by the Reserve rule table at the outlet, Outflow gauge \(automatic\)\. Change$/);
	// The EWR by month heat map counts days below the pragmatic EWR, and says that isn't the test the results are judged by.
	const heatNote = page.locator('#res-ewr-grid .ewr-heatmap p.note');
	await expect(heatNote).toContainText(
		'A day counts when simulated outflow at the outlet is below the pragmatic EWR. These bands count days below the pragmatic EWR; the results are judged by the Reserve rule table at the outlet, Outflow gauge (automatic) instead.'
	);
	await judged.getByRole('link', { name: 'Change' }).click();
	await expect(page).toHaveURL(/[?&]tab=settings#set-judge$/);

	// The picker is the page's first panel, and lists only what exists.
	await expect(page.locator('.settings-form > .panel').first()).toHaveAttribute('id', 'set-judge');
	const pick = page.getByRole('combobox', { name: 'Judge results by' });
	await expect(pick.locator('option')).toHaveText([
		'Automatic: now the Reserve rule table at the outlet, Outflow gauge',
		'The pragmatic EWR at the outflow gauge',
		'The Reserve rule table at the outlet, Outflow gauge'
	]);
	// Automatic judges by the rule table while the charge follows the pragmatic EWR (its default): said under the select.
	await expect(page.getByTestId('judge-charge-note')).toContainText('follow the pragmatic EWR');
	await pick.selectOption({ label: 'The pragmatic EWR at the outflow gauge' });
	// Now both follow the pragmatic EWR: no note.
	await expect(page.getByTestId('judge-charge-note')).toHaveCount(0);
	await saveSettings(page);

	// The same run, now headed by the pragmatic EWR: Summary, Runs & results and River & reserve.
	await page.goto(`/projects/${id}?tab=overview`);
	await expect(latest.getByText('EWR not met')).toBeVisible();
	await expect(latest.getByText('Reserve rules met')).toHaveCount(0);
	await page.goto(`/projects/${id}?tab=runs`);
	const summary = page.getByRole('region', { name: 'Run summary' });
	await expect(summary.getByText(/^Flow at the outflow gauge was below the EWR on/)).toBeVisible();
	await expect(summary.getByText('Reserve rules met')).toHaveCount(0);
	await page.goto(`/projects/${id}?tab=river`);
	await expect(judged).toHaveText(/^Results are judged by the pragmatic EWR at the outflow gauge\. Change$/);
	// The heat map's test is now the headline's own: no clause.
	await expect(heatNote).toContainText('A day counts when simulated outflow at the outlet is below the pragmatic EWR.');
	await expect(heatNote).not.toContainText('the results are judged by');
	// The same run printed again follows the new choice, and says so.
	await page.goto(`/projects/${id}/report?run=${runId}`);
	await expect(printed).toHaveText('Results are judged by the pragmatic EWR at the outflow gauge, the project’s setting when this report was printed.');
	await page.goto(`/projects/${id}?tab=river`);
	// Reserve compliance keeps its panel: the table is still assessed, it just doesn't head the results.
	await expect(page.getByRole('region', { name: /^Reserve rules met, by month/ })).toBeVisible();
	await expect(page.getByRole('heading', { level: 2, name: 'Days below the reserve, each water year' })).toBeVisible();

	// The outlet's table chosen, then the table removed: Settings says the choice can't be
	// followed, and River & reserve says the run is judged automatically.
	await updateSettings(page.request, id, { ewrHeadline: { source: 'ruleTable', siteNodeId: null } });
	await createRun(page.request, id, 'Before removal');
	await updateSettings(page.request, id, { ewrRules: [] });
	await page.goto(`/projects/${id}?tab=settings#set-judge`);
	await expect(page.getByTestId('judge-problem')).toContainText('no Reserve rule table any more, so results are judged automatically');
	await createRun(page.request, id, 'After removal');
	await page.goto(`/projects/${id}?tab=river`);
	await expect(judged).toContainText('This run has no Reserve rule table at the chosen site, so it is judged automatically.');
	await expect(judged).toContainText('Results are judged by the pragmatic EWR at the outflow gauge.');
});
