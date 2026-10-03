// The Data section (?tab=series, issue #17 option A): the input series freshness first, the series behind (the
// sidebar badge's count and rule) marked and listed first, the picked series charted (series=<id>), the page flowing in
// the window's one scroll with a long table folded under "Show all", and Add data refreshing the list. Synthetic series only.
import { fileURLToPath } from 'node:url';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, createRun, putSeries, seedRunnableProject, syntheticRain, updateSettings } from '../support/api.ts';
import { csv } from '../support/addData.ts';
import { API_URL } from '../support/env.ts';
import { chartReady, openData, putEnding, sections, seedFreshnessMix, seriesChart, seriesRow, seriesRows, seriesTable } from '../support/data.ts';
import { expect, test } from '../support/fixtures.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

async function seriesIds(request: import('@playwright/test').APIRequestContext, projectId: string): Promise<Record<string, string>> {
	const { series } = (await (await request.get(`${API_URL}/projects/${projectId}/series`)).json()) as { series: { id: string; name: string }[] };
	return Object.fromEntries(series.map((s) => [s.name, s.id]));
}

test('the series behind come first and are marked, the same count as the sidebar badge and the header', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Data freshness');
	await seedFreshnessMix(page.request, project.id);
	await openData(page, project.id);

	// One title; the header counts the series and those behind, and carries Preview all data and the main action, Add data.
	await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
	await expect(page.getByTestId('section-context')).toHaveText('5 daily input series · 2 behind');
	await expect(sections(page).getByRole('link', { name: /^Data/ })).toContainText('(2 series behind)');
	const header = page.getByTestId('section-header');
	await expect(header.getByRole('button', { name: 'Preview all data' })).toBeVisible();
	await expect(header.getByRole('button', { name: 'Add data' })).toHaveClass(/btn-primary/);

	// Most days behind first (A-pan 45 days, CHIRPS 20), each marked in words; nothing else is, the 60-day-old logger
	// included (it only scores a run) and the forecast that runs ahead.
	await expect(seriesRows(page)).toHaveCount(5);
	await expect(seriesRows(page).nth(0)).toContainText('Pan station');
	await expect(seriesRows(page).nth(1)).toContainText('CHIRPS cell');
	await expect(page.getByTestId('series-behind')).toHaveCount(2);
	await expect(seriesRows(page).nth(0).getByTestId('series-behind')).toHaveText('Behind');
	await expect(seriesRow(page, 'Logger L1').getByTestId('series-behind')).toHaveCount(0);
	await expect(seriesRow(page, 'Forecast F1').getByTestId('series-behind')).toHaveCount(0);
	await expect(seriesRow(page, 'Logger L1')).toContainText('2 months ago');
	// The list has no line of its own repeating the header's count and the rain pill (issue #174); its key says what behind means.
	await expect(page.getByTestId('series-summary')).toHaveCount(0);
	await expect(page.getByText('Behind a series a run reads, more than 7 days old.')).toBeVisible();

	// Freshness first in the columns too: Data up to comes straight after the series.
	await expect(seriesTable(page).getByRole('columnheader')).toHaveText(['Series', 'Data up to', 'From', /^Missing/, /^Typical/, 'Coverage by year', 'Actions']);
	// From is the start date only: the end is Data up to's (issue #174).
	await expect(seriesRows(page).nth(0).getByRole('cell').nth(1)).toHaveText(/^\d{4}-\d{2}-\d{2}$/);
});

test('picking a series charts it through the URL: Back returns to the one before, a shared link opens it, a stale one falls back', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Data pick');
	await seedFreshnessMix(page.request, project.id);
	const ids = await seriesIds(page.request, project.id);
	await openData(page, project.id);

	// Without series= the main rainfall is charted.
	await chartReady(page);
	await expect(seriesChart(page).getByRole('figure')).toContainText('Rainfall — catchment · Gauge R1');
	await expect(seriesRow(page, 'Gauge R1').getByRole('button', { name: 'View', exact: true })).toHaveAttribute('aria-pressed', 'true');

	// A click on the row, then View on another: each is a history entry.
	// (On its kind's name: the rowheader's middle holds the CHIRPS version select, which keeps its own meaning.)
	await seriesRow(page, 'CHIRPS cell').getByText('Rainfall — CHIRPS', { exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]series=${ids['CHIRPS cell']}`));
	await expect(seriesChart(page).getByRole('figure')).toContainText('Rainfall — CHIRPS · CHIRPS cell');
	await seriesRow(page, 'Logger L1').getByRole('button', { name: 'View', exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]series=${ids['Logger L1']}`));
	await expect(seriesRow(page, 'Logger L1').getByRole('button', { name: 'View', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await page.goBack();
	await expect(seriesRow(page, 'CHIRPS cell').getByRole('button', { name: 'View', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByRole('heading', { level: 1, name: 'Data' })).toBeVisible();

	// A shared link opens on its series; one to a series that no longer exists shows the default.
	await openData(page, project.id, `&series=${ids['Pan station']}`);
	await expect(seriesRow(page, 'Pan station').getByRole('button', { name: 'View', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await openData(page, project.id, '&series=00000000-0000-4000-8000-000000000000');
	await expect(seriesRow(page, 'Gauge R1').getByRole('button', { name: 'View', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

/**
 * Elements on the Data tab that scroll vertically inside themselves (the page is the one scroll; issue #17,
 * 2026-09-29): the series and chart, and the panels below them (gauge vs logger, double mass, checks, reference).
 */
const innerScrollers = (page: import('@playwright/test').Page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('.data-page, #data-agreement, #data-double-mass, #data-checks, #data-uses')]
			.flatMap((root) => [root, ...root.querySelectorAll('*')])
			.filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1)
			.map((e) => `${e.tagName.toLowerCase()}.${e.className}`)
	);

test('with 30 series the table shows the first six, the rest under “Show all”; the charted row stays; a pick brings the chart into view; nothing scrolls inside itself', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Data big');
	const kinds = ['rain_catchment_mm', 'rain_chirps_mm', 'flow_observed_m3s', 'flow_logger_m3s', 'evap_apan_mm', 'rain_catchment_alt_mm'];
	for (let i = 0; i < 30; i++) {
		// Every fifth series is behind: A-pan more than 7 days old.
		const kind = kinds[i % kinds.length]!;
		await putEnding(page.request, project.id, { kind, name: `Station ${String(i + 1).padStart(2, '0')} with a long descriptive name`, endAgo: kind === 'evap_apan_mm' ? 30 + i : 2, length: 800 });
	}
	await openData(page, project.id);
	await chartReady(page);

	// The five behind lead, then the observed flow a run reads (the default chart): six rows, the rest folded.
	await expect(seriesRows(page)).toHaveCount(6);
	for (let i = 0; i < 5; i++) await expect(seriesRows(page).nth(i).getByTestId('series-behind')).toBeVisible();
	await expect(seriesRows(page).nth(5)).toHaveClass(/selected/);
	await expect(sections(page).getByRole('link', { name: /^Data/ })).toContainText('(5 series behind)');
	await expect(page.getByTestId('section-context')).toHaveText('30 daily input series · 5 behind');
	const more = page.getByRole('button', { name: 'Show all 30 series' });
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	await expect(more).toHaveAttribute('aria-controls', 'series-rows');
	// The page flows: the table grows with its rows, the chart below starts on the first screen, nothing scrolls in a box.
	await expect(seriesRows(page).first()).toBeInViewport();
	await expect(seriesChart(page)).toBeInViewport();
	expect(await innerScrollers(page)).toEqual([]);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await expectNoViolations(page);

	// Open: all thirty in place, the page (not the table) growing.
	await more.click();
	await expect(seriesRows(page)).toHaveCount(30);
	const fewer = page.getByRole('button', { name: 'Show only the first 6 series' });
	await expect(fewer).toHaveAttribute('aria-expanded', 'true');
	expect(await innerScrollers(page)).toEqual([]);

	// Pick one far down: its chart comes into view (the chart is below the table), and it is a history entry.
	const far = seriesRows(page).nth(20);
	const name = (await far.locator('.nm').innerText()).replace(/\s*\(.*\)$/, '').trim();
	await far.locator('.kind').click();
	await expect(far).toHaveClass(/selected/);
	await expect(seriesChart(page).getByRole('figure')).toContainText(name);
	await expect(seriesChart(page)).toBeInViewport({ ratio: 1 });

	// Fold again: the picked row keeps its place after the first six, and a reload of the link shows it too.
	await fewer.click();
	await expect(seriesRows(page)).toHaveCount(7);
	await expect(seriesRows(page).last()).toContainText(name);
	await page.reload();
	await expect(seriesRows(page)).toHaveCount(7);
	await expect(seriesRows(page).last()).toHaveClass(/selected/);

	// A phone: four cards, then the fold (and the picked one); no inner scroll, no sideways scroll.
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(seriesRows(page)).toHaveCount(5);
	await expect(page.getByRole('button', { name: 'Show all 30 series' })).toBeVisible();
	await chartReady(page);
	expect(await innerScrollers(page)).toEqual([]);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	const wrap = page.locator('.table-wrap').filter({ has: page.locator('table.series') });
	expect(await wrap.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
	// A pick on a phone brings the chart, below the cards, into view.
	await seriesRows(page).nth(1).locator('.kind').click();
	await expect(seriesRows(page).nth(1)).toHaveClass(/selected/);
	await expect(seriesChart(page)).toBeInViewport();
	await expectNoViolations(page);
});

test('a file added through the header’s Add data shows in the table at once', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Data add');
	await putEnding(page.request, project.id, { kind: 'rain_catchment_mm', name: 'Gauge R1', endAgo: 1 });
	await openData(page, project.id);
	await expect(seriesRows(page)).toHaveCount(1);

	await page.getByRole('button', { name: 'Add data' }).click();
	const dialog = page.getByRole('dialog', { name: 'Add data' });
	await dialog.getByLabel('Kind').selectOption({ label: 'Flow — observed gauge' });
	await dialog.getByLabel('CSV file').setInputFiles(fixture('observed-flow-daily.csv'));
	await dialog.getByRole('button', { name: 'Upload' }).click();
	await expect(seriesRows(page)).toHaveCount(2);
	await expect(dialog).toBeHidden();
	await expect(seriesRow(page, 'Flow — observed gauge')).toBeVisible();
	// …and charts it, as picking its row would (series=<id>), where the retired Upload CSV panel did the same.
	const ids = await seriesIds(page.request, project.id);
	const flowId = Object.entries(ids).find(([name]) => name !== 'Gauge R1')![1];
	await expect(page).toHaveURL(new RegExp(`[?&]series=${flowId}`));
	await chartReady(page);
	await expect(seriesChart(page).getByRole('figure')).toContainText('Flow — observed gauge');
	await expect(seriesRow(page, 'Flow — observed gauge').getByRole('button', { name: 'View', exact: true })).toHaveAttribute('aria-pressed', 'true');
	// Uploading is Add data only: the page has no form of its own.
	await expect(page.getByLabel('CSV file')).toHaveCount(0);
});

test('the retired #upload-csv link opens Add data for an editor and lands a viewer on the series; ?add=data opens it too', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Data old upload link');
	await putEnding(page.request, project.id, { kind: 'rain_catchment_mm', name: 'Gauge R1', endAgo: 1 });
	const dialog = page.getByRole('dialog', { name: 'Add data' });

	await page.goto(`/projects/${project.id}?tab=series#upload-csv`);
	await expect(dialog).toBeVisible();
	// The fragment goes, so a reload doesn't open it again.
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=series$`));
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await page.reload();
	await expect(seriesRows(page)).toHaveCount(1);
	await expect(dialog).toBeHidden();

	// The project list's Add data link: the dialog opens once, and the param goes.
	await page.goto(`/projects/${project.id}?add=data`);
	await expect(dialog).toBeVisible();
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();

	// A viewer can't upload: the old link lands on the series, and ?add=data opens nothing.
	const viewer = await signIn('Data old link viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.goto(`/projects/${project.id}?tab=series#upload-csv`);
	await expect(v.getByRole('heading', { level: 2, name: 'Input time series' })).toBeFocused();
	await expect(v.getByRole('dialog', { name: 'Add data' })).toHaveCount(0);
	await v.goto(`/projects/${project.id}?add=data`);
	await expect(v.getByRole('heading', { level: 1 })).toBeVisible();
	await expect(v).toHaveURL(new RegExp(`/projects/${project.id}$`));
	await expect(v.getByRole('dialog', { name: 'Add data' })).toHaveCount(0);
});

test('a viewer sees the same freshness, Preview all data, and no Add data or Delete; desktop and phone have no violations', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Data viewer');
	await seedFreshnessMix(page.request, project.id);
	const viewer = await signIn('Data viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.setViewportSize({ width: 1440, height: 960 });
	await openData(v, project.id);
	await chartReady(v);

	await expect(v.getByTestId('series-behind')).toHaveCount(2);
	await expect(v.getByRole('button', { name: 'Preview all data' })).toBeVisible();
	await expect(v.getByRole('button', { name: 'Add data' })).toHaveCount(0);
	await expect(v.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
	await expect(v.getByLabel('CSV file')).toHaveCount(0);
	// Five series: all shown, no fold; nothing scrolls inside itself.
	await expect(seriesRows(v)).toHaveCount(5);
	await expect(v.getByRole('button', { name: /^Show all/ })).toHaveCount(0);
	expect(await innerScrollers(v)).toEqual([]);
	await expectNoViolations(v);

	await v.setViewportSize({ width: 390, height: 844 });
	await expect(seriesRows(v).first()).toBeVisible();
	expect(await innerScrollers(v)).toEqual([]);
	await expectNoViolations(v);
});

test('with no series the header offers only Add data, the empty state points at it, and an upload from there is listed and charted', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Data empty');
	await openData(page, project.id);
	await expect(page.getByText('No time series yet.')).toContainText('as CSV files with Add data.');
	await expect(page.getByLabel('CSV file')).toHaveCount(0);
	// The empty state's own button opens the same dialog as the header's; Escape gives focus back to it.
	const fromEmpty = page.getByRole('region', { name: 'Input time series' }).getByRole('button', { name: 'Add a data file' });
	const dialog = page.getByRole('dialog', { name: 'Add data' });
	await fromEmpty.click();
	await expect(dialog).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(fromEmpty).toBeFocused();
	await expect(page.getByTestId('section-context')).toHaveText('No input series yet');
	await expect(page.getByRole('button', { name: 'Preview all data' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Add data' })).toBeVisible();
	await expect(page.getByRole('button', { name: /^Show all/ })).toHaveCount(0);
	// An upload takes the empty state (and the button) away: the new series is listed and charted, and focus
	// lands on the series panel's heading rather than falling to the page.
	await fromEmpty.click();
	await dialog.getByLabel('CSV file').setInputFiles(fixture('rainfall-daily.csv'));
	await dialog.getByRole('button', { name: 'Upload' }).click();
	await expect(dialog).toBeHidden();
	await expect(seriesRows(page)).toHaveCount(1);
	await chartReady(page);
	await expect(page).toHaveURL(/[?&]series=/);
	await expect(page.getByRole('heading', { level: 2, name: 'Input time series' })).toBeFocused();
});

test('gauge vs logger flows with the page: the flagged and latest water years, the rest under “Show all”, no inner scroll; its link lands on Calibration record', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Data agreement fold');
	// About 30 water years of both records; the logger reads a third of the gauge in one year (2004/05).
	const start = '1994-10-01';
	const days = 30 * 365;
	const gauge = Array.from({ length: days }, (_, d) => 1 + (d % 30) / 30);
	const logger = gauge.map((v, d) => (d >= 10 * 365 && d < 11 * 365 ? v / 3 : v));
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', name: 'Weir', unit: 'm³/s', startDate: start, values: gauge });
	await putSeries(page.request, project.id, { kind: 'flow_logger_m3s', name: 'Logger', unit: 'm³/s', startDate: start, values: logger });
	await openData(page, project.id);
	const panel = page.locator('#data-agreement');
	await expect(panel.getByRole('heading', { level: 2, name: 'Gauge vs logger agreement' })).toBeVisible();
	const more = panel.getByRole('button', { name: /^Show all \d+ water years$/ });
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	await expect(panel.getByText('disagree', { exact: true })).toHaveCount(1);
	expect(await innerScrollers(page)).toEqual([]);
	await expectNoViolations(page);
	await more.click();
	await expect(panel.getByRole('button', { name: 'Show only the flagged and latest years' })).toHaveAttribute('aria-expanded', 'true');
	expect(await innerScrollers(page)).toEqual([]);

	await panel.getByRole('link', { name: 'choose the calibration flow series' }).click();
	await expect(page).toHaveURL(/[?&]tab=settings#set-record$/);
	await expect(page.getByRole('heading', { level: 2, name: 'Calibration record' })).toBeFocused();
});

for (const size of [
	{ width: 1024, height: 768 },
	{ width: 1280, height: 800 }
]) {
	test(`with 30 series the table fits its column beside the sidebar at ${size.width} px: no sideways scroll, Delete in view`, async ({ page, owner }) => {
		void owner;
		await page.setViewportSize(size);
		const project = await createProject(page.request, `Data fit ${size.width}`);
		const kinds = ['rain_catchment_mm', 'rain_chirps_mm', 'flow_observed_m3s', 'flow_logger_m3s', 'evap_apan_mm', 'rain_catchment_alt_mm'];
		for (let i = 0; i < 30; i++)
			await putEnding(page.request, project.id, { kind: kinds[i % kinds.length]!, name: `Station ${String(i + 1).padStart(2, '0')} with a long descriptive name`, endAgo: 2, length: 800 });
		await openData(page, project.id);
		await chartReady(page);
		const wrap = page.getByRole('region', { name: 'Input time series' }).locator('.table-wrap');
		expect(await wrap.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
		const del = seriesRows(page).first().getByRole('button', { name: /^Delete/ });
		await del.scrollIntoViewIfNeeded();
		await expect(del).toBeInViewport();
		// From folds under Data up to when the column is narrow; a screen reader still has the From column.
		await expect(seriesTable(page).getByRole('columnheader', { name: 'From' })).toHaveCount(1);
	});
}

test('a failed refresh of the series list keeps the table and says so', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Data refresh fails');
	await seedFreshnessMix(page.request, project.id);
	// The page's own list load goes through; the tab's refresh on mount (the second list request) fails.
	let lists = 0;
	await page.route(/\/projects\/[^/]+\/series$/, async (route) => {
		if (route.request().method() !== 'GET') return route.fallback();
		lists++;
		if (lists === 2) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Internal error' }) });
		await route.fallback();
	});
	await openData(page, project.id);
	await expect(page.getByTestId('refresh-error')).toBeVisible();
	await expect(seriesRows(page)).toHaveCount(5);
	await page.getByTestId('refresh-error').getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByTestId('refresh-error')).toHaveCount(0);
	await expect(seriesRows(page)).toHaveCount(5);
});

test('new data since the latest run is one notice, the page’s: after an upload, after a correction of old days, and with an automatic re-run queued', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Data new since run');
	await createRun(page.request, project.id, 'Baseline');
	await openData(page, project.id);
	const notices = page.getByTestId('notice-line').getByRole('status');
	await expect(notices).toHaveCount(0);

	// An upload of new days: the page's banner, with Re-run model; nothing repeats it.
	await page.getByRole('button', { name: 'Add data', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Add data' });
	await dialog.getByLabel('Kind').selectOption('rain_catchment_mm');
	await dialog.getByLabel('CSV file', { exact: false }).setInputFiles(csv('rain.csv', 'date,value\n2022-01-29,4\n2022-01-30,0\n'));
	await dialog.getByRole('button', { name: 'Upload and merge' }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByRole('status').filter({ hasText: /New data since|Updated “/ })).toHaveCount(1);
	await expect(page.getByRole('button', { name: 'Re-run model' })).toHaveCount(1);
	await expect(page.getByRole('link', { name: 'Re-run the model' })).toHaveCount(0);

	// After a reload (no banner), a correction that only changes old days still counts: it changed after the run.
	const fresh = await seedRunnableProject(page.request, 'Data correction since run');
	await createRun(page.request, fresh.id, 'Baseline');
	await page.request.post(`${API_URL}/projects/${fresh.id}/series/merge`, { data: { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-02', values: [7] } });
	await openData(page, fresh.id);
	await expect(page.getByTestId('notice-line').getByRole('status')).toContainText('New data since the last run (Rainfall — catchment).');
	await expect(page.getByTestId('notice-line').getByRole('button', { name: 'Re-run model' })).toBeVisible();

	// Automatic runs on, a re-run queued: the notice says when, and offers no button.
	const auto = await seedRunnableProject(page.request, 'Data queued rerun');
	await createRun(page.request, auto.id, 'Baseline');
	await updateSettings(page.request, auto.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: [2000, 1500, 1000, 1000, 1000, 1500, 2500, 4000, 5000, 5000, 4000, 3000],
		autoRun: { enabled: true, debounceMinutes: 60, publish: 'never' }
	});
	await page.request.post(`${API_URL}/projects/${auto.id}/series/merge`, { data: { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2022-01-29', values: [4, 0] } });
	await openData(page, auto.id);
	await expect(page.getByTestId('rerun-queued')).toContainText('An automatic re-run');
	await expect(page.getByRole('button', { name: 'Re-run model' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Re-run the model' })).toHaveCount(0);
});
