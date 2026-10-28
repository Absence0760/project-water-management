// Runs & results as a page (issue #17, docs/ui.md § Runs & results): the run
// form in the section header, the runs rail beside the shown run and fitting
// the window, the river and unit pages one link away from the run header,
// the old link rows' anchors sent on, a viewer's page, and a11y at desktop
// and phone. runs.spec.ts covers the results themselves.
import { addMember, createProject, createRun, seedRunnableProject } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { pinClockToProject } from '../support/clock.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { seedRiverProject } from '../support/river.ts';
import { LONG_LABEL, openCalibration, openRuns, runsList, seedManyRuns } from '../support/runs.ts';

const header = (page: import('@playwright/test').Page) => page.getByTestId('section-header');

test('the run form sits in the section header, last, with its status one slim line under it', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Runs header');
	await page.goto(`/projects/${project.id}?tab=runs`);
	const h = header(page);
	await expect(h.getByTestId('section-context')).toHaveText('No runs yet');
	await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

	// The tab's own run form takes the header Run model's place here: last, one row with the title; no Add data (issue #601).
	await expect(h.getByRole('button')).toHaveText(['Run model']);
	const title = (await h.getByRole('heading', { level: 1 }).boundingBox())!;
	const run = h.getByRole('button', { name: 'Run model' });
	const box = (await run.boundingBox())!;
	expect(box.y).toBeLessThan(title.y + title.height + 30);
	await expect(run).toHaveAccessibleDescription('Runs use the saved network, crops, transfers, settings and time series.');
	const status = page.locator('#run-note');
	expect((await status.boundingBox())!.height).toBeLessThan(30);

	// A run from the header: listed, shown, and counted in the header's line.
	await h.getByLabel(/^Run label/).fill('From the header');
	await run.click();
	await expect(runsList(page).getByRole('button', { name: /^From the header/ })).toHaveAttribute('aria-current', 'true');
	await expect(page.getByRole('heading', { level: 2, name: 'From the header' })).toBeVisible();
	await expect(h.getByTestId('section-context')).toContainText('1 run · newest ran ');
	await expect(h.getByLabel(/^Run label/)).toHaveValue('');
	// Its day word on the run's own day (support/clock.ts): pinned, then drawn again.
	await pinClockToProject(page, project.id, 'lastRunAt');
	await page.reload();
	await expect(h.getByTestId('section-context')).toHaveText('1 run · newest ran today');
});

test('the run header links to the river and hydrological unit pages for its run, and the old link rows go there, Back skipping them', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Runs outcomes');
	const first = await createRun(page.request, project.id, 'First');
	await createRun(page.request, project.id, 'Second');
	await openRuns(page, project.id, `&run=${first}`);
	const outcomes = page.getByRole('navigation', { name: 'Outcomes for this run' });
	await expect(outcomes.getByRole('link', { name: 'EWR for this run' })).toHaveAttribute('href', `?tab=river&run=${first}`);
	await expect(outcomes.getByRole('link', { name: 'Hydrological units for this run' })).toHaveAttribute('href', `?tab=supply&run=${first}`);
	// The arrow stands a space after each link's words ("EWR→" when the flex item lost the space).
	for (const link of await outcomes.getByRole('link').all()) {
		const gap = await link.evaluate((a) => {
			const range = document.createRange();
			range.selectNodeContents(a.firstChild!);
			return a.querySelector('span')!.getBoundingClientRect().left - range.getBoundingClientRect().right;
		});
		expect(gap).toBeGreaterThanOrEqual(2);
	}
	// The groups are no longer on the page or in its menu.
	await expect(page.locator('#res-river, #res-units')).toHaveCount(0);
	await expect(page.getByRole('heading', { level: 2, name: 'River & Reserve' })).toHaveCount(0);
	await expect(page.getByRole('navigation', { name: 'Result sections' }).getByRole('link', { name: /^On / })).toHaveCount(0);

	// The link rows' anchors (in the menu for a while) open the page itself, for the same run.
	await page.goto(`/projects/${project.id}?tab=overview`);
	await page.goto(`/projects/${project.id}?tab=runs&run=${first}#res-river`);
	await expect(page).toHaveURL(new RegExp(`\\?tab=river&run=${first}$`));
	await expect(page.getByTestId('river-context')).toContainText('First');
	await page.goBack();
	await expect(page).toHaveURL(/\?tab=overview$/);

	await page.goto(`/projects/${project.id}?tab=runs&run=${first}&window=last7#res-units`);
	await expect(page).toHaveURL(new RegExp(`\\?tab=supply&run=${first}&window=last7$`));
	await expect(page.getByTestId('supply-summary')).toContainText('run “First”');
	await page.goBack();
	await expect(page).toHaveURL(/\?tab=overview$/);

	// A panel still on this page keeps its anchor (positive control).
	await page.goto(`/projects/${project.id}?tab=runs&run=${first}#res-water-balance`);
	await expect(page).toHaveURL(/tab=runs.*#res-water-balance$/);
	await expect(page.locator('#res-water-balance')).toBeInViewport();
});

test('the run summary keeps the spaces round its separators, and Chart any daily series names each series in the unit it is drawn in', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Runs words');
	await createRun(page.request, project.id, 'Baseline');
	await openRuns(page, project.id);
	// A space dropped at the start of an {#if} block read "0.83 Mm³/a· 63% of natural".
	const outflow = page.getByRole('region', { name: 'Summary', exact: true }).locator('.stat').filter({ hasText: 'Mean simulated outflow' }).locator('dd.sub');
	await expect(outflow).toHaveText(/^[\d.]+ Mm³\/a\s+·\s+\d+% of natural$/);

	// The Series picker said "(m³/day)" over a chart drawn in m³/s; it follows the chart's switch.
	const explore = page.getByRole('region', { name: 'Chart any daily series' });
	await explore.scrollIntoViewIfNeeded();
	const picker = explore.getByLabel('Series');
	await expect(picker.locator('option:checked')).toHaveText('Simulated outflow (m³/s)');
	await explore.getByRole('button', { name: 'm³/day' }).click();
	await expect(picker.locator('option:checked')).toHaveText('Simulated outflow (m³/day)');
});

test('an empty project that can\'t run yet says no runs, without telling the editor to run the model', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Runs blocked');
	await page.goto(`/projects/${project.id}?tab=runs`);
	await expect(page.locator('#run-note')).toContainText('A run needs a network and a rainfall series.');
	await expect(page.getByRole('button', { name: 'Run model' })).toBeDisabled();
	await expect(runsList(page)).toContainText('No runs yet. A run can start once the note above is dealt with.');
	await expect(runsList(page).getByText(/Run the model to see results/)).toHaveCount(0);
});

test('with twenty long-labelled runs the rail sits beside the run and fits the window at 1440×960 and 1280×800', async ({ page, owner }) => {
	void owner;
	const { id } = await seedManyRuns(page.request, 'Runs rail fit');
	for (const [width, height] of [
		[1440, 960],
		[1280, 800]
	] as const) {
		await page.setViewportSize({ width, height });
		await openRuns(page, id);
		const rail = page.getByRole('region', { name: 'Runs & results' }).getByRole('complementary');
		const railBox = (await rail.boundingBox())!;
		const results = (await page.locator('#res-h').boundingBox())!;
		// Beside, not above: the run's heading starts level with the rail, to its right.
		expect(results.x).toBeGreaterThan(railBox.x + railBox.width);
		expect(results.y).toBeLessThan(railBox.y + 150);
		// The shown run's summary starts on the first screen.
		await expect(page.getByRole('region', { name: 'Summary', exact: true })).toBeInViewport();
		// The rail reaches the window's bottom (less its margin), no further, and its list scrolls inside it.
		expect(railBox.y + railBox.height).toBeLessThanOrEqual(height);
		expect(railBox.y + railBox.height).toBeGreaterThan(height - 30);
		const list = runsList(page).getByRole('list');
		expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
		await expect.poll(() => rail.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(0);
		// A long label is clamped to two lines in its row, never wider than the rail.
		const long = runsList(page).getByRole('button', { name: new RegExp(`^${LONG_LABEL}`) }).first();
		const longBox = (await long.boundingBox())!;
		expect(longBox.x + longBox.width).toBeLessThanOrEqual(railBox.x + railBox.width);
		// When it ran and the years are one line in every row: "2021–2022" used to break after its dash,
		// a third line per row.
		const metaLines = await runsList(page).locator('.meta').evaluateAll((els) =>
			els.map((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)))
		);
		expect(metaLines.length).toBe(20);
		expect(Math.max(...metaLines)).toBe(1);
		// Scrolled down the results (mid-page: at the very end the grid's bottom edge lifts a sticky rail), it is still in view.
		// Run notes has a link of its own on the bar (1280) and in the side index (1440) alike (issue #586, D4).
		await page.getByRole('navigation', { name: 'Result sections' }).getByRole('link', { name: 'Run notes', exact: true }).click();
		await expect(page).toHaveURL(/#res-notes$/);
		await expect(runsList(page)).toBeInViewport();
		// Stuck at the top, it grows to the window's height, still no further.
		await expect.poll(async () => { const b = (await rail.boundingBox())!; return b.y + b.height; }).toBeGreaterThan(height - 30);
		const stuck = (await rail.boundingBox())!;
		expect(stuck.y + stuck.height).toBeLessThanOrEqual(height);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
	}
});

test('with one run, the runs list is one slim row above the results, which take the whole width; a second run brings the rail back', async ({ page, owner }) => {
	void owner;
	// A 250 px rail holding one row beside an empty column down the whole page (#586 D21).
	const project = await seedRunnableProject(page.request, 'Runs one run');
	await createRun(page.request, project.id, 'Only run');
	const card = page.getByTestId('runs-card');
	for (const [width, height] of [
		[1440, 960],
		[1280, 800]
	] as const) {
		await page.setViewportSize({ width, height });
		await openRuns(page, project.id);
		const c = (await card.boundingBox())!;
		const results = (await page.locator('#res-h').locator('xpath=ancestor::section[1]').boundingBox())!;
		// Above the results, not beside them, and as wide as they are or wider (the side index sits beside the results).
		expect(results.y, `${width}`).toBeGreaterThan(c.y + c.height);
		expect(Math.abs(results.x - c.x), `${width}`).toBeLessThan(2);
		expect(c.width, `${width}`).toBeGreaterThanOrEqual(results.width - 1);
		// One slim row: its heading, the run (label, when, tags, pin and delete) and the tags' key on one line.
		expect(c.height, `${width}`).toBeLessThan(70);
		const row = runsList(page).getByRole('listitem');
		await expect(row).toHaveCount(1);
		await expect(row.getByRole('button', { name: /^Only run/ })).toHaveAttribute('aria-current', 'true');
		for (const control of [row.getByRole('button', { name: /^Pin run/ }), row.getByRole('button', { name: /^Delete run/ }), card.getByText('What the tags mean')]) {
			const b = (await control.boundingBox())!;
			expect(b.y, `${width}`).toBeGreaterThanOrEqual(c.y);
			expect(b.y + b.height, `${width}`).toBeLessThanOrEqual(c.y + c.height);
		}
		// The summary starts on the first screen, its six headline cards three to a row in the wider column (four
		// left two under them beside an empty half row).
		await expect(page.getByRole('region', { name: 'Summary', exact: true })).toBeInViewport();
		const tops = await page.locator('#res-summary .stats .stat').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
		expect(tops.length, `${width}`).toBe(6);
		const perRow = [...new Set(tops)].map((t) => tops.filter((x) => x === t).length);
		expect(perRow, `${width}`).toEqual([3, 3]);
		await expectNoSidewaysScroll(page);
	}
	// The tags' key opens under the row, inside the card.
	await card.getByText('What the tags mean').click();
	await expect(card.getByRole('term').filter({ hasText: 'latest' })).toBeVisible();
	await expectNoViolations(page);

	// A second run: the list is a rail beside the results again.
	await createRun(page.request, project.id, 'Second run');
	await page.setViewportSize({ width: 1440, height: 960 });
	await openRuns(page, project.id);
	const rail = (await card.boundingBox())!;
	const results = (await page.locator('#res-h').boundingBox())!;
	expect(results.x).toBeGreaterThan(rail.x + rail.width);
	expect(results.y).toBeLessThan(rail.y + 150);

	// On a phone, one run stacks with no sideways scroll, and the run's heading is on the first screen.
	const phone = await seedRunnableProject(page.request, 'Runs one run phone');
	await createRun(page.request, phone.id, 'Only run');
	await page.setViewportSize({ width: 390, height: 844 });
	await openRuns(page, phone.id);
	await expectNoSidewaysScroll(page);
	await expect(page.locator('#res-h')).toBeInViewport({ ratio: 1 });
	await expectNoViolations(page);
});

test('on a phone the page stacks, the runs list folds to its first rows, and the results start on the first screen', async ({ page, owner }) => {
	void owner;
	const { id } = await seedManyRuns(page.request, 'Runs phone');
	await page.setViewportSize({ width: 390, height: 844 });
	await openRuns(page, id);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	// Twenty runs fold to the newest (the shown run), with the filter, under "Show all 20 runs" (#586 D8): the shown
	// run's heading starts on the first screen, not under twenty rows.
	const rows = runsList(page).getByRole('listitem');
	await expect(rows).toHaveCount(1);
	await expect(page.getByRole('searchbox', { name: 'Filter runs by label' })).toBeHidden();
	const more = runsList(page).getByRole('button', { name: /^Show all 20 runs/ });
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	// Whole, on the first screen (it started at 885 px under the twenty rows' 20rem box).
	await expect(page.locator('#res-h')).toBeInViewport({ ratio: 1 });
	await more.click();
	await expect(rows).toHaveCount(20);
	await expect(page.getByRole('searchbox', { name: 'Filter runs by label' })).toBeVisible();
	await expect(runsList(page).getByRole('button', { name: 'Show fewer runs' })).toHaveAttribute('aria-expanded', 'true');
	// A run picked from far down the opened list keeps its row when the list folds again.
	await rows.nth(12).getByRole('button').first().click();
	await expect(rows.nth(12).getByRole('button').first()).toHaveAttribute('aria-current', 'true');
	await runsList(page).getByRole('button', { name: 'Show fewer runs' }).click();
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(1).getByRole('button').first()).toHaveAttribute('aria-current', 'true');
	await expect(runsList(page).getByRole('button', { name: /^Show all 20 runs/ })).toBeVisible();
	// The run form wraps inside the header with a full-size field and button.
	const field = (await header(page).getByLabel(/^Run label/).boundingBox())!;
	expect(field.x + field.width).toBeLessThanOrEqual(390);
	expect((await header(page).getByRole('button', { name: 'Run model' }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
	await expectNoViolations(page);
});

test('on Calibration in a narrow window the runoff panel stacks its chart under the table, so nothing pokes past the window; side by side at 1440', async ({ page, owner }) => {
	void owner;
	// Five water years: past three, the stores chart gets Earlier / Later and Last 3 years, the toolbar that
	// ran 20 px off the window when a viewport query put the chart beside the table in a 465 px panel.
	const id = await seedRiverProject(page.request, 'Runs 1024', 1827);
	await createRun(page.request, id, 'Five years');
	const runoff = page.getByRole('region', { name: /^Runoff model: GR4J/ });
	const table = runoff.getByRole('table', { name: 'Where the rain went over the run' });
	const stores = runoff.locator('figure.chart');
	for (const [width, height, stacked] of [
		// On Calibration there is no runs rail beside the panel (it was 465 px at 1024 on Runs & results), so a
		// narrower window gives the narrow panel: under the 44rem the panel's container query switches at.
		[900, 768, true],
		[1440, 960, false]
	] as const) {
		await page.setViewportSize({ width, height });
		// Model quality, the runoff panel with it, is on Calibration (issue #586 Round 3).
		await openCalibration(page, id);
		await runoff.scrollIntoViewIfNeeded();
		await expect(stores).toHaveAttribute('data-ready', 'true');
		await expect(stores.getByRole('button', { name: 'Last 3 years' })).toBeVisible();
		const t = (await table.boundingBox())!;
		const c = (await stores.boundingBox())!;
		if (stacked) expect(c.y, `${width}`).toBeGreaterThan(t.y + t.height);
		else expect(c.x, `${width}`).toBeGreaterThan(t.x + t.width);
		// The chart's toolbar stays inside the chart.
		const tools = (await stores.locator('.tools').boundingBox())!;
		expect(tools.x + tools.width, `${width}`).toBeLessThanOrEqual(c.x + c.width + 0.5);
		await expectNoSidewaysScroll(page);
	}
});

test('a viewer sees the runs and the header line, no run form, and the page passes axe', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Runs viewer');
	await createRun(page.request, project.id, 'Shared');
	const viewer = await signIn('Runs viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await pinClockToProject(viewer.page, project.id, 'lastRunAt'); // "ran today" on the run's own day (support/clock.ts)
	await openRuns(viewer.page, project.id);
	const h = header(viewer.page);
	await expect(h.getByTestId('section-context')).toHaveText('1 run · newest ran today');
	await expect(viewer.page.getByLabel(/^Run label/)).toHaveCount(0);
	await expect(viewer.page.getByRole('button', { name: 'Run model' })).toHaveCount(0);
	await expect(viewer.page.locator('#run-note')).toHaveCount(0);
	await expect(viewer.page.getByRole('navigation', { name: 'Outcomes for this run' }).getByRole('link')).toHaveCount(2);
	await expectNoViolations(viewer.page);
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`an editor's page passes axe at 1440×960 in the ${colorScheme} theme`, async ({ page, owner }) => {
		void owner;
		await page.emulateMedia({ colorScheme });
		await page.setViewportSize({ width: 1440, height: 960 });
		const { id } = await seedManyRuns(page.request, `Runs axe ${colorScheme}`, 8);
		await openRuns(page, id);
		await expectNoViolations(page);
	});
}

test('the validation statement sits in the Record group, folded shut; opened, it is the report’s, and passes axe at desktop and phone', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Runs validation');
	await createRun(page.request, project.id, 'Validated');
	await openRuns(page, project.id);
	const menu = page.getByRole('navigation', { name: 'Result sections' });
	// At 1440 the menu is the side index, its links named as the panels' headings (issue #462).
	await expect(menu.getByRole('link', { name: 'Validation statement', exact: true })).toHaveAttribute('href', '#res-validation');

	const panel = page.locator('#res-validation').getByRole('region', { name: 'Validation statement' });
	await expect(panel).toHaveCount(1);
	// Shut by default: the heading and its one-line gist, not the statement (it loads when opened).
	await expect(panel.getByText(/^Engine \d+\.\d+\.\d+: its checks/)).toBeVisible();
	await expect(panel.getByRole('heading', { name: 'Known limitations' })).toHaveCount(0);

	await panel.getByRole('heading', { name: 'Validation statement' }).click();
	// The report's statement, its headings one level under the panel's.
	await expect(panel.getByRole('heading', { level: 4 })).toHaveText(['Calibration', 'Data quality', /^Errata of engine \d+\.\d+\.\d+$/, 'Known limitations']);
	await expect(panel.getByText('Engine version', { exact: true })).toBeVisible();
	await expect(panel.getByRole('rowheader', { name: 'B3', exact: true })).toBeVisible();
	await expectNoViolations(page);

	await page.setViewportSize({ width: 390, height: 844 });
	await expect(panel.getByRole('heading', { level: 4, name: 'Known limitations' })).toBeVisible();
	await expectNoViolations(page);
});

test('on Calibration, the hydrograph draws before the panels below it render, and a link to a panel down there still lands on it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Runs first paint');
	const runId = await createRun(page.request, project.id, 'First paint');
	// What was on the page when the hydrograph first reported drawn (LineChart's data-ready).
	await page.addInitScript(() => {
		const w = window as unknown as { __lowerAtChart?: boolean };
		new MutationObserver(() => {
			if (w.__lowerAtChart === undefined && document.querySelector('#res-hydrograph figure[data-ready="true"]')) {
				w.__lowerAtChart = !!document.querySelector('#res-calibration, #res-ewr-agreement, #res-plausibility');
			}
		}).observe(document, { subtree: true, childList: true, attributes: true });
	});
	// Model quality is on Calibration (issue #586 Round 3).
	await openCalibration(page, project.id);
	await expect(page.locator('#res-plausibility')).toBeAttached();
	expect(await page.evaluate(() => (window as unknown as { __lowerAtChart?: boolean }).__lowerAtChart)).toBe(false);

	// A deep link to a panel down there renders them at once and lands on it.
	await page.goto(`/projects/${project.id}?tab=calibration&run=${runId}#res-plausibility`);
	await expect(page.locator('#res-plausibility')).toBeInViewport();
	await expect(page.locator('#res-plausibility').locator('h2, h3, h4').first()).toBeFocused();
});

test('the run summary writes figures as they are read: a true minus, proportional figures in the tiles, dates day first', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Runs figures');
	await createRun(page.request, project.id, 'Baseline');
	await pinClockToProject(page, project.id, 'lastRunAt'); // "today" on the run's own day (support/clock.ts)
	await openRuns(page, project.id);
	const summary = page.getByRole('region', { name: 'Summary', exact: true });
	// Inter's tabular figures set a hyphen a digit wide: "- 2.26", "under - estimates". The tiles use proportional
	// figures, and a negative figure carries U+2212, never a hyphen-minus before a digit.
	for (const v of await summary.locator('.stat dd').evaluateAll((dds) => dds.map((d) => getComputedStyle(d).fontVariantNumeric))) expect(v).toBe('normal');
	expect(await summary.innerText()).not.toMatch(/(^|[\s(])-\d/);
	// The header gives the period as the Summary does, and when it ran in the app's day-first words.
	await expect(page.locator('#res-h').locator('..')).toContainText(/1 Oct 2021 – 28 Jan 2022 \(120 days\) · ran today \d\d:\d\d by /);
	await expect(runsList(page).getByRole('button', { name: /^Baseline/ })).toContainText(/today \d\d:\d\d · 2021–2022/);
});

test('the water balance fits its column at 1440 and 1280: headings wrap, two pairs share a column, the year on one line', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Runs water balance');
	await createRun(page.request, project.id, 'Baseline');
	const balance = page.locator('#res-water-balance');
	const wrap = balance.locator('.table-wrap');
	/** How many line boxes a row header's words take. */
	const lines = (name: string) =>
		balance.getByRole('rowheader', { name, exact: true }).evaluate((th) => {
			const range = document.createRange();
			range.selectNodeContents(th);
			return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
		});
	for (const size of [
		{ width: 1440, height: 960 },
		{ width: 1280, height: 800 }
	]) {
		await page.setViewportSize(size);
		await openRuns(page, project.id);
		await balance.scrollIntoViewIfNeeded();
		const at = `${size.width}`;
		// It scrolled 535 px past its column at 1440 with one-line headings.
		expect(await wrap.evaluate((w) => w.scrollWidth - w.clientWidth), at).toBeLessThanOrEqual(0);
		expect(await lines('Whole run'), at).toBe(1);
		// Each stacked pair: the second figure on its own line under the first.
		const rain = balance.getByRole('row').nth(1).getByRole('cell').first();
		const [first, second] = await rain.evaluate((td) => [td.firstChild!, td.querySelector('.under')!].map((n) => {
			const range = document.createRange();
			range.selectNodeContents(n);
			return range.getBoundingClientRect().top;
		}));
		expect(second!, at).toBeGreaterThan(first! + 5);
	}
	// On a phone it scrolls inside its own box, the page doesn't, and the water year stays at the box's left edge.
	await page.setViewportSize({ width: 390, height: 844 });
	await openRuns(page, project.id);
	await balance.scrollIntoViewIfNeeded();
	await expectNoSidewaysScroll(page);
	const left = (await wrap.boundingBox())!.x;
	await wrap.evaluate((w) => (w.scrollLeft = w.scrollWidth));
	await expect.poll(async () => Math.round((await balance.getByRole('rowheader', { name: 'Whole run', exact: true }).boundingBox())!.x - left)).toBeLessThanOrEqual(1);
});

test('run notes: the team’s Notes button on the heading’s row, saying which is which, and Save notes in an action row under the field', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Runs notes layout');
	await createRun(page.request, project.id, 'Baseline');
	for (const size of [
		{ width: 1440, height: 960 },
		{ width: 390, height: 844 }
	]) {
		await page.setViewportSize(size);
		await openRuns(page, project.id);
		const at = `${size.width}`;
		const notes = page.getByRole('region', { name: 'Run notes' });
		await notes.scrollIntoViewIfNeeded();
		await expect(notes).toContainText('The run’s own explanation, kept with it and read in run comparison and the summary CSV; the team’s discussion of the run is under Notes.');
		const heading = (await notes.getByRole('heading', { name: 'Run notes' }).boundingBox())!;
		const team = (await notes.getByRole('button', { name: 'Notes on this run', exact: true }).boundingBox())!;
		const box = (await notes.boundingBox())!;
		// Level with the heading (the two "notes" were stacked under it as one thing), at the section's right edge.
		expect(Math.abs(team.y + team.height / 2 - (heading.y + heading.height / 2)), at).toBeLessThan(8);
		expect(Math.abs(team.x + team.width - (box.x + box.width)), at).toBeLessThan(2);
		// Save sits under the field, at its left edge, default size like the panel's other form actions.
		const field = (await notes.getByRole('textbox', { name: 'Run notes' }).boundingBox())!;
		const save = (await notes.getByRole('button', { name: 'Save notes' }).boundingBox())!;
		expect(save.y, at).toBeGreaterThan(field.y + field.height);
		expect(Math.abs(save.x - field.x), at).toBeLessThan(1);
		expect(save.height, at).toBeGreaterThanOrEqual(30);
	}
	await expectNoViolations(page, { include: '#res-notes' });
});

test('with no runs, the page is one empty state across its width that says what a run will show', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Runs none yet');
	for (const size of [
		{ width: 1440, height: 960 },
		{ width: 390, height: 844 }
	]) {
		await page.setViewportSize(size);
		await page.goto(`/projects/${project.id}?tab=runs`);
		const at = `${size.width}`;
		await expect(runsList(page).getByText('No runs yet. Run the model to see results.')).toBeVisible();
		await expect(runsList(page)).toContainText(
			"A run's results: its summary and water balance, with the fit to observed flow on Calibration, EWR compliance on EWR and each hydrological unit's supply and dam storage on Hydrological units."
		);
		// No second "Results appear here" card beside it (1440) or a screen of it under it (390).
		await expect(page.getByText(/Results appear here|Pick a run to see its results/)).toHaveCount(0);
		const card = (await runsList(page).boundingBox())!;
		const h = (await header(page).boundingBox())!;
		expect(Math.abs(card.width - h.width), at).toBeLessThan(2);
		expect(card.height, at).toBeLessThan(200);
		await expectNoSidewaysScroll(page);
	}
	await expectNoViolations(page);
});

test('a 15-year run: the water balance by water year fits its column at 1440 and 1280 with every year shown, and the figures read plainly', async ({ page, owner }) => {
	void owner;
	// 5,479 days from 1 Oct 2019: fifteen water years, then the whole run (#586 D1).
	const id = await seedRiverProject(page.request, 'Runs fifteen years', 5479);
	await createRun(page.request, id, 'Fifteen years');
	const wrap = page.locator('#res-water-balance .table-wrap');
	for (const [width, height] of [
		[1440, 960],
		[1280, 800]
	] as const) {
		await page.setViewportSize({ width, height });
		await openRuns(page, id);
		await wrap.scrollIntoViewIfNeeded();
		await expect(wrap.locator('tbody tr')).toHaveCount(16);
		// Every column inside the box (the Residual column was cut at "Residua"), and no scroll inside it either way.
		const box = await wrap.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight }));
		expect(box.sw, `${width}: ${box.sw} px of table in ${box.cw} px`).toBeLessThanOrEqual(box.cw);
		expect(box.sh).toBeLessThanOrEqual(box.ch);
	}
	// Float noise reads "< 0.001", never an exponent (#586 D10).
	const cells = await wrap.locator('td').allTextContents();
	expect(cells.filter((t) => /\de[-−+]?\d/.test(t))).toEqual([]);
	// The runoff model, the calibration and the EWR test are on Calibration (Model quality, issue #586 Round 3).
	await openCalibration(page, id);
	// The runoff model's parameters by name, rounded as Where the parameters came from rounds them.
	const runoff = page.getByRole('region', { name: /^Runoff model: GR4J/ });
	await expect(runoff).toContainText('Production store capacity X1 ');
	expect(await runoff.locator('p').first().textContent()).not.toMatch(/\d\.\d{4,}/);
	// Dates a person reads are day first (#586 D9): the calibration's observations and the EWR test's intro.
	await expect(page.locator('#res-calibration')).toContainText('1 Oct 2019 – ');
	await expect(page.locator('#res-ewr-agreement')).toContainText(/days with an observed flow \(1 Oct 2019 – \d{1,2} [A-Z][a-z]{2} \d{4}\)/);
});

test('when the runs list fails to load, the page says so once, with Try again, and shows no results column', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Runs list fails');
	await createRun(page.request, project.id, 'Baseline');
	const listPath = `/projects/${project.id}/runs`;
	let fail = true;
	await page.route(
		(url) => url.pathname.endsWith(listPath),
		(route) => (fail && route.request().method() === 'GET' ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Something broke' }) }) : route.continue())
	);
	await page.goto(`/projects/${project.id}?tab=runs`);
	// "No runs yet" was false, and a second card said "Pick a run" with nothing to pick (#586 D3).
	await expect(header(page).getByTestId('section-context')).toHaveText('Couldn’t load the runs');
	const alert = runsList(page).getByRole('alert');
	await expect(alert).toContainText('Couldn’t load the runs: ');
	await expect(page.getByText(/No runs yet|Pick a run/)).toHaveCount(0);
	await expect(page.locator('.detail')).toHaveCount(0);
	fail = false;
	await alert.getByRole('button', { name: 'Try again' }).click();
	await expect(runsList(page).getByRole('button', { name: /^Baseline/ })).toHaveAttribute('aria-current', 'true');
	await expect(page.getByRole('heading', { level: 2, name: 'Baseline' })).toBeVisible();
	await expect(header(page).getByTestId('section-context')).toContainText('1 run · newest ran ');
});

test('in the rail, look-alike labels keep their endings, the tags are explained in words, a filter says when the shown run is outside it, and go to latest keeps the focus', async ({ page, owner }) => {
	void owner;
	const { id } = await seedManyRuns(page.request, 'Runs rail words');
	await page.setViewportSize({ width: 1440, height: 960 });
	await openRuns(page, id);

	// Seven labels share LONG_LABEL's start: cut at two lines they all read "Dam raise … with the 20…" (#586 D7).
	// Each keeps the ending that tells it apart, and its full label is still what a screen reader reads.
	const long = runsList(page).getByRole('button', { name: new RegExp(`^${LONG_LABEL} \\d+`) });
	await expect(long).toHaveCount(7);
	const shown = await long.locator('.lbl').allTextContents();
	expect(new Set(shown).size).toBe(7);
	for (const t of shown) expect(t).toMatch(/… \d+$/);

	// The tags' meanings in words a touch or keyboard user can reach, not only hover titles (#586 D18).
	const key = runsList(page).locator('details.tag-key');
	await key.getByText('What the tags mean').click();
	await expect(key.getByRole('term')).toHaveText(['latest']);
	await expect(key.getByRole('definition')).toHaveText(['The newest run.']);

	// Go to latest hides itself once the latest shows: the focus goes to that run's row, not <body> (#586 E9).
	const rows = runsList(page).getByRole('listitem');
	const older = rows.nth(5).getByRole('button').first();
	await older.click();
	await expect(older).toHaveAttribute('aria-current', 'true');
	await page.getByRole('button', { name: 'go to latest' }).click();
	const newest = rows.first().getByRole('button').first();
	await expect(newest).toHaveAttribute('aria-current', 'true');
	await expect(newest).toBeFocused();

	// A filter that matches nothing still shows the run on screen: the rail says it isn't in the filter (#586 D20).
	const filter = page.getByRole('searchbox', { name: 'Filter runs by label' });
	await filter.fill('zzz');
	await expect(runsList(page).getByTestId('shown-outside-filter')).toHaveText(/^Showing “.+”, which isn’t in the filter\.$/);
	await filter.fill('');
	await expect(runsList(page).getByTestId('shown-outside-filter')).toHaveCount(0);
});
