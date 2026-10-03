// Runs & results as a page (issue #17, docs/ui.md § Runs & results): the run
// form in the section header, the runs rail beside the shown run and fitting
// the window, the river and unit pages one link away from the run header,
// the old link rows' anchors sent on, a viewer's page, and a11y at desktop
// and phone. runs.spec.ts covers the results themselves.
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { seedRiverProject } from '../support/river.ts';
import { LONG_LABEL, openRuns, runsList, seedManyRuns } from '../support/runs.ts';

const header = (page: import('@playwright/test').Page) => page.getByTestId('section-header');

test('the run form sits in the section header, last, with its status one slim line under it', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Runs header');
	await page.goto(`/projects/${project.id}?tab=runs`);
	const h = header(page);
	await expect(h.getByTestId('section-context')).toHaveText('No runs yet');
	await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

	// The run form, the only Run model in the header: last, after a plain Add data, one row with the title.
	await expect(h.getByRole('button')).toHaveText(['Add data', 'Run model']);
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
	await expect(h.getByTestId('section-context')).toHaveText('1 run · newest ran today');
	await expect(h.getByLabel(/^Run label/)).toHaveValue('');
});

test('the run header links to the river and hydrological unit pages for its run, and the old link rows go there, Back skipping them', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Runs outcomes');
	const first = await createRun(page.request, project.id, 'First');
	await createRun(page.request, project.id, 'Second');
	await openRuns(page, project.id, `&run=${first}`);
	const outcomes = page.getByRole('navigation', { name: 'Outcomes for this run' });
	await expect(outcomes.getByRole('link', { name: 'River & reserve for this run' })).toHaveAttribute('href', `?tab=river&run=${first}`);
	await expect(outcomes.getByRole('link', { name: 'Hydrological units for this run' })).toHaveAttribute('href', `?tab=supply&run=${first}`);
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
	await page.goto(`/projects/${project.id}?tab=runs&run=${first}#res-calibration`);
	await expect(page).toHaveURL(/tab=runs.*#res-calibration$/);
	await expect(page.locator('#res-calibration')).toBeInViewport();
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
		await expect(page.getByRole('region', { name: 'Run summary' })).toBeInViewport();
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
		// Scrolled down the results (mid-page: at the very end the grid's bottom edge lifts a sticky rail), it is still in view.
		await page.getByRole('navigation', { name: 'Result sections' }).getByRole('link', { name: 'Notes & evidence' }).click();
		await expect(page).toHaveURL(/#res-notes$/);
		await expect(runsList(page)).toBeInViewport();
		// Stuck at the top, it grows to the window's height, still no further.
		await expect.poll(async () => { const b = (await rail.boundingBox())!; return b.y + b.height; }).toBeGreaterThan(height - 30);
		const stuck = (await rail.boundingBox())!;
		expect(stuck.y + stuck.height).toBeLessThanOrEqual(height);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
	}
});

test('on a phone the page stacks, the runs list scrolls inside its panel, and the results follow straight after', async ({ page, owner }) => {
	void owner;
	const { id } = await seedManyRuns(page.request, 'Runs phone');
	await page.setViewportSize({ width: 390, height: 844 });
	await openRuns(page, id);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	const list = runsList(page).getByRole('list');
	expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
	// The list is capped, so the run's heading is under a screen and a half down, not under twenty rows.
	const heading = (await page.locator('#res-h').boundingBox())!;
	expect(heading.y).toBeLessThan(844 * 1.5);
	// The run form wraps inside the header with a full-size field and button.
	const field = (await header(page).getByLabel(/^Run label/).boundingBox())!;
	expect(field.x + field.width).toBeLessThanOrEqual(390);
	expect((await header(page).getByRole('button', { name: 'Run model' }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
	await expectNoViolations(page);
});

test('at 1024 px the runoff panel stacks its chart under the table, so nothing pokes past the window; side by side at 1440', async ({ page, owner }) => {
	void owner;
	// Five water years: past three, the stores chart gets Earlier / Later and Last 3 years, the toolbar that
	// ran 20 px off the window when a viewport query put the chart beside the table in a 465 px panel.
	const id = await seedRiverProject(page.request, 'Runs 1024', 1827);
	await createRun(page.request, id, 'Five years');
	const runoff = page.getByRole('region', { name: /^Runoff model: GR4J/ });
	const table = runoff.getByRole('table', { name: 'Where the rain went over the run' });
	const stores = runoff.locator('figure.chart');
	for (const [width, height, stacked] of [
		[1024, 768, true],
		[1440, 960, false]
	] as const) {
		await page.setViewportSize({ width, height });
		await openRuns(page, id);
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
	await expect(menu.getByRole('link', { name: 'Validation', exact: true })).toHaveAttribute('href', '#res-validation');

	const panel = page.locator('#res-validation').getByRole('region', { name: 'Validation statement' });
	await expect(panel).toHaveCount(1);
	// Shut by default: the heading and its one-line gist, not the statement (it loads when opened).
	await expect(panel.getByText(/^Engine \d+\.\d+\.\d+: its checks/)).toBeVisible();
	await expect(panel.getByRole('heading', { name: 'Known limitations' })).toHaveCount(0);

	await panel.getByRole('heading', { name: 'Validation statement' }).click();
	// The report's statement, its headings one level under the panel's.
	await expect(panel.getByRole('heading', { level: 4 })).toHaveText(['Calibration', 'Data quality', /^Errata of engine \d+\.\d+\.\d+$/, 'Known limitations']);
	await expect(panel.getByText('Engine version', { exact: true })).toBeVisible();
	await expect(panel.getByRole('rowheader', { name: 'N1', exact: true })).toBeVisible();
	await expectNoViolations(page);

	await page.setViewportSize({ width: 390, height: 844 });
	await expect(panel.getByRole('heading', { level: 4, name: 'Known limitations' })).toBeVisible();
	await expectNoViolations(page);
});

test('the hydrograph draws before the groups below it render, and a link to a panel down there still lands on it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Runs first paint');
	const runId = await createRun(page.request, project.id, 'First paint');
	// What was on the page when the hydrograph first reported drawn (LineChart's data-ready).
	await page.addInitScript(() => {
		const w = window as unknown as { __lowerAtChart?: boolean };
		new MutationObserver(() => {
			if (w.__lowerAtChart === undefined && document.querySelector('#res-hydrograph figure[data-ready="true"]')) {
				w.__lowerAtChart = !!document.querySelector('#res-calibration, #res-notes, #res-explore');
			}
		}).observe(document, { subtree: true, childList: true, attributes: true });
	});
	await openRuns(page, project.id);
	await expect(page.locator('#res-explore')).toBeAttached();
	expect(await page.evaluate(() => (window as unknown as { __lowerAtChart?: boolean }).__lowerAtChart)).toBe(false);

	// A deep link to the Record group renders it at once and scrolls there.
	await page.goto(`/projects/${project.id}?tab=runs&run=${runId}#res-notes`);
	await expect(page.locator('#res-notes')).toBeInViewport();
});
