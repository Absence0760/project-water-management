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
	await expect(min).toHaveValue('66.7');
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

// Issue #2: catchment rain recorded as 0 when it is really missing. Synthetic
// winter rain (4 mm every third day April–September, 1 mm every ninth day
// otherwise) as CHIRPS over water years 2010/11–2015/16; the catchment reads
// twice that, except in 2013/14 (two thirds of CHIRPS), and has 76 zero days in
// the 2012 wet season. Returns the project id.
async function seedZeroRain(request: Parameters<typeof createProject>[0], name: string): Promise<string> {
	const project = await createProject(request, name);
	const start = Date.UTC(2010, 9, 1);
	const days = (Date.UTC(2016, 9, 1) - start) / 86_400_000;
	const monthOf = (i: number) => new Date(start + i * 86_400_000).getUTCMonth() + 1;
	const index = (iso: string) => (Date.parse(iso) - start) / 86_400_000;
	const chirps = Array.from({ length: days }, (_, i) => (monthOf(i) >= 4 && monthOf(i) <= 9 ? (i % 3 === 0 ? 4 : 0) : i % 9 === 0 ? 1 : 0));
	const low = [index('2013-10-01'), index('2014-10-01')] as const;
	const catchment = chirps.map((v, i) => (i >= low[0] && i < low[1] ? (v * 2) / 3 : v * 2));
	for (let i = index('2012-06-01'); i <= index('2012-08-15'); i++) catchment[i] = 0;
	catchment[index('2012-05-31')] = 5;
	catchment[index('2012-08-16')] = 5;
	await putSeries(request, project.id, { kind: 'rain_catchment_mm', name: 'Catchment rain', unit: 'mm', startDate: '2010-10-01', values: catchment });
	await putSeries(request, project.id, { kind: 'rain_chirps_mm', name: 'CHIRPS', unit: 'mm', startDate: '2010-10-01', values: chirps });
	return project.id;
}

test('the Time series tab flags zero-rain runs and water years far below CHIRPS', async ({ page, owner }) => {
	void owner;
	const projectId = await seedZeroRain(page.request, 'Zero rain');

	await page.goto(`/projects/${projectId}?tab=series`);
	const items = page.getByTestId('series-checks').getByRole('listitem');
	await expect(items).toHaveCount(2);
	await expect(items.nth(0)).toContainText('Zero rain run');
	await expect(items.nth(0)).toContainText('2012-06-01 to 2012-08-15 (76 days, 76 in the wet season');
	await expect(items.nth(0)).toContainText('blocks the fallback to CHIRPS');
	await expect(items.nth(1)).toContainText('Low vs CHIRPS');
	await expect(items.nth(1)).toContainText('usual catchment / CHIRPS rain ratio (200 %)');
	await expect(items.nth(1)).toContainText('2013/14:');
	await expect(items.nth(1)).toContainText('67 % (365 days)');
});

// CR-20: a run treats the flagged zero run as missing (CHIRPS fills it). The
// Data tab shades those days; Settings → Zero-rain runs keeps a run dry or
// switches the rule off, and the shading follows the saved settings.
test('flagged zero-rain runs are shaded as missing until Settings keeps them dry', async ({ page, owner }) => {
	void owner;
	const projectId = await seedZeroRain(page.request, 'Zero rain settings');
	const chart = page.locator('figure.chart');
	const tab = (name: string) => page.getByRole('link', { name, exact: true });
	const shaded = page.getByText('Shaded: 1 period, 76 days, that a run treats as missing, so CHIRPS fills them (Settings → Zero-rain runs).');

	await page.goto(`/projects/${projectId}?tab=series`);
	await page.getByRole('row', { name: /Catchment rain/ }).getByRole('button', { name: 'View', exact: true }).click();
	await expect(page.getByRole('img', { name: /^Rainfall — catchment · Catchment rain: line chart/ }).locator('canvas')).toBeVisible();
	await expect(shaded).toBeVisible();
	await expect(chart).toHaveAttribute('data-shaded', '1');

	// Keep the run dry: a period needs a reason before Save is allowed.
	await tab('Settings & calibration').click();
	const mode = page.getByLabel('Flagged zero runs');
	await expect(mode).toHaveValue('missing');
	const keepDry = page.getByRole('group', { name: /^Keep dry/ });
	await expect(keepDry.getByText('None: every flagged zero run is treated as missing.')).toBeVisible();
	await keepDry.getByRole('button', { name: 'Keep a date range dry' }).click();
	await keepDry.getByLabel('From').fill('2012-06-01');
	await keepDry.getByLabel('To').fill('2012-08-15');
	const save = page.getByRole('button', { name: 'Save settings' });
	await expect(keepDry.getByRole('alert')).toHaveText('Keep-dry period 1: needs a reason.');
	await expect(save).toBeDisabled();
	await keepDry.getByLabel('Reason').fill('Farm records show no rain');
	await save.click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();

	// The Data tab follows the saved settings (in-app navigation, as a user moves between tabs).
	// Its old rain is behind, so the section's link carries the badge's count in its name.
	await page.getByRole('link', { name: /^Data \(\d+ series behind\)$/ }).click();
	await page.getByRole('row', { name: /Catchment rain/ }).getByRole('button', { name: 'View', exact: true }).click();
	await expect(page.getByRole('img', { name: /^Rainfall — catchment · Catchment rain: line chart/ }).locator('canvas')).toBeVisible();
	await expect(shaded).toHaveCount(0);
	await expect(chart).not.toHaveAttribute('data-shaded');

	// "Run as recorded" hides the keep-dry list and survives a reload.
	await tab('Settings & calibration').click();
	await expect(page.getByRole('group', { name: /^Keep dry/ }).getByLabel('Reason')).toHaveValue('Farm records show no rain');
	await mode.selectOption('asRecorded');
	await expect(page.getByRole('group', { name: /^Keep dry/ })).toHaveCount(0);
	await save.click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
	await page.reload();
	await expect(mode).toHaveValue('asRecorded');
});
