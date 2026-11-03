// A data feed writing a series no run reads (issue #670; docs/ui.md § Runs & results, § Data): a run reads the first
// CHIRPS series by name, so a feed's "(boundary)" series beside an older gap-filler that no feed writes never reaches a
// run once the gap-filler stops. Run readiness names both and links the fixes; the Data rows say the same under their
// badges. Synthetic series only.
import { expectNoViolations } from '../support/a11y.ts';
import { putSeries, seedRunnableProject } from '../support/api.ts';
import { plantChirpsFeedDays } from '../support/db.ts';
import { openData } from '../support/data.ts';
import { expect, test } from '../support/fixtures.ts';

const rain = (n: number) => Array.from({ length: n }, (_, d) => (d % 5 === 0 ? 8 : 0));

test('Run readiness and the Data rows say when a feed’s series is not the one runs read, and the gap-filler has stopped', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Feed shadow');
	// The gap-filler runs read (first by name, no feed) ends 2022-01-28; the feed's series runs on to 2022-03-31.
	await putSeries(page.request, project.id, { kind: 'rain_chirps_mm', name: 'Rainfall CHIRPS gap-filler', unit: 'mm', startDate: '2021-10-01', values: rain(120) });
	await putSeries(page.request, project.id, { kind: 'rain_chirps_mm', name: 'Rainfall CHIRPS gap-filler (boundary)', unit: 'mm', startDate: '2021-10-01', values: rain(182) });
	await plantChirpsFeedDays(project.id, 'Rainfall CHIRPS gap-filler (boundary)');

	await page.goto(`/projects/${project.id}?tab=runs`);
	const note = page.getByTestId('run-feed-shadow');
	await expect(note).toHaveCount(1);
	await expect(note).toHaveAttribute('data-stalled', 'true');
	await expect(note).toContainText('Runs read “Rainfall CHIRPS gap-filler” (1 Oct 2021 to 28 Jan 2022) for Rainfall — CHIRPS, which no data feed writes');
	await expect(note).toContainText('a data feed writes “Rainfall CHIRPS gap-filler (boundary)” (1 Oct 2021 to 31 Mar 2022)');
	await expect(note.getByRole('link', { name: 'Rain from the boundary' })).toHaveAttribute('href', '?tab=series&rain=boundary#data-feeds');
	await expectNoViolations(page, { include: '[data-testid="run-feed-shadow"]' });

	// The rename link opens the series runs read, where its name can be changed.
	await note.getByRole('link', { name: 'Rainfall CHIRPS gap-filler' }).click();
	await expect(page.getByTestId('series-details').getByTestId('series-name')).toHaveValue('Rainfall CHIRPS gap-filler');

	await openData(page, project.id);
	// By the name cell alone: each row's words name the other series.
	const row = (name: string) => page.locator('tr[data-series]').filter({ has: page.locator('.nm', { hasText: new RegExp(`^${name.replace(/[()]/g, '\\$&')} \\(mm\\)$`) }) });
	const fed = row('Rainfall CHIRPS gap-filler (boundary)');
	await expect(fed.getByTestId('series-feed-shadow')).toContainText('A data feed writes this series, but runs read “Rainfall CHIRPS gap-filler”');
	await expect(fed.getByTestId('series-role')).toHaveText('Not used (another series of this kind is)');
	await expect(row('Rainfall CHIRPS gap-filler').getByTestId('series-feed-shadow')).toContainText('No data feed writes this series, so it ends 28 Jan 2022');
});

test('positive control: no note when the feed writes the series runs read', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Feed read');
	await putSeries(page.request, project.id, { kind: 'rain_chirps_mm', name: 'A CHIRPS feed', unit: 'mm', startDate: '2021-10-01', values: rain(182) });
	await putSeries(page.request, project.id, { kind: 'rain_chirps_mm', name: 'B uploaded', unit: 'mm', startDate: '2021-10-01', values: rain(120) });
	await plantChirpsFeedDays(project.id, 'A CHIRPS feed');
	await page.goto(`/projects/${project.id}?tab=runs`);
	await expect(page.getByTestId('run-catchment-rain')).toBeVisible();
	await expect(page.getByTestId('run-feed-shadow')).toHaveCount(0);
});
