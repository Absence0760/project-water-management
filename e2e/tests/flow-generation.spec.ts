// Model settings → Flow generation (issue #553 round 3, issue #658; docs/ui.md § Model settings; docs/model.md §2.4h,
// §2.4i, §2.5). On the sample model with two invented rainfall stations beside its catchment rain series:
// - The panel leads Model settings with Per unit, the only method (issue #658: the Fragmentation / Per unit radio is
//   gone): a row per land unit, its station (stations only, no satellite option), Scale to unit MAP with the ratio it
//   gives, and the station correcting its CHIRPS; and each station in use once, with its MAP. Ticking units gives them
//   one station at once. Saved, the settings hold the rows as settings.rainStations.units, and a reload shows them again.
// - A fit made under Fragmentation (an engine before 1.109.0, its forcing recording no per-unit rain) reads
//   "Parameters not fitted for this method" in the panel, linking to Fit the parameters on Calibration, and in the
//   fit record there, until it is refitted.
import type { APIRequestContext, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { putModel, seedRunnableProject, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { openCalibration, openFold, openSettings, saveSettings } from '../support/settings.ts';

type Node = { id: string; name: string; kind: string; mapMm?: number | null; mapSource?: string | null };

/** The sample model with each farm's MAP (Upper 900 mm, Lower 600 mm), and two stations: Ridge (MAP 600 mm) and Vlei (MAP 500 mm). */
async function seed(request: APIRequestContext, name: string) {
	const project = await seedRunnableProject(request, name);
	const nodes = project.model.nodes as Node[];
	const [, upper, lower] = nodes;
	upper!.mapMm = 900;
	upper!.mapSource = 'invented grid, 1991–2020';
	lower!.mapMm = 600;
	lower!.mapSource = 'invented grid, 1991–2020';
	await putModel(request, project.id, project.model);
	const days = Array.from({ length: 120 }, (_, i) => (i % 5 === 0 ? 8 : 0));
	const station = async (stationName: string, mapMm: number) => {
		const res = await request.put(`${API_URL}/projects/${project.id}/series`, {
			data: { kind: 'rain_catchment_mm', name: stationName, unit: 'mm', startDate: '2021-10-01', values: days, station: { mapMm, mapSource: `${stationName}’s invented record` } }
		});
		expect(res.status(), await res.text()).toBe(200);
		return ((await res.json()) as { id: string }).id;
	};
	const ridge = await station('Ridge station', 600);
	const vlei = await station('Vlei station', 500);
	return { id: project.id, upper: upper!, lower: lower!, ridge, vlei };
}

const panel = (page: Page) => page.locator('#set-share');
const row = (page: Page, unit: string) => panel(page).getByTestId('flowgen-row').filter({ hasText: unit });
const storedSettings = async (request: APIRequestContext, id: string) =>
	((await (await request.get(`${API_URL}/projects/${id}`)).json()) as { project: { settings: { unitRain?: unknown; rainStations?: unknown } } }).project.settings;

test('Flow generation is Per unit, with no choice, and assigns each unit a rainfall station', async ({ page, owner }) => {
	void owner;
	const { id, upper, lower, ridge, vlei } = await seed(page.request, 'Flow generation');
	await openSettings(page, id);
	await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('Flow generation');
	// No method to pick (issue #658): Per unit, said in words.
	await expect(panel(page).getByRole('radio')).toHaveCount(0);
	await expect(panel(page).getByText('Fragmentation')).toHaveCount(0);
	await expect(panel(page).getByTestId('flowgen-method')).toContainText('Per unit');
	await expect(panel(page).getByTestId('flowgen-what')).toHaveText('a runoff run for each unit with land, on its own rain');
	await expect(page.getByTestId('summary-share')).toHaveText('Per unit · no unit on a rainfall station · EWR by each unit’s natural MAR');
	await expect(panel(page).getByTestId('share-hint')).toHaveAttribute('data-unit-rain', 'on');
	// One share per unit, its natural MAR share: no method to pick (engine 1.105.0, issue #616).
	await expect(panel(page).getByLabel('Flow share method')).toHaveCount(0);
	await expect(panel(page).getByTestId('hilo-split')).toHaveCount(0);
	await expect(panel(page).getByTestId('flowgen-share-setup')).toHaveCount(0);
	// The share stays: it splits the EWR, the land cover's low-flow threshold and the priority users' demand.
	await expect(panel(page).getByRole('heading', { name: 'Flow share and the EWR split' })).toBeVisible();
	await expect(panel(page).getByTestId('flowgen-row')).toHaveCount(2);
	await expect(panel(page).getByTestId('flowgen-assigned')).toHaveText('0 of 2 units with land have a rainfall station.');
	const upperStation = row(page, 'Upper farm').getByLabel('Station for Upper farm');
	// Stations only (and none): satellite rain is a gap fill, never a unit's station.
	const options = await upperStation.locator('option').allTextContents();
	expect(options[0]).toBe('No station: as before stations');
	expect(options).toEqual(expect.arrayContaining(['Ridge station', 'Vlei station']));
	// The catchment rain series is a station too; three stations in all, and no satellite option.
	expect(options).toHaveLength(4);
	expect(options.filter((o) => /chirps|satellite/i.test(o))).toEqual([]);
	await expect(row(page, 'Upper farm').getByTestId('flowgen-unit-map')).toHaveText('MAP: 900 mm (invented grid, 1991–2020)');

	// One unit at a time: Ridge for Upper farm, × 900 ÷ 600.
	await upperStation.selectOption({ label: 'Ridge station' });
	await expect(row(page, 'Upper farm').getByTestId('flowgen-ratio')).toHaveText('× 1.5');
	// Several at once: tick both, Vlei for both.
	await row(page, 'Upper farm').getByRole('checkbox', { name: 'Tick Upper farm' }).check();
	await row(page, 'Lower farm').getByRole('checkbox', { name: 'Tick Lower farm' }).check();
	const bulk = panel(page).getByTestId('flowgen-bulk');
	await expect(bulk).toContainText('2 units ticked');
	await bulk.getByLabel('Station for the ticked units').selectOption({ label: 'Vlei station' });
	await bulk.getByRole('button', { name: 'Assign to the ticked units' }).click();
	await expect(upperStation).toHaveValue(vlei);
	await expect(row(page, 'Lower farm').getByLabel('Station for Lower farm')).toHaveValue(vlei);
	await expect(row(page, 'Upper farm').getByTestId('flowgen-ratio')).toHaveText('× 1.8');
	await expect(panel(page).getByTestId('flowgen-assigned')).toHaveText('2 of 2 units with land have a rainfall station.');
	// Back to Ridge for Upper farm, corrected against Vlei; Lower farm on Vlei as recorded.
	await upperStation.selectOption({ label: 'Ridge station' });
	await row(page, 'Upper farm').getByLabel('Station correcting Upper farm’s CHIRPS').selectOption({ label: 'Vlei station' });
	await row(page, 'Lower farm').getByRole('checkbox', { name: 'Scale to unit MAP: Lower farm' }).uncheck();
	await expect(row(page, 'Lower farm').getByTestId('flowgen-ratio')).toHaveText('× 1, as recorded');
	// The ratio is the checkbox's description, so a screen reader hears it with the box.
	await expect(row(page, 'Upper farm').getByRole('checkbox', { name: 'Scale to unit MAP: Upper farm' })).toHaveAccessibleDescription('× 1.5');
	// Each station once, with its MAP: Ridge runs Upper farm, Vlei runs Lower farm and corrects Upper farm.
	const stations = panel(page).getByTestId('flowgen-station');
	await expect(stations).toHaveCount(2);
	await expect(stations.filter({ hasText: 'Ridge station' }).getByTestId('flowgen-station-map')).toHaveText('600 mm (Ridge station’s invented record)');
	await expect(stations.filter({ hasText: 'Vlei station' })).toContainText('Runs Lower farm.');
	// Neither is placed: each asks for the unit it stands in, so its CHIRPS has a place.
	await stations.filter({ hasText: 'Ridge station' }).getByLabel('Stands in').selectOption({ label: 'Upper farm' });
	await expectNoViolations(page, { include: '#set-share' });
	await saveSettings(page);
	await expect(page.getByTestId('summary-share')).toHaveText('Per unit · 2 units on a rainfall station · EWR by each unit’s natural MAR');
	expect(await storedSettings(page.request, id)).toMatchObject({
		rainStations: { units: { [upper.id]: { stationId: ridge, correctAgainst: vlei }, [lower.id]: { stationId: vlei, scaleToMap: false } }, sites: { [ridge]: { unitId: upper.id } } }
	});
});

test('saved stations come back after a reload, and stack on a phone', async ({ page, owner }) => {
	void owner;
	const { id, upper, lower, ridge, vlei } = await seed(page.request, 'Flow generation saved');
	await updateSettings(page.request, id, {
		unitRain: { mode: 'perUnit' },
		rainStations: { units: { [upper.id]: { stationId: ridge, correctAgainst: vlei }, [lower.id]: { stationId: vlei, scaleToMap: false } } }
	});
	await openSettings(page, id);
	const upperStation = row(page, 'Upper farm').getByLabel('Station for Upper farm');
	await expect(upperStation).toHaveValue(ridge);
	await expect(row(page, 'Upper farm').getByLabel('Station correcting Upper farm’s CHIRPS')).toHaveValue(vlei);
	await expect(row(page, 'Lower farm').getByRole('checkbox', { name: 'Scale to unit MAP: Lower farm' })).not.toBeChecked();

	// On a phone the rows stack: nothing scrolls sideways.
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(row(page, 'Upper farm').getByLabel('Station for Upper farm')).toBeVisible();
	await expectNoSidewaysScroll(page);
	const box = panel(page).getByTestId('flowgen-rows').locator('xpath=..');
	expect(await box.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

async function fitAndApply(page: Page) {
	const fit = page.getByRole('region', { name: /^Fit automatically/ });
	await openFold(fit, 'fit-search');
	await fit.getByLabel('Model runs per fit').fill('50');
	await fit.getByRole('checkbox', { name: /^Validate/ }).uncheck();
	await fit.getByRole('button', { name: 'Fit automatically', exact: true }).click();
	await expect(fit.getByText(/seed 1 ·/)).toBeVisible();
	await fit.getByRole('button', { name: 'Apply to form' }).click();
}

test('a fit made under Fragmentation reads as not fitted for this method, until it is refitted', async ({ page, owner }) => {
	void owner;
	const { id } = await seed(page.request, 'Flow generation fit');
	await updateSettings(page.request, id, { runoffModel: 'gr4j' });
	// The fit is on Calibration (issue #586 round 3); Flow generation stays on Model settings.
	await openCalibration(page, id);
	await fitAndApply(page);
	await saveSettings(page);
	const sidebar = page.getByRole('navigation', { name: 'Project sections' });
	await sidebar.getByRole('link', { name: 'Model settings', exact: true }).click();
	const refit = panel(page).getByTestId('flowgen-refit');
	await expect(panel(page).getByTestId('flowgen-method')).toBeVisible();
	// Positive control: a fit made under Per unit is this method's.
	await expect(refit).toHaveCount(0);

	// The same fit as an engine before 1.109.0 recorded it under Fragmentation: no per-unit rain in its forcing.
	const fitRecord = structuredClone((await storedSettings(page.request, id)) as unknown as { fitRecord: { engineVersion: string; forcing: Record<string, unknown> } }).fitRecord;
	fitRecord.engineVersion = '1.108.0';
	delete fitRecord.forcing.unitRain;
	await updateSettings(page.request, id, { fitRecord });
	await openSettings(page, id);
	await expect(refit).toHaveText('Parameters not fitted for this method: the GR4J parameters were fitted under Fragmentation, which is retired. Fit the parameters again on Calibration before relying on the results.');
	await expect(refit.getByRole('link', { name: 'Fit the parameters' })).toHaveAttribute('href', '?tab=calibration#set-fit');
	await sidebar.getByRole('link', { name: 'Calibration', exact: true }).click();
	const record = page.getByRole('region', { name: /^Fit record of these parameters/ });
	await expect(record).toContainText('Parameters not fitted for this method: the fit ran under Fragmentation');

	// Refitted, it is Per unit's again.
	await fitAndApply(page);
	await saveSettings(page);
	await expect(record).toBeVisible();
	await expect(record).not.toContainText('Parameters not fitted for this method');
	await sidebar.getByRole('link', { name: 'Model settings', exact: true }).click();
	await expect(panel(page).getByTestId('flowgen-method')).toBeVisible();
	await expect(refit).toHaveCount(0);
});
