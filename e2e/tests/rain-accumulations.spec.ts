import { createProject, putSeries } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { saveChanges, saveSettings } from '../support/settings.ts';

// Audit B4 (engine ≥ 0.20.0): a multi-day accumulation in the catchment rain.
// Synthetic records only: CHIRPS reads 4 mm every third day April–September
// and 1 mm every ninth day otherwise over water years 2010/11–2015/16, and the
// catchment reads twice that, except that its gauge was not read for 20 days
// in June 2012: those days read 0 and 2012-06-21 holds the lot, on a day CHIRPS
// was dry (and the days either side). Too short a run for the zero-run check.
async function seedAccumulation(request: Parameters<typeof createProject>[0], name: string): Promise<string> {
	const project = await createProject(request, name);
	const start = Date.UTC(2010, 9, 1);
	const days = (Date.UTC(2016, 9, 1) - start) / 86_400_000;
	const monthOf = (i: number) => new Date(start + i * 86_400_000).getUTCMonth() + 1;
	const index = (iso: string) => (Date.parse(iso) - start) / 86_400_000;
	const chirps = Array.from({ length: days }, (_, i) => (monthOf(i) >= 4 && monthOf(i) <= 9 ? (i % 3 === 0 ? 4 : 0) : i % 9 === 0 ? 1 : 0));
	const reading = index('2012-06-21');
	for (const i of [reading - 1, reading, reading + 1]) chirps[i] = 0;
	const catchment = chirps.map((v) => v * 2);
	let total = 0;
	for (let i = reading - 20; i < reading; i++) {
		total += catchment[i]!;
		catchment[i] = 0;
	}
	catchment[reading] = total;
	await putSeries(request, project.id, { kind: 'rain_catchment_mm', name: 'Catchment rain', unit: 'mm', startDate: '2010-10-01', values: catchment });
	await putSeries(request, project.id, { kind: 'rain_chirps_mm', name: 'CHIRPS', unit: 'mm', startDate: '2010-10-01', values: chirps });
	return project.id;
}

test('a multi-day accumulation is shaded as spread until Settings keeps the reading as recorded', async ({ page, owner }) => {
	void owner;
	const projectId = await seedAccumulation(page.request, 'Rain accumulation');
	const chart = page.locator('figure.chart');
	const tab = (name: string) => page.getByRole('link', { name, exact: true });
	const viewCatchment = async () => {
		await page.getByRole('row', { name: /Catchment rain/ }).getByRole('button', { name: 'View', exact: true }).click();
		await expect(page.getByRole('img', { name: /^Rainfall — catchment · Catchment rain: line chart/ }).locator('canvas')).toBeVisible();
	};
	// The window is the unread days plus the fixture's own dry days just before them.
	const shaded = page.getByText(/Shaded: 1 multi-day accumulation, 2\d days, whose recorded total a run spreads over the days it covers by CHIRPS\./);

	await page.goto(`/projects/${projectId}?tab=series`);
	await viewCatchment();
	await expect(shaded).toBeVisible();
	await expect(chart).toHaveAttribute('data-shaded', '1');

	// Settings → Rain gaps: spread is the default; keep the reading as recorded (a reason is required).
	await tab('Settings & calibration').click();
	const section = page.getByTestId('zero-rain-settings');
	const mode = section.getByLabel('Accumulated readings');
	await expect(mode).toHaveValue('spread');
	const keep = section.getByRole('group', { name: /^Keep as recorded/ });
	await expect(keep.getByText('None: every flagged accumulation is spread.')).toBeVisible();
	await keep.getByRole('button', { name: "Keep a date range's readings" }).click();
	await keep.getByLabel('From').fill('2012-06-21');
	await keep.getByLabel('To').fill('2012-06-21');
	const save = saveChanges(page);
	await expect(keep.getByRole('alert')).toHaveText('Keep-reading period 1: needs a reason.');
	await expect(save).toBeDisabled();
	await keep.getByLabel('Reason').fill('Thunderstorm, farm records agree');
	await saveSettings(page);

	// The Data tab follows the saved settings.
	// Its old rain is behind, so the section's link carries the badge's count in its name.
	await page.getByRole('link', { name: /^Data \(\d+ series behind\)$/ }).click();
	await viewCatchment();
	await expect(shaded).toHaveCount(0);
	await expect(chart).not.toHaveAttribute('data-shaded');

	// A window listed by hand is validated the same way and spread again.
	await tab('Settings & calibration').click();
	const add = section.getByRole('group', { name: /^Also spread/ });
	await add.getByRole('button', { name: 'Add a date range' }).click();
	await add.getByLabel('From').fill('2012-06-10');
	await add.getByLabel('To').fill('2012-06-21');
	await expect(add.getByRole('alert')).toHaveText('Listed accumulation 1: needs a reason.');
	await expect(save).toBeDisabled();
	await add.getByLabel('Reason').fill('Station log: gauge read after the observer returned');
	await saveSettings(page);
	// Its old rain is behind, so the section's link carries the badge's count in its name.
	await page.getByRole('link', { name: /^Data \(\d+ series behind\)$/ }).click();
	await viewCatchment();
	await expect(page.getByText('Shaded: 1 multi-day accumulation, 12 days, whose recorded total a run spreads over the days it covers by CHIRPS.')).toBeVisible();

	// "Run as recorded" hides the keep list and survives a reload.
	await tab('Settings & calibration').click();
	await mode.selectOption('asRecorded');
	await expect(section.getByRole('group', { name: /^Keep as recorded/ })).toHaveCount(0);
	await saveSettings(page);
	await page.reload();
	await expect(page.getByTestId('zero-rain-settings').getByLabel('Accumulated readings')).toHaveValue('asRecorded');
	await expect(page.getByTestId('zero-rain-settings').getByRole('group', { name: /^Also spread/ }).getByLabel('Reason')).toHaveValue(
		'Station log: gauge read after the observer returned'
	);
});
