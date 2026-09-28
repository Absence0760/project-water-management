// The reporting-window picker on Units & supply (issue #44, since issue #17; docs/ui.md §
// Units & supply): a viewer looks at the last 7 days without re-running or
// touching the project setting; the table worked out in the browser matches
// the engine's own table for that window, the EWR site setting each farm's
// charge included; the choice lives in the URL, so
// back / forward and a reload keep it; and the unit figures say they
// are over the whole record.
import { API_URL } from '../support/env.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createRun, seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import type { Locator } from '@playwright/test';

/** Each farm's whole row: the figures a window changes and the EWR site setting its charge. */
async function farmFigures(table: Locator): Promise<string[][]> {
	return Promise.all(
		['Upper farm', 'Lower farm'].map((name) =>
			table
				.getByRole('row', { name: new RegExp(`^${name}`) })
				.getByRole('cell')
				.evaluateAll((tds) => tds.map((td) => (td.textContent ?? '').trim()))
		)
	);
}

test('a viewer picks the last 7 days on Units & supply: worked out from the run, kept in the URL, the project setting untouched', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Report window');
	await updateSettings(page.request, project.id, { reportStart: '2021-11-01', reportEnd: '2021-12-31', ewrPragmaticM3PerDay: new Array(12).fill(1_000_000) });
	const first = await createRun(page.request, project.id, 'November to December');
	// The engine's own table over the last week of the record: a second run with that window set.
	await updateSettings(page.request, project.id, { reportStart: '2022-01-22', reportEnd: '2022-01-28' });
	const second = await createRun(page.request, project.id, 'Last week');
	await updateSettings(page.request, project.id, { reportStart: '2021-11-01', reportEnd: '2021-12-31' });

	const viewer = await signIn('Window viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	const panel = v.locator('#res-curtailment');
	const period = panel.getByTestId('curtailment-period');
	const table = panel.getByRole('table', { name: /^Curtailment targets per unit/ });
	const picker = panel.getByLabel('Reporting window');

	await v.goto(`/projects/${project.id}?tab=supply&run=${second}`);
	await expect(period).toHaveText('Project window: daily averages over 2022-01-22 – 2022-01-28 (7 days).');
	const engine = await farmFigures(table);
	// The reserve is set high enough to be short every day, so the farms carry a charge and the outlet sets it.
	expect(engine.map((row) => row.includes('Outflow gauge'))).toEqual([true, true]);

	await v.goto(`/projects/${project.id}?tab=supply&run=${first}`);
	await expect(period).toHaveText('Project window: daily averages over 2021-11-01 – 2021-12-31 (61 days).');
	await expect(picker).toHaveValue('project');
	await expect(picker.locator('option:checked')).toHaveText('Project window (2021-11-01 to 2021-12-31)');
	// The unit results table is over the whole record, and says so.
	await expect(v.getByTestId('farms-period')).toHaveText(
		'Daily averages over the whole record, 2021-10-01 to 2022-01-28 (120 days); the curtailment targets cover the reporting window.'
	);
	const november = await farmFigures(table);

	await picker.selectOption({ label: 'Last 7 days' });
	await expect(v).toHaveURL(/[?&]window=last7(&|$)/);
	await expect(period).toHaveText('Last 7 days: daily averages over 2022-01-22 – 2022-01-28 (7 days).');
	await expect(panel.getByRole('status')).toContainText('Worked out in your browser from this run\'s daily results: nothing is re-run, and the project setting is unchanged.');
	// The same row as the engine's run over that week, the binding EWR site included (issue #44).
	await expect(table.getByRole('columnheader', { name: /EWR site\s*setting the charge/ })).toBeVisible();
	expect(await farmFigures(table)).toEqual(engine);
	expect(engine).not.toEqual(november);

	await picker.selectOption({ label: 'Whole record' });
	await expect(v).toHaveURL(/[?&]window=all(&|$)/);
	await expect(period).toHaveText('Whole record: daily averages over 2021-10-01 – 2022-01-28 (120 days).');

	// Back and forward step through the windows looked at.
	await v.goBack();
	await expect(v).toHaveURL(/[?&]window=last7(&|$)/);
	await expect(picker).toHaveValue('last7');
	await expect(period).toHaveText('Last 7 days: daily averages over 2022-01-22 – 2022-01-28 (7 days).');
	await v.goBack();
	await expect(v).not.toHaveURL(/[?&]window=/);
	await expect(picker).toHaveValue('project');
	await expect(period).toHaveText('Project window: daily averages over 2021-11-01 – 2021-12-31 (61 days).');
	await v.goForward();
	await expect(period).toHaveText('Last 7 days: daily averages over 2022-01-22 – 2022-01-28 (7 days).');

	// A custom range starts from the days shown, and each date lands in the URL.
	await picker.selectOption({ label: 'Custom range' });
	await expect(v).toHaveURL(/[?&]window=2022-01-22\.\.2022-01-28(&|$)/);
	await panel.getByLabel('From', { exact: true }).fill('2021-12-01');
	await expect(v).toHaveURL(/[?&]window=2021-12-01\.\.2022-01-28(&|$)/);
	await panel.getByLabel('To', { exact: true }).fill('2021-12-10');
	await expect(v).toHaveURL(/[?&]window=2021-12-01\.\.2021-12-10(&|$)/);
	await expect(period).toHaveText('Custom range: daily averages over 2021-12-01 – 2021-12-10 (10 days).');
	// A reload keeps it.
	await v.reload();
	await expect(period).toHaveText('Custom range: daily averages over 2021-12-01 – 2021-12-10 (10 days).');
	await expect(panel.getByLabel('From', { exact: true })).toHaveValue('2021-12-01');

	// Nothing was saved: the setting is as it was and no run was made.
	const res = await page.request.get(`${API_URL}/projects/${project.id}`);
	const { project: saved } = (await res.json()) as { project: { settings: { reportStart: string; reportEnd: string } } };
	expect([saved.settings.reportStart, saved.settings.reportEnd]).toEqual(['2021-11-01', '2021-12-31']);
	const runs = await page.request.get(`${API_URL}/projects/${project.id}/runs`);
	expect(((await runs.json()) as { runs: unknown[] }).runs).toHaveLength(2);
});

test('the reporting-window picker passes axe in both themes and on a phone', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Report window a11y');
	const run = await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}?tab=supply&run=${run}&window=2021-12-01..2021-12-31`);
	const panel = page.locator('#res-curtailment');
	await expect(panel.getByTestId('curtailment-period')).toHaveText('Custom range: daily averages over 2021-12-01 – 2021-12-31 (31 days).');
	await expect(panel.getByLabel('From', { exact: true })).toBeVisible();
	await expectNoViolations(page, { include: '#res-curtailment' });
	await page.emulateMedia({ colorScheme: 'dark' });
	await expectNoViolations(page, { include: '#res-curtailment' });
	await page.setViewportSize({ width: 390, height: 844 });
	await expectNoViolations(page, { include: '#res-curtailment' });
	// No sideways scroll on a phone: the picker wraps.
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await page.emulateMedia({ colorScheme: 'light' });
	await expectNoViolations(page, { include: '#res-curtailment' });
});
