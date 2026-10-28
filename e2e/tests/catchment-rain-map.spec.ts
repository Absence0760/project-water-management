// Model settings → Model selection for flow generation → The catchment's rainfall station → Catchment MAP (issue #612
// follow-up, docs/ui.md § Model settings, docs/model.md §2.4i). On the sample model with one invented rainfall station
// (Ridge, MAP 600 mm) as the catchment's station:
// - Blank, the field stands for the land units' area-weighted mean MAP.
// - A MAP typed without its source says what's missing; with its source the line gives the ratio (750 ÷ 600 = × 1.25).
// - Saved, the setting holds the pair, and a run scales the station's rain by it (its summary's catchment ratio).
// - Cleared, the pair goes (stored as none), so the engine takes the units' mean again.
import { createRun, seedRunnableProject, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { openSettings, saveSettings } from '../support/settings.ts';

type Stored = { project: { settings: { rainStations?: { catchment?: unknown; catchmentMapMm?: number; catchmentMapSource?: string } | null } } };

test('the catchment’s MAP is entered with its source, saved, and scales the catchment station’s rain in a run', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Catchment MAP');
	const res = await page.request.put(`${API_URL}/projects/${project.id}/series`, {
		data: {
			kind: 'rain_catchment_mm',
			name: 'Ridge station',
			unit: 'mm',
			startDate: '2021-10-01',
			values: Array.from({ length: 120 }, (_, i) => (i % 5 === 0 ? 8 : 0)),
			station: { mapMm: 600, mapSource: 'Ridge’s invented record' }
		}
	});
	expect(res.status(), await res.text()).toBe(200);
	const ridge = ((await res.json()) as { id: string }).id;
	await updateSettings(page.request, project.id, { rainStations: { catchment: { stationId: ridge } } });

	await openSettings(page, project.id);
	const card = page.locator('#set-share').getByTestId('flowgen-catchment');
	const map = card.getByLabel('Catchment MAP (mm)');
	const source = card.getByLabel('MAP source');
	await expect(map).toHaveValue('');
	await expect(card.getByTestId('flowgen-catchment-map-now')).toContainText('Blank: the land units’ area-weighted mean');

	// A MAP alone says it needs its source.
	await map.fill('750');
	await map.press('Tab');
	await expect(card.getByTestId('flowgen-catchment-map-error')).toHaveText('The catchment MAP needs its source: the study or isohyet map it was read from.');
	await expect(card.getByTestId('flowgen-catchment-ratio')).toHaveText('The station’s rain × 1.25: 750 mm ÷ its 600 mm.');
	await source.fill('an invented isohyet study, 1991–2020');
	await source.press('Tab');
	await expect(card.getByTestId('flowgen-catchment-map-error')).toHaveCount(0);
	await expect(card.getByTestId('flowgen-catchment-map-now')).toContainText('Entered: replaces the land units’ area-weighted mean');

	await saveSettings(page);
	const stored = (await (await page.request.get(`${API_URL}/projects/${project.id}`)).json()) as Stored;
	expect(stored.project.settings.rainStations).toEqual({ catchment: { stationId: ridge }, catchmentMapMm: 750, catchmentMapSource: 'an invented isohyet study, 1991–2020' });

	// A run takes the station's rain to the entered MAP.
	const runId = await createRun(page.request, project.id, 'Catchment MAP 750');
	const run = (await (await page.request.get(`${API_URL}/projects/${project.id}/runs/${runId}`)).json()).run;
	expect(run.summary.stations.catchmentMapMm).toBe(750);
	expect(run.summary.stations.catchmentMapFromUnits).toBe(false);
	expect(run.summary.stations.catchment.ratio).toBeCloseTo(1.25, 12);

	// Cleared, the pair goes: the units' mean again, stored as none.
	await map.fill('');
	await map.press('Tab');
	await source.fill('');
	await source.press('Tab');
	await expect(card.getByTestId('flowgen-catchment-map-now')).toContainText('Blank: the land units’ area-weighted mean');
	await saveSettings(page);
	const after = (await (await page.request.get(`${API_URL}/projects/${project.id}`)).json()) as Stored;
	expect(after.project.settings.rainStations).toEqual({ catchment: { stationId: ridge } });
});
