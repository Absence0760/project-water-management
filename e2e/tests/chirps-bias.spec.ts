// CHIRPS fallback bias correction (engine audit B1). Synthetic records only:
// the catchment rain is blank for its last 30 days, and CHIRPS reads half the
// catchment rain throughout, so the pooled factor is exactly 2.
import { putSeries, seedRunnableProject, syntheticRain } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const START = '2021-10-01';
const DAYS = 120;

test('a run lists the CHIRPS factors it applied, and Settings can turn the correction off', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'CHIRPS bias');
	const rain = syntheticRain(DAYS);
	await putSeries(page.request, project.id, {
		kind: 'rain_catchment_mm',
		unit: 'mm',
		startDate: START,
		values: rain.map((v, i) => (i < DAYS - 30 ? v : null))
	});
	await putSeries(page.request, project.id, { kind: 'rain_chirps_mm', unit: 'mm', startDate: START, values: rain.map((v) => v / 2) });

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('Corrected');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Corrected' })).toBeVisible();
	// A note on how the input data were handled: folded away under the warnings to check (runs/credibility.ts).
	const dataNotes = page.getByTestId('warnings-data');
	await dataNotes.getByText(/notes? on how the input data were handled/).click();
	const note = dataNotes.getByRole('listitem').filter({ hasText: 'CHIRPS rain bias-corrected' });
	await expect(note).toContainText('on 30 days where catchment rain is blank');
	await expect(note).toContainText('Oct 2.00 (pooled), Nov 2.00 (pooled)');

	await page.goto(`/projects/${project.id}?tab=settings`);
	const mode = page.getByLabel('CHIRPS bias correction', { exact: true });
	await expect(mode).toHaveValue('monthly');
	await mode.selectOption('none');
	await expect(page.getByText(/^CHIRPS is used as stored/)).toBeVisible();
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
	await page.reload();
	await expect(mode).toHaveValue('none');

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('Raw');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Raw' })).toBeVisible();
	await expect(page.getByText(/CHIRPS rain bias-corrected/)).toHaveCount(0);
});
