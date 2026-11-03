// The Allocations tab's map (issue #510, docs/allocations.md § The map, docs/ui.md § Allocations): "On the map"
// folds until Show the map (`map=1`), then shades each unit's area on the Map tab by its band of modelled use ÷
// registered volume, each unit carrying its % as a button, a key naming every band in words, and every unit with
// no area listed under the map with its band. Shade by picks the measure (`mapMeasure=`): water use, irrigated area
// (planted in the run ÷ registered) or dam capacity (the dam in the run ÷ registered storage), each with its own key and
// every unit's figures listed. The water source and year are in the URL (`mapSource=`, `mapYear=`), so a
// reload keeps them. A click on a unit opens its comparison (`unit=`). Above the map, every unit's three measures against
// the run with the catchment's totals. A viewer who sees
// totals only (162, D3) isn't offered it; with What viewers see on, they are. Synthetic data only.
import type { APIRequestContext, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addAllocation, openAllocations } from '../support/allocations.ts';
import { addMember, createProject, createRun, node, putModel, putSeries, setAllocationViewerUnits, syntheticFlow, syntheticRain, updateSettings } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { box } from '../support/map.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const section = (page: Page) => page.getByTestId('allocation-use-map');
const detail = (page: Page) => page.getByTestId('allocation-unit');

/**
 * What each unit is for: a ratio of modelled use to registered volume, nothing registered, and whether it has an area;
 * and, against its 15 ha planted and its 80 000 m³ dam, the irrigated area (ha) and storage (m³) its volume registers.
 */
const UNITS = [
	{ name: 'Green kloof', ratio: 0.8, area: true, ha: 10, storage: 80_000 },
	{ name: 'Red ridge', ratio: 1.3, area: true, ha: 15, storage: 40_000 },
	{ name: 'Bright vlei', ratio: 2, area: true, ha: 30, storage: 100_000 },
	{ name: 'Grey flats', ratio: null, area: true, ha: null, storage: null },
	{ name: 'Mapless corner', ratio: 1.05, area: false, ha: 5, storage: null }
] as const;

/**
 * A runnable project with a unit for each band above, three whole water years, a run, and registered volumes set
 * from the run's own mean surface use ÷ each unit's ratio (so the bands hold whatever the engine's numbers do);
 * an area on the Map tab for every unit but one, named after it so the import links it.
 */
async function seedBands(request: APIRequestContext, name: string) {
	const project = await createProject(request, name);
	const gauge = node('Outflow gauge', 'gauge', null, 1, { pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const farms = UNITS.map((u, i) => node(u.name, 'farm', gauge.id, i + 2, { damCapacityM3: 80_000, pctUpstreamToDam: 1 }));
	const crop = { id: crypto.randomUUID(), name: 'Orchard', cropFactor: [0.6, 0.7, 0.8, 0.8, 0.8, 0.7, 0.6, 0.5, 0.4, 0.4, 0.5, 0.6] };
	await putModel(request, project.id, {
		nodes: [gauge, ...farms],
		crops: [crop],
		cropAreas: farms.map((f) => ({ nodeId: f.id, cropId: crop.id, areaM2: 150_000 })),
		transfers: []
	});
	await updateSettings(request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: [2000, 1500, 1000, 1000, 1000, 1500, 2500, 4000, 5000, 5000, 4000, 3000]
	});
	const days = 3 * 365 + 1;
	await putSeries(request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2019-10-01', values: syntheticRain(days) });
	await putSeries(request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2019-10-01', values: syntheticFlow(days) });
	const runId = await createRun(request, project.id, 'Baseline');

	const res = await request.get(`${API_URL}/projects/${project.id}/runs/${runId}/allocations`);
	expect(res.status(), await res.text()).toBe(200);
	const { comparison } = (await res.json()) as { comparison: { nodes: { nodeId: string; name: string; surface: { meanModelledM3PerYear: number | null } }[] } };
	for (const [i, u] of UNITS.entries()) {
		const use = comparison.nodes.find((n) => n.name === u.name)!.surface.meanModelledM3PerYear ?? 0;
		expect(use, `${u.name} uses water in the run`).toBeGreaterThan(0);
		if (u.ratio === null) continue;
		await addAllocation(request, project.id, {
			nodeId: farms[i]!.id,
			registrationNo: `MAP-${i + 1}`,
			holder: `Invented Map Holder ${i + 1}`,
			authorisation: 'licence',
			waterSource: 'surface',
			volumeM3PerYear: Math.round(use / u.ratio),
			irrigatedAreaHa: u.ha,
			storageM3: u.storage
		});
	}
	const poly = (nm: string, ring: [number, number][]) => ({ type: 'Feature', properties: { name: nm }, geometry: { type: 'Polygon', coordinates: [ring] } });
	const imp = await request.post(`${API_URL}/projects/${project.id}/map/import`, {
		data: {
			fileName: 'band-units.geojson',
			kind: 'farm_parcel',
			text: JSON.stringify({ type: 'FeatureCollection', features: UNITS.filter((u) => u.area).map((u, i) => poly(u.name, box(21.02 + i * 0.05, -33.98, 0.04))) })
		}
	});
	expect(imp.status(), await imp.text()).toBe(201);
	return { id: project.id, runId, units: Object.fromEntries(UNITS.map((u, i) => [u.name, farms[i]!.id])) as Record<(typeof UNITS)[number]['name'], string> };
}

test('the map shades each unit by its band, labels its %, keys every band in words and lists the units with no area; a unit opens its comparison', async ({ page, owner }) => {
	test.setTimeout(120_000);
	void owner;
	const project = await seedBands(page.request, 'Allocations map');
	await page.setViewportSize({ width: 1440, height: 960 });
	await openAllocations(page, project.id);

	// Above the map: each unit's irrigated area, water use and dam against the run, and the catchment's totals.
	const totals = page.getByTestId('allocation-unit-totals');
	await expect(totals.getByRole('heading', { name: 'Registered against the run, per hydrological unit' })).toBeVisible();
	const unitRow = totals.locator(`tbody tr[data-node="${project.units['Green kloof']}"]`);
	await expect(unitRow.getByRole('cell').nth(0)).toHaveText('10 ha');
	await expect(unitRow.getByRole('cell').nth(1)).toHaveText(/^15 ha\s*More than registered$/);
	await expect(unitRow.getByRole('cell').nth(5)).toHaveText(/^80\s000\s*Within band$/);
	const total = totals.getByTestId('allocation-unit-totals-total');
	await expect(total.getByRole('rowheader')).toHaveText(/^Catchment total\s*5 units$/);
	// 60 ha registered against 75 planted; 220 000 m³ of storage against five 80 000 m³ dams.
	await expect(total.getByRole('cell').nth(0)).toHaveText('60 ha');
	await expect(total.getByRole('cell').nth(1)).toHaveText(/^75 ha\s*More than registered$/);
	await expect(total.getByRole('cell').nth(4)).toHaveText(/^220\s000$/);
	await expect(total.getByRole('cell').nth(5)).toHaveText(/^400\s000\s*Larger than registered$/);
	// A unit's name opens its comparison above.
	await unitRow.getByRole('link', { name: 'Green kloof' }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]unit=${project.units['Green kloof']}`));
	await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('Green kloof');

	// Folded until asked for: no map code, nothing fetched.
	await expect(section(page).getByRole('heading', { name: 'On the map' })).toBeVisible();
	await expect(page.getByTestId('allocation-map')).toHaveCount(0);
	const show = section(page).getByRole('link', { name: 'Show the map' });
	await expect(show).toHaveAttribute('aria-expanded', 'false');
	await show.click();
	await expect(page).toHaveURL(/[?&]map=1/);
	await expect(section(page).getByRole('button', { name: 'Hide the map' })).toHaveAttribute('aria-expanded', 'true');
	// A link, so Back folds it and Forward opens it again.
	await page.goBack();
	await expect(page).not.toHaveURL(/[?&]map=1/);
	await expect(page.getByTestId('allocation-map-legend')).toHaveCount(0);
	await page.goForward();
	await expect(page).toHaveURL(/[?&]map=1/);

	// The key: every band in words, with how many units are in it, and that the bands are the map's own.
	const key = section(page).getByTestId('allocation-map-legend');
	await expect(key.getByRole('heading')).toHaveText('Key: modelled use ÷ registered volume, the mean of 3 whole water years');
	for (const [band, words, n] of [
		['under', 'Using less than registered (under 100 %)', '1 unit'],
		['near', 'The same, up to 10 % more (100–110 %)', '1 unit'],
		['over', '10–50 % more than registered (110–150 %)', '1 unit'],
		['far', 'More than 50 % more than registered (over 150 %)', '1 unit'],
		['unregistered', 'Use, but no registered volume', '1 unit'],
		['none', 'No use, nothing registered', 'none']
	] as const) {
		const row = key.locator(`li[data-band="${band}"]`);
		await expect(row).toContainText(words);
		await expect(row).toContainText(n);
	}
	await expect(key).toContainText('These bands are fixed for this map');
	await expect(key).toContainText('±10 % band');

	// The unit with no area is listed under the map with its % and band, so it isn't silently missing.
	const unplaced = section(page).getByTestId('allocation-map-unplaced').getByRole('listitem');
	await expect(unplaced).toHaveCount(1);
	await expect(unplaced.first()).toContainText('Mapless corner');
	await expect(unplaced.first()).toContainText('105 %');
	await expect(unplaced.first()).toContainText('Up to 10 % more');
	await expect(unplaced.first()).toHaveAttribute('data-band', 'near');

	// The map: each unit with an area carries its % (or the band's words) as a button named with its figures,
	// where the browser can draw it (no WebGL: it says so, and the list and the comparison carry every figure).
	const map = page.getByTestId('allocation-map');
	await expect(map).toHaveAttribute('data-status', /^(ready|failed)$/);
	if ((await map.getAttribute('data-status')) === 'ready') {
		const label = (name: string) => map.getByRole('button', { name: new RegExp(`^${name}: `) });
		await expect(label('Green kloof')).toHaveText('80 %');
		await expect(label('Green kloof')).toHaveAttribute('data-band', 'under');
		await expect(label('Red ridge')).toHaveText('130 %');
		await expect(label('Red ridge')).toHaveAttribute('data-band', 'over');
		await expect(label('Bright vlei')).toHaveText('200 %');
		await expect(label('Bright vlei')).toHaveAttribute('data-band', 'far');
		await expect(label('Grey flats')).toHaveText('None registered');
		await expect(label('Grey flats')).toHaveAttribute('data-band', 'unregistered');
		await expect(label('Red ridge')).toHaveAccessibleName(/^Red ridge: 130 % of registered, .* m³ modelled against .* m³ registered \(the mean of 3 whole water years\)\. 10–50 % more\.$/);
		// A click opens that unit's comparison above.
		await label('Red ridge').click();
		await expect(page).toHaveURL(new RegExp(`[?&]unit=${project.units['Red ridge']}`));
		await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('Red ridge');
		await expect(label('Red ridge')).toHaveAttribute('aria-pressed', 'true');
	} else {
		await expect(page.getByTestId('allocation-map-unavailable')).toBeVisible();
	}

	// The listed unit opens its comparison too.
	await unplaced.first().getByRole('link', { name: 'Mapless corner' }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]unit=${project.units['Mapless corner']}`));
	await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('Mapless corner');

	// Groundwater: nothing registered and no boreholes, so every unit reads "No use"; the key counts them.
	await section(page).getByRole('radio', { name: 'Groundwater' }).check();
	await expect(unplaced.first()).toHaveAttribute('data-band', 'none');
	await expect(key.locator('li[data-band="none"]')).toContainText('5 units');
	await section(page).getByRole('radio', { name: 'Surface water' }).check();

	// One whole water year at a time; never a part year.
	const year = section(page).getByRole('combobox', { name: 'Water year' });
	await expect(year.locator('option')).toHaveText(['Mean of the whole water years', '2019/20', '2020/21', '2021/22']);
	await year.selectOption('2020/21');
	await expect(key.getByRole('heading')).toHaveText('Key: modelled use ÷ registered volume, water year 2020/21');
	await expect(page).toHaveURL(/[?&]mapYear=2020(&|$)/);

	// The source and the year are in the URL: a reload keeps them, and each choice is a step Back returns from.
	await section(page).getByRole('radio', { name: 'Groundwater' }).check();
	await expect(page).toHaveURL(/[?&]mapSource=groundwater(&|$)/);
	await page.reload();
	await expect(page.getByTestId('allocations-page')).toHaveAttribute('aria-busy', 'false');
	await expect(section(page).getByRole('radio', { name: 'Groundwater' })).toBeChecked();
	await expect(year).toHaveValue('2020');
	await expect(key.getByRole('heading')).toHaveText('Key: modelled use ÷ registered volume, water year 2020/21');
	await page.goBack();
	await expect(section(page).getByRole('radio', { name: 'Surface water' })).toBeChecked();
	await expect(year).toHaveValue('2020');

	await expectNoViolations(page);

	// Shade by the irrigated area: the run's planted crop areas (15 ha each) ÷ the registered irrigated area. The source and
	// year only read the water use, so they go; the key has that measure's words and counts, and every unit's figures are listed.
	const shadeBy = (name: string) => section(page).getByRole('radio', { name });
	await shadeBy('Irrigated area').check();
	await expect(page).toHaveURL(/[?&]mapMeasure=area(&|$)/);
	await expect(key.getByRole('heading')).toHaveText('Key: irrigated area in the run ÷ registered irrigated area');
	await expect(section(page).getByRole('radio', { name: 'Groundwater' })).toHaveCount(0);
	await expect(year).toHaveCount(0);
	for (const [band, words, n] of [
		['under', 'Less planted than registered (under 100 %)', '1 unit'],
		['near', 'The same, up to 10 % more (100–110 %)', '1 unit'],
		['over', '10–50 % more planted than registered (110–150 %)', '1 unit'],
		['far', 'More than 50 % more planted than registered (over 150 %)', '1 unit'],
		['unregistered', 'Planted, but no irrigated area registered', '1 unit'],
		['none', 'Nothing planted, no area registered', 'none']
	] as const) {
		const row = key.locator(`li[data-band="${band}"]`);
		await expect(row).toContainText(words);
		await expect(row).toContainText(n);
	}
	const figures = section(page).getByTestId('allocation-map-figures');
	await expect(figures).toHaveAttribute('data-measure', 'area');
	const figure = (name: string) => figures.getByRole('row').filter({ has: page.getByRole('rowheader', { name: new RegExp(`^${name}`) }) });
	await expect(figures.locator('tbody tr')).toHaveCount(5);
	await expect(figure('Green kloof')).toHaveAttribute('data-band', 'over');
	await expect(figure('Green kloof').getByRole('cell')).toHaveText(['10 ha', '15 ha', '150 %', /10–50 % more/]);
	await expect(figure('Mapless corner')).toHaveAttribute('data-band', 'far');
	await expect(figure('Mapless corner').getByRole('rowheader')).toContainText('no area on the map');
	await expect(unplaced.first()).toContainText('300 %');
	if ((await map.getAttribute('data-status')) === 'ready') {
		const label = (name: string) => map.getByRole('button', { name: new RegExp(`^${name}: `) });
		await expect(label('Bright vlei')).toHaveText('50 %');
		await expect(label('Bright vlei')).toHaveAttribute('data-band', 'under');
		await expect(label('Bright vlei')).toHaveAccessibleName('Bright vlei: 50 % of registered, 15 ha planted in the run against 30 ha registered. Less than registered.');
		await expect(label('Grey flats')).toHaveText('None registered');
	}
	await expectNoViolations(page);

	// Shade by the dam: the 80 000 m³ dam in the run ÷ the storage registered for it.
	await shadeBy('Dam capacity').check();
	await expect(page).toHaveURL(/[?&]mapMeasure=storage(&|$)/);
	await expect(key.getByRole('heading')).toHaveText('Key: dam capacity in the run ÷ registered storage');
	await expect(figures).toHaveAttribute('data-measure', 'storage');
	await expect(figure('Red ridge')).toHaveAttribute('data-band', 'far');
	await expect(figure('Red ridge').getByRole('cell')).toHaveText([/^40\s000 m³$/, /^80\s000 m³$/, '200 %', /Over 50 % larger/]);
	await expect(figure('Green kloof')).toHaveAttribute('data-band', 'near');
	await expect(figure('Bright vlei')).toHaveAttribute('data-band', 'under');
	await expect(key.locator('li[data-band="unregistered"]')).toContainText('2 units');
	// A reload keeps the measure; Back returns to the one before.
	await page.reload();
	await expect(page.getByTestId('allocations-page')).toHaveAttribute('aria-busy', 'false');
	await expect(shadeBy('Dam capacity')).toBeChecked();
	await page.goBack();
	await expect(shadeBy('Irrigated area')).toBeChecked();
	await shadeBy('Water use').check();
	await expect(page).not.toHaveURL(/[?&]mapMeasure=/);
	await expect(key.getByRole('heading')).toHaveText(/^Key: modelled use ÷ registered volume, /);

	// Hide the map folds it in place, and its choices go with it.
	await section(page).getByRole('button', { name: 'Hide the map' }).click();
	await expect(page).not.toHaveURL(/[?&]map=1/);
	await expect(page).not.toHaveURL(/[?&]mapYear=/);
	await expect(page.getByTestId('allocation-map')).toHaveCount(0);

	// On a phone it fits the width.
	await page.setViewportSize({ width: 390, height: 844 });
	await openAllocations(page, project.id, '&map=1');
	await expect(section(page).getByTestId('allocation-map-legend')).toBeVisible();
	await expectNoSidewaysScroll(page);
	// The tables stack rather than scroll inside their boxes (the page check skips a box that holds its own overflow).
	for (const box of [page.getByTestId('allocation-unit-totals').locator('.table-wrap'), section(page).getByTestId('allocation-map-figures').locator('xpath=ancestor::div[contains(@class, "table-wrap")][1]')])
		expect(await box.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
});

test('a viewer who sees totals only is not offered the map; with What viewers see on, they are, with no holder named', async ({ page, owner, signIn }) => {
	test.setTimeout(120_000);
	void owner;
	const project = await seedBands(page.request, 'Allocations map viewer');
	const viewer = await signIn('Allocations map viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;

	await openAllocations(v, project.id, '&map=1');
	await expect(v.getByTestId('allocation-totals')).toBeVisible();
	await expect(section(v)).toHaveCount(0);
	await expect(v.getByTestId('allocation-map')).toHaveCount(0);

	await setAllocationViewerUnits(page.request, project.id, true);
	await openAllocations(v, project.id, '&map=1');
	await expect(section(v).getByTestId('allocation-map-legend')).toBeVisible();
	await expect(section(v).getByTestId('allocation-map-unplaced')).toContainText('Mapless corner');
	await expect(section(v)).not.toContainText('Invented Map Holder');
	await expectNoViolations(v);
});
