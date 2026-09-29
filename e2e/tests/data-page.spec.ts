// The Data section (?tab=series, issue #17 option A): the input series freshness first, the series behind (the
// sidebar badge's count and rule) marked and listed first, the picked series charted (series=<id>), the table and
// the chart fitting the window, and Add data refreshing the list. Synthetic series only.
import { fileURLToPath } from 'node:url';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject } from '../support/api.ts';
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
	await expect(page.getByTestId('section-context')).toHaveText('5 input series · 2 behind');
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
	await expect(page.getByTestId('series-summary')).toContainText('2 behind (more than 7 days old)');

	// Freshness first in the columns too: Data up to comes straight after the series.
	await expect(seriesTable(page).getByRole('columnheader')).toHaveText(['Series', 'Data up to', 'Period', /^Missing/, /^Typical/, 'Coverage by year', 'Actions']);
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

test('with 30 series at 1440×960 the table and the chart fill the window: the rows scroll in their box, the chart stays in view', async ({ page, owner }) => {
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
	await expect(seriesRows(page)).toHaveCount(30);

	// The behind series (5 A-pan) lead the table, and the badge counts the same 5.
	await expect(page.getByTestId('series-behind')).toHaveCount(5);
	for (let i = 0; i < 5; i++) await expect(seriesRows(page).nth(i).getByTestId('series-behind')).toBeVisible();
	await expect(sections(page).getByRole('link', { name: /^Data/ })).toContainText('(5 series behind)');

	// The block reaches the window's bottom (less its 1rem margin); the table scrolls inside its box; the chart is in view.
	const block = page.locator('.first.fit');
	await expect(block).toHaveCount(1);
	const box = (await block.boundingBox())!;
	expect(Math.abs(box.y + box.height - (960 - 16))).toBeLessThanOrEqual(4);
	const wrap = page.locator('.table-wrap').filter({ has: page.locator('table.series') });
	expect(await wrap.evaluate((el) => el.scrollHeight > el.clientHeight + 100)).toBe(true);
	await expect(seriesChart(page)).toBeInViewport({ ratio: 1 });
	await expect(seriesRows(page).first()).toBeInViewport();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await expectNoViolations(page);

	// A phone stacks: nothing fitted, no sideways scroll, the rows as cards.
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(block).toHaveCount(0);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	expect(await wrap.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
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
	await expectNoViolations(v);

	await v.setViewportSize({ width: 390, height: 844 });
	await expect(seriesRows(v).first()).toBeVisible();
	await expectNoViolations(v);
});

test('with no series the header offers only Add data, the empty state points at it, and an upload from there is listed and charted', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Data empty');
	await openData(page, project.id);
	await expect(page.getByText('No time series yet.')).toContainText('as CSV files with Add data.');
	await expect(page.getByLabel('CSV file')).toHaveCount(0);
	// The empty state's own button opens the same dialog as the header's; Escape gives focus back to it.
	const fromEmpty = page.getByRole('region', { name: 'Input time series' }).getByRole('button', { name: 'Upload a CSV' });
	const dialog = page.getByRole('dialog', { name: 'Add data' });
	await fromEmpty.click();
	await expect(dialog).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(fromEmpty).toBeFocused();
	await expect(page.getByTestId('section-context')).toHaveText('No input series yet');
	await expect(page.getByRole('button', { name: 'Preview all data' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Add data' })).toBeVisible();
	await expect(page.locator('.first.fit')).toHaveCount(0);
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
