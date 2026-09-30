// The observed flow's per-day quality flags on the charts (CR-18 follow-on,
// engine ≥ 1.48.0, docs/ui.md § Runs and § Data): a run stores the scored
// record's classes (`observed_flow_quality`), and the Runs hydrograph draws
// them as strips along the foot of the plot with a text key saying how many
// days each class holds and what Fit automatically does with them; the Data
// tab's chart of the record shows the same classes under the current
// settings. Synthetic records only.
import { createRun, seedRunnableProject, updateSettings } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';

test('the hydrograph and the Data tab mark the days above the highest gauging, with a text key', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Flow quality flags');
	// The synthetic record peaks at 0.35 m³/s every 9th day: 14 of its 120 days are above 0.3.
	await updateSettings(page.request, project.id, {
		runoffModel: 'gr4j',
		qualityFlags: { ratings: { flow_observed_m3s: { gaugedMaxM3s: 0.3, gaugedMinM3s: null, source: 'Synthetic rating table' } } }
	});
	const runId = await createRun(page.request, project.id, 'Rated');
	await page.goto(`/projects/${project.id}?tab=runs&run=${runId}`);
	const hydro = page.locator('#res-hydrograph figure').first();
	await expect(hydro).toHaveAttribute('data-ready', 'true');
	await expect(hydro).toHaveAttribute('data-lanes', '1');
	const key = hydro.locator('.lane-key');
	await expect(key.locator('strong')).toHaveText('Observed flow quality flags');
	// The run's own settings: days above the rating are censored by default.
	await expect(key.getByRole('listitem')).toHaveText(['Above the highest gauging: 14 days; Fit automatically: censored at the highest gauging']);
	await expectNoViolations(page, { include: '#res-hydrograph' });

	// The Data tab: the same days on the record's own chart, under the current settings (now left out).
	await updateSettings(page.request, project.id, { qualityFlags: { aboveRating: 'exclude' } });
	await page.goto(`/projects/${project.id}?tab=series`);
	await page.getByRole('region', { name: 'Input time series' }).getByRole('row').filter({ hasText: 'Flow — observed gauge' }).getByRole('button', { name: 'View', exact: true }).click();
	const chart = page.locator('#data-chart figure.chart');
	await expect(chart).toHaveAttribute('data-lanes', '1');
	await expect(chart.locator('.lane-key').getByRole('listitem')).toHaveText(['Above the highest gauging: 14 days; Fit automatically: left out']);

	// Without a gauged range no day is flagged: no strips, and no key.
	await updateSettings(page.request, project.id, { qualityFlags: { ratings: {} } });
	await page.reload();
	await expect(page.locator('#data-chart figure.chart canvas')).toBeVisible();
	await expect(page.locator('#data-chart figure.chart')).not.toHaveAttribute('data-lanes');
	await expect(page.locator('#data-chart .lane-key')).toHaveCount(0);
});
