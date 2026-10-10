// The Allocations tab's map (issue #510, docs/allocations.md § The map, docs/ui.md § Allocations): "On the map"
// folds until Show the map (`map=1`), then shades each unit's area on the Map tab by its band of modelled use ÷
// registered volume, each unit carrying its % as a button, a key naming every band in words, and every unit with
// no area listed under the map with its band. A click on a unit opens its comparison (`unit=`). A viewer who sees
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

/** What each unit is for: a ratio of modelled use to registered volume, nothing registered, and whether it has an area. */
const UNITS = [
	{ name: 'Green kloof', ratio: 0.8, area: true },
	{ name: 'Red ridge', ratio: 1.3, area: true },
	{ name: 'Bright vlei', ratio: 2, area: true },
	{ name: 'Grey flats', ratio: null, area: true },
	{ name: 'Mapless corner', ratio: 1.05, area: false }
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
			volumeM3PerYear: Math.round(use / u.ratio)
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
	const year = section(page).getByLabel('Water year');
	await expect(year.locator('option')).toHaveText(['Mean of the whole water years', '2019/20', '2020/21', '2021/22']);
	await year.selectOption('2020/21');
	await expect(key.getByRole('heading')).toHaveText('Key: modelled use ÷ registered volume, water year 2020/21');

	await expectNoViolations(page);
	// Hide the map folds it in place.
	await section(page).getByRole('button', { name: 'Hide the map' }).click();
	await expect(page).not.toHaveURL(/[?&]map=1/);
	await expect(page.getByTestId('allocation-map')).toHaveCount(0);

	// On a phone it fits the width.
	await page.setViewportSize({ width: 390, height: 844 });
	await openAllocations(page, project.id, '&map=1');
	await expect(section(page).getByTestId('allocation-map-legend')).toBeVisible();
	await expectNoSidewaysScroll(page);
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
