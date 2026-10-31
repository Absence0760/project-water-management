// Model settings → Flow generation → Per unit: a unit's patching priority (issue #612, docs/ui.md §
// Model settings, docs/model.md §2.4i). On the sample model with three invented rainfall stations: Ridge (MAP 600 mm,
// a 10-day gap), Vlei (MAP 500 mm, a reading on every day) and Short (a record that starts after Ridge's gap).
// - A unit given Ridge starts with the corrected CHIRPS alone. Add a source adds Vlei (it can help); Up moves it first.
//   Vlei says it fills all of Ridge's gap days; Short is greyed out in the pull-down with why it can't help.
// - Saved, the setting holds the chain; a run patches Ridge's gaps from Vlei × unit MAP ÷ Vlei's MAP, and its panel
//   says so with the days.
// - The catchment's station (issue #612 follow-up): the same chain under The catchment's rainfall station, its fill
//   count over the run's days before a 14-day forecast tail, which it says it left out.
import type { APIRequestContext, Page } from '@playwright/test';
import { createRun, putModel, putSeries, seedRunnableProject, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { openSettings, saveSettings } from '../support/settings.ts';

type Node = { id: string; name: string; kind: string; mapMm?: number | null; mapSource?: string | null };

const GAP = [40, 50] as const;

async function seed(request: APIRequestContext) {
	const project = await seedRunnableProject(request, 'Rain patching priority');
	const [, upper] = project.model.nodes as Node[];
	upper!.mapMm = 900;
	upper!.mapSource = 'invented grid, 1991–2020';
	await putModel(request, project.id, project.model);
	const rain = (k: number) => Array.from({ length: 120 }, (_, i) => (i % 5 === 0 ? 8 * k : 0));
	const station = async (name: string, mapMm: number, values: (number | null)[]) => {
		const res = await request.put(`${API_URL}/projects/${project.id}/series`, {
			data: { kind: 'rain_catchment_mm', name, unit: 'mm', startDate: '2021-10-01', values, station: { mapMm, mapSource: `${name}’s invented record` } }
		});
		expect(res.status(), await res.text()).toBe(200);
		return ((await res.json()) as { id: string }).id;
	};
	const ridge = await station('Ridge station', 600, rain(1).map((v, i) => (i >= GAP[0] && i < GAP[1] ? null : v)));
	const vlei = await station('Vlei station', 500, rain(1.2));
	const short = await station('Short station', 550, rain(1).map((v, i) => (i < 100 ? null : v)));
	await updateSettings(request, project.id, { unitRain: { mode: 'perUnit' } });
	return { id: project.id, upper: upper!, ridge, vlei, short };
}

const panel = (page: Page) => page.locator('#set-share');
const row = (page: Page, unit: string) => panel(page).getByTestId('flowgen-row').filter({ hasText: unit });

test('a unit’s gaps are patched from an ordered list of stations, then CHIRPS, each station with what it fills', async ({ page, owner }) => {
	void owner;
	const { id, upper, ridge, vlei } = await seed(page.request);
	await openSettings(page, id);
	const upperRow = row(page, 'Upper farm');
	await upperRow.getByLabel('Station for Upper farm').selectOption(ridge);
	const chain = upperRow.getByRole('list', { name: 'Then patch gaps from, for Upper farm' });
	// The default: the corrected CHIRPS alone.
	await expect(chain.getByTestId('flowgen-patch-entry')).toHaveCount(1);
	await expect(upperRow.getByLabel('Patch source 1 for Upper farm', { exact: true })).toHaveValue('chirps');
	// Short has no reading on any of Ridge's gap days: greyed out, with why. Vlei can help.
	await expect(upperRow.getByLabel('Patch source 1 for Upper farm', { exact: true }).locator('option', { hasText: 'Short station' })).toBeDisabled();
	await expect(upperRow.getByLabel('Patch source 1 for Upper farm', { exact: true }).locator('option', { hasText: 'Short station' })).toContainText('can’t help: it has no reading on any of the main station’s');

	await upperRow.getByRole('button', { name: 'Add a source' }).click();
	await expect(upperRow.getByLabel('Patch source 2 for Upper farm', { exact: true })).toHaveValue(vlei);
	await upperRow.getByRole('button', { name: 'Move patch source 2 for Upper farm up' }).click();
	await expect(upperRow.getByLabel('Patch source 1 for Upper farm', { exact: true })).toHaveValue(vlei);
	await expect(upperRow.getByLabel('Patch source 2 for Upper farm', { exact: true })).toHaveValue('chirps');
	await expect(chain.getByTestId('flowgen-patch-fill')).toHaveText(/^fills 10 of the main station’s 10 gap days \(100 %\); gaps counted 2021-10-01 to 2022-01-28; record 2021-10-01 to /);
	// Vlei patches Upper farm, so it is a station in use, with its MAP.
	await expect(panel(page).getByTestId('flowgen-station').filter({ hasText: 'Vlei station' })).toContainText('Patches Upper farm.');

	await saveSettings(page);
	const stored = (await (await page.request.get(`${API_URL}/projects/${id}`)).json()) as { project: { settings: { rainStations: { units: Record<string, unknown> } } } };
	expect(stored.project.settings.rainStations.units[upper.id]).toEqual({ stationId: ridge, patch: [{ source: 'station', stationId: vlei }, { source: 'chirps' }] });

	// A run patches Ridge's 10 gap days from Vlei × 900 ÷ 500.
	const runId = await createRun(page.request, id, 'Patched from Vlei');
	// Rain for each unit sits among Calibration's later sections: its anchor opens it.
	await page.goto(`/projects/${id}?tab=calibration&run=${runId}#res-unit-rain`);
	const stationRow = page.getByTestId('run-unit-rain').getByTestId('run-station-row').filter({ hasText: 'Upper farm' });
	await expect(stationRow.getByRole('cell').first()).toContainText('gaps patched from Vlei station × 1.8 (10 days), then CHIRPS (0 days)');
	await expect(stationRow.getByRole('cell').nth(3)).toContainText('+ 10 from patch stations');
});

test('the catchment’s station takes a patching priority too, its fill count leaving the forecast tail out', async ({ page, owner }) => {
	void owner;
	const { id, ridge, vlei } = await seed(page.request);
	// A forecast after the record (2021-10-01 + 120 days): 14 days no run patches, so no gap a station could fill.
	await putSeries(page.request, id, { kind: 'rain_forecast_mm', unit: 'mm', startDate: '2022-01-29', values: Array.from({ length: 14 }, () => 1) });
	await openSettings(page, id);
	const card = panel(page).getByTestId('flowgen-catchment');
	// No station by default: the catchment rain series, as before stations.
	await expect(card.getByLabel('Station', { exact: true })).toHaveValue('');
	await card.getByLabel('Station', { exact: true }).selectOption(ridge);
	const chain = card.getByRole('list', { name: 'Then patch gaps from, for the catchment' });
	await expect(card.getByLabel('Patch source 1 for the catchment', { exact: true })).toHaveValue('chirps');
	// Short has no reading on any of Ridge's gap days before the forecast: greyed out, with why.
	const short = card.getByLabel('Patch source 1 for the catchment', { exact: true }).locator('option', { hasText: 'Short station' });
	await expect(short).toBeDisabled();
	await expect(short).toContainText('can’t help: it has no reading on any of the main station’s 10 gap days before the forecast');

	await card.getByRole('button', { name: 'Add a source' }).click();
	await expect(card.getByLabel('Patch source 2 for the catchment', { exact: true })).toHaveValue(vlei);
	await card.getByRole('button', { name: 'Move patch source 2 for the catchment up' }).click();
	// 10 gap days, not 24: the forecast's 14 are left out, and the line says so.
	await expect(chain.getByTestId('flowgen-patch-fill')).toHaveText(
		/^fills 10 of the main station’s 10 gap days \(100 %\); gaps counted 2021-10-01 to 2022-01-28, the run’s 14 forecast days left out; record 2021-10-01 to /
	);

	await saveSettings(page);
	const stored = (await (await page.request.get(`${API_URL}/projects/${id}`)).json()) as { project: { settings: { rainStations: { catchment: unknown } } } };
	expect(stored.project.settings.rainStations.catchment).toEqual({ stationId: ridge, patch: [{ source: 'station', stationId: vlei }, { source: 'chirps' }] });

	// Taking the station away again stores none.
	await card.getByLabel('Station', { exact: true }).selectOption('');
	await expect(card.getByTestId('flowgen-patch')).toHaveCount(0);
	await saveSettings(page);
	const after = (await (await page.request.get(`${API_URL}/projects/${id}`)).json()) as { project: { settings: { rainStations?: { catchment?: unknown } | null } } };
	expect(after.project.settings.rainStations?.catchment).toBeUndefined();
});
