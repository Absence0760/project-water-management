// The self-checks panel (engine 0.12.0): the model's checks on its own run,
// the water balance per water year, and the trace of one farm's day with its
// working columns (docs/ui.md § Self-checks).
import { createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

test('a run shows its self-checks, its water balance and a traced day that closes', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Self-checks');
	await createRun(page.request, project.id, 'Checked');
	await page.goto(`/projects/${project.id}?tab=runs`);
	await expect(page.getByRole('heading', { level: 2, name: 'Checked' })).toBeVisible();
	await page.getByRole('navigation', { name: 'Result sections' }).getByRole('link', { name: 'Self-checks' }).click();

	const checks = page.getByRole('region', { name: /^Self-checks/ });
	await expect(checks.getByRole('status').filter({ hasText: 'self-checks' })).toHaveText('All 6 self-checks passed.');
	await expect(checks.getByRole('listitem')).toHaveCount(6);

	// 120 days from 2021-10-01: one water year, then the whole run.
	const balance = page.getByRole('region', { name: 'Water balance by water year' });
	await expect(balance.getByRole('rowheader')).toHaveText(['2021/22', 'Whole run']);

	const trace = page.getByRole('region', { name: /^Trace a day/ });
	await trace.getByLabel('Farm or gauge').selectOption({ label: 'Upper farm' });
	await trace.getByLabel('Day').fill('2021-11-15');
	await trace.getByRole('button', { name: 'Trace' }).click();
	const table = trace.getByRole('table', { name: 'Upper farm on 2021-11-15' });
	await expect(table).toBeVisible();
	for (const name of ['Dam storage at the end of the day before', 'Soil-water store at the end of the day before', 'Soil-water store at the end of the day', 'Upstream inflow into the dam', 'Irrigation return flow', 'Balance check (should be 0)']) {
		await expect(table.getByRole('rowheader', { name, exact: true })).toBeVisible();
	}
	await expect(table.getByRole('row').filter({ hasText: 'Irrigation supplied' }).getByRole('cell').first()).toHaveText('G');
	// The day closes from the numbers shown: in − used − stored − out is 0 or float noise.
	await expect(trace.locator('.closure strong')).toHaveText(/^(-?0|-?\d\.\d{2}e-\d+)$/);
});
