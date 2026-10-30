// Runs & results → the rainfall stations a run ran on (issue #553, docs/ui.md
// § Runs & results, docs/model.md §2.4i). A synthetic runnable project gets a
// rainfall station with its own MAP and a gap, and settings.rainStations
// assigns it to the catchment with an entered catchment MAP. Every run is Per
// unit since engine 1.109.0 (issue #658), so the stations show inside Rain for
// each unit, under Rainfall stations: the catchment's station, both MAPs, the
// ratio and the days by source, and the station's CHIRPS pairing (refused
// here: the project has no CHIRPS). An older run with stations but no rain for
// each unit heads the panel Rain from rainfall stations (stationRain.test.ts).
import { createRun, seedRunnableProject, syntheticRain, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const STATION_MAP = 745;
const CATCHMENT_MAP = 800;
const GAP_DAYS = 10;

test('a run whose catchment ran on a rainfall station shows its station, MAPs, ratio, days and pairing', async ({ page, owner }) => {
	void owner;
	const { id } = await seedRunnableProject(page.request, 'Station rain run');
	// The station: the seed's 120 days of rain, with a 10-day gap. Invented.
	const values = syntheticRain(120).map((v, i) => (i >= 40 && i < 40 + GAP_DAYS ? null : v));
	const res = await page.request.put(`${API_URL}/projects/${id}/series`, {
		data: { kind: 'rain_catchment_mm', name: 'Hill station', unit: 'mm', startDate: '2021-10-01', values, station: { mapMm: STATION_MAP, mapSource: 'synthetic station record' } }
	});
	expect(res.status(), await res.text()).toBe(200);
	const station = (await res.json()) as { id: string };
	await updateSettings(page.request, id, { rainStations: { catchment: { stationId: station.id }, catchmentMapMm: CATCHMENT_MAP, catchmentMapSource: 'synthetic isohyets' } });
	const runId = await createRun(page.request, id, 'On the station');

	// Model quality is on Calibration (issue #586 Round 3).
	await page.goto(`/projects/${id}?tab=calibration&run=${runId}`);
	const panel = page.getByTestId('run-unit-rain');
	await expect(panel.getByRole('heading', { level: 3, name: /^Rain for each unit/ })).toBeVisible();
	await expect(panel.getByRole('heading', { level: 4, name: 'Rainfall stations' })).toBeVisible();
	await expect(panel).toContainText(`Catchment MAP ${CATCHMENT_MAP} mm (entered).`);
	const rows = panel.getByTestId('run-station-row');
	await expect(rows).toHaveCount(1);
	const row = rows.first();
	await expect(row.getByRole('rowheader')).toHaveText(/\(catchment\)$/);
	await expect(row.getByRole('cell').first()).toContainText('Hill station');
	await expect(row.getByRole('cell').first()).toContainText(`× 1.07 (${CATCHMENT_MAP} ÷ ${STATION_MAP} mm)`);
	await expect(row.getByRole('cell').nth(1)).toHaveText(String(CATCHMENT_MAP));
	await expect(row.getByRole('cell').nth(2)).toHaveText(String(STATION_MAP));
	// The station's days are the run's days with a reading the checks keep; its gap isn't among them.
	await expect(row.getByRole('cell').nth(3)).not.toHaveText('0');
	await panel.getByText('Where each MAP comes from', { exact: true }).click();
	await expect(panel.getByTestId('run-station-sources')).toContainText('synthetic isohyets; Hill station: synthetic station record');
	// No CHIRPS in the project: the station's pairing is listed with why it was refused.
	const pairing = panel.getByTestId('run-station-pairing');
	await expect(pairing).toHaveCount(1);
	await expect(pairing).toHaveAttribute('data-refused', 'true');
	await expect(pairing.getByRole('rowheader')).toHaveText('Hill station');
	await expect(pairing.getByRole('cell').last()).toHaveText(/^refused: /);
	// Under the anchor Runs & results gave it, so old links still name it.
	await expect(page.locator('#res-unit-rain').getByTestId('run-unit-rain')).toBeVisible();
});
