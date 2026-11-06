// Calibration's verification against a reference gauge (docs/ui.md § Calibration → Verification against a reference
// gauge): a neighbouring river's record (`flow_reference_m3s`), scaled by area to the outlet, beside the shown run's
// simulated and natural flow there. Before its area is set the results say what's needed; an editor sets it under
// Calibration record, saves, and the hydrograph gains the scaled line with a table of KGE′, volume bias, r and the days
// compared, for both flows. A run never reads the record. Invented data only.
import { expectNoViolations } from '../support/a11y.ts';
import { createRun, putSeries, seedRunnableProject, syntheticFlow } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { openCalibration, saveSettings } from '../support/settings.ts';

test('an editor sets the reference gauge’s area, and Calibration compares its scaled record with simulated and natural flow', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Reference gauge check');
	// The neighbour: the same 120 days, a third more water (its units: m³/s, as a reference gauge is stored).
	await putSeries(page.request, project.id, { kind: 'flow_reference_m3s', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(120).map((v) => v * 1.3) });
	await createRun(page.request, project.id, 'Baseline');

	await openCalibration(page, project.id);
	const check = page.getByTestId('reference-check');
	// Not compared yet: the record is there, its area isn't.
	await expect(check).toHaveAttribute('data-state', 'no-area');
	await expect(check.getByTestId('reference-needs')).toContainText('set its catchment area under');
	await expect(check.getByRole('link', { name: 'Calibration record → Reference gauge for verification' })).toHaveAttribute('href', '#set-record');

	// Calibration record → Reference gauge for verification: its area; the outlet's is the model's (the units' 20 km²).
	const record = page.locator('#set-record');
	await expect(record.getByTestId('reference-gauge-factor')).toContainText('Set its catchment area');
	// Read-only until its own area is set (NumberInput keeps a read-only field focusable).
	await expect(record.getByLabel('Area at the outlet (km²)')).toHaveAttribute('readonly', '');
	await expect(record.getByLabel('Area at the outlet (km²)')).toHaveAttribute('placeholder', '20.00 (the model’s)');
	await record.getByLabel('Its catchment area (km²)').fill('40');
	await expect(record.getByTestId('reference-gauge-factor')).toContainText('Its record × 0.500 (outlet area ÷ its area)');
	await record.getByLabel('Name (optional)').fill('Neighbour weir');
	await saveSettings(page);
	const saved = (await (await page.request.get(`${API_URL}/projects/${project.id}`)).json()).project.settings.referenceGauge;
	expect(saved).toEqual({ areaKm2: 40, targetAreaKm2: null, name: 'Neighbour weir' });

	// The comparison: the factor, both flows over the 120 days the record and the run share, and its line on the hydrograph.
	await expect(check).toHaveAttribute('data-state', 'ready');
	await expect(check.getByRole('heading', { name: 'Verification against Neighbour weir' })).toBeVisible();
	await expect(check.getByTestId('reference-factor')).toHaveText('0.500');
	await expect(check.getByTestId('reference-caption')).toContainText('Verification only: a neighbouring catchment’s record, scaled by area to the outlet');
	await expect(check.getByTestId('reference-caption')).toContainText('20 km² at the outlet, the model’s catchment area ÷ its 40 km²');
	const table = check.getByTestId('reference-table');
	for (const row of ['simulated', 'natural']) {
		const cells = table.locator(`tr[data-row="${row}"] td`);
		await expect(cells).toHaveCount(4);
		await expect(cells.nth(0)).toHaveText(/^−?\d\.\d\d$/);
		await expect(cells.nth(1)).toHaveText(/^[+−]?\d+ %$/);
		await expect(cells.nth(3)).toContainText(/^120 \(/);
	}
	await expect(page.locator('#res-hydrograph')).toContainText('Neighbour weir × 0.500 (verification)');
	await expectNoViolations(page, { include: '[data-testid="reference-check"]' });

	// It is no model input: a run made now doesn't record it (its stored settings have no referenceGauge).
	const runId = await createRun(page.request, project.id, 'After');
	const run = (await (await page.request.get(`${API_URL}/projects/${project.id}/runs/${runId}`)).json()).run;
	expect(run.settings).not.toHaveProperty('referenceGauge');
});
