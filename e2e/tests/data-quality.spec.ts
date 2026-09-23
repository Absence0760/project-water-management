import { createProject, putSeries } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

// Synthetic records only. The gauge reads 80 % of the logger for 120 days of
// one water year; the logger has one negative reading.
const START = '2020-10-01';
const DAYS = 120;

test('gauge-vs-logger thresholds are a project setting the Time series tab applies', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Data quality');
	// Varying values, so neither record has a flat stretch.
	const logger = Array.from({ length: DAYS }, (_, i) => 1 + (i % 7) / 10);
	const gauge = logger.map((v) => Math.round(v * 0.8 * 1000) / 1000);
	logger[5] = -0.4;
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', name: 'Gauge', unit: 'm3/s', startDate: START, values: gauge });
	await putSeries(page.request, project.id, { kind: 'flow_logger_m3s', name: 'Logger', unit: 'm3/s', startDate: START, values: logger });

	// Default thresholds (67–150 %): 80 % agrees.
	await page.goto(`/projects/${project.id}?tab=series`);
	const agreement = page.getByRole('region', { name: 'Gauge vs logger agreement' });
	await expect(agreement.getByText('The two records agree in every water year compared.')).toBeVisible();
	await expect(agreement.getByText(/below 67% or above 150%/)).toBeVisible();
	const checks = page.getByTestId('series-checks');
	await expect(checks.getByRole('listitem')).toHaveCount(1);
	await expect(checks.getByRole('listitem')).toContainText('Negative values');
	await expect(checks.getByRole('listitem')).toContainText('2020-10-06: -0.4 m³/s');

	// Tighten the lowest ratio to 90 % in Settings.
	await page.goto(`/projects/${project.id}?tab=settings`);
	const min = page.getByLabel('Lowest gauge/logger ratio (%)');
	await expect(min).toHaveValue('66.666666667');
	const save = page.getByRole('button', { name: 'Save settings' });
	// Out of the input's range: marked invalid and not taken.
	await min.fill('0');
	await expect(min).toHaveAttribute('aria-invalid', 'true');
	await expect(save).toBeDisabled();
	// In range but not a whole number of days: Save is blocked with a message.
	const days = page.getByLabel('Minimum shared days (days)');
	await days.fill('30.5');
	await expect(page.getByRole('alert')).toHaveText('Minimum shared days must be a whole number from 1 to 366.');
	await expect(save).toBeDisabled();
	await days.fill('90');
	await min.fill('90');
	await save.click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();

	await page.goto(`/projects/${project.id}?tab=series`);
	await expect(agreement.getByText('1 water year disagree:')).toBeVisible();
	await expect(agreement.getByText(/below 90% or above 150%/)).toBeVisible();
	await expect(agreement.getByRole('row', { name: /2020\/21/ })).toContainText('disagree');
});
