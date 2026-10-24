// Add data's "Rainfall — station" kind (issue #553, docs/ui.md § Header: data
// freshness and "Add data"): a station is a catchment rain series with its own
// MAP and the MAP's source, and optionally its coordinates, sent in the
// upload's own request. The fields check what the API checks before anything
// is sent. Synthetic stations and values only.
import { expectNoViolations } from '../support/a11y.ts';
import { csv, openAddData } from '../support/addData.ts';
import { createProject, putSeries, syntheticRain } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const DAYS = 'date,value\n2021-10-01,0\n2021-10-02,12.4\n2021-10-03,\n2021-10-04,3.1\n';

test('Add data adds a rainfall station with its MAP and coordinates, and the Data tab lists it', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Rain station');
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', name: 'Average', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(30) });
	await page.goto(`/projects/${project.id}?tab=series`);
	await expect(page.getByRole('region', { name: 'Input time series' })).toBeVisible();

	const dialog = await openAddData(page);
	const kind = dialog.getByLabel('Kind', { exact: true });
	// Today's catchment rain says where a station is picked instead.
	await expect(kind).toHaveAccessibleDescription(/For one gauge’s record with its own MAP, pick Rainfall — station\./);
	await kind.selectOption({ label: 'Rainfall — station' });
	await expect(kind).toHaveAccessibleDescription(/each can serve one or more hydrological units\. Until Settings has a Flow generation section, runs read catchment rainfall/);
	const name = dialog.getByLabel('Station name', { exact: true });
	await expect(name).toHaveValue('');
	const station = dialog.getByRole('group', { name: 'The station' });
	await expect(station).toBeVisible();

	await dialog.getByLabel('CSV file or DWS export', { exact: true }).setInputFiles(csv('bergwater.csv', DAYS));
	await expect(dialog.getByLabel('File summary')).toContainText('1 Oct 2021 → 4 Oct 2021');
	const upload = dialog.getByRole('button', { name: 'Upload', exact: true });
	// With the days read, what's missing is said under its field, and nothing can be sent.
	await expect(upload).toBeDisabled();
	await expect(name).toHaveAttribute('aria-invalid', 'true');
	await expect(name).toHaveAccessibleDescription('Give the station a name.');
	await name.fill('Bergwater');
	await expect(dialog.getByTestId('new-series-effect')).toContainText('Creates a second Rainfall — catchment series. Runs read the first by name, so they keep reading “Average”.');
	const map = station.getByLabel('MAP (mm)');
	await expect(map).toHaveAccessibleDescription(/Enter the station’s MAP\./);
	await map.fill('745');
	const mapSource = station.getByLabel('Source of the MAP');
	await expect(mapSource).toHaveAccessibleDescription(/A MAP needs its source\./);
	await mapSource.fill('Station record, 1991–2020');
	await station.getByLabel(/^Latitude/).fill('-33,92');
	const lon = station.getByLabel(/^Longitude/);
	await expect(lon).toHaveAccessibleDescription(/Give the longitude too, or leave both blank\./);
	await expect(upload).toBeDisabled();
	await lon.fill('18.86');
	await expect(dialog.locator('[aria-invalid="true"]')).toHaveCount(0);
	await expectNoViolations(page, { include: 'dialog[open]' });

	const sent = page.waitForRequest((r) => r.method() === 'PUT' && r.url() === `${API_URL}/projects/${project.id}/series`);
	await expect(upload).toBeEnabled();
	await upload.click();
	const body = (await sent).postDataJSON() as { kind: string; name: string; station: unknown };
	expect(body).toMatchObject({ kind: 'rain_catchment_mm', name: 'Bergwater', station: { mapMm: 745, mapSource: 'Station record, 1991–2020', lat: -33.92, lon: 18.86 } });
	await expect(dialog).toBeHidden();

	// Listed beside the catchment rain it sits with, and stored with its details.
	const table = page.getByRole('region', { name: 'Input time series' });
	await expect(table.getByRole('row').filter({ hasText: 'Bergwater' })).toHaveCount(1);
	await expect(table.getByRole('row').filter({ hasText: 'Average' })).toHaveCount(1);
	const res = await page.request.get(`${API_URL}/projects/${project.id}/series`);
	const { series } = (await res.json()) as { series: { name: string; station?: unknown }[] };
	expect(series.find((s) => s.name === 'Bergwater')?.station).toEqual({ mapMm: 745, mapSource: 'Station record, 1991–2020', lat: -33.92, lon: 18.86 });

	// Its name is offered for the station's next days, which are added to it without asking for the details again.
	const again = await openAddData(page);
	await again.getByLabel('Kind', { exact: true }).selectOption({ label: 'Rainfall — station' });
	await again.getByLabel('Station name', { exact: true }).fill('Bergwater');
	await expect(again.getByTestId('station-existing')).toHaveText('“Bergwater” is a station: MAP 745 mm (Station record, 1991–2020). The days are added to it.');
	await expect(again.getByRole('group', { name: 'The station' })).toHaveCount(0);
	await expect(again.getByRole('group', { name: /“Bergwater” already exists/ })).toBeVisible();
});
