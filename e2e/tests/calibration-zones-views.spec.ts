// Calibration zones on the screens that show them (issue #555 round 4; locations, issue #659; docs/ui.md § Network,
// § Map, § Runs & results, § Report; docs/maps.md § Calibration zones on the map): the Network colours each unit by
// its location's group with a legend, the Map colours each unit's parcel by it with a legend, the card and Every
// feature naming it, and a run scores each location, the headline first, in or out of sample by its own fit, on
// Calibration and in the report.
// Names, places and numbers are invented.
import type { APIRequestContext, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createProject, createRun, node, putModel, putSeries, syntheticFlow, syntheticRain, updateSettings, type Model } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { box, openKey, openMap } from '../support/map.ts';
import { whatChanged } from '../support/compare.ts';

const DAYS = 120;

/** Upper farm drains to the Middle weir (a ticked zone's gauge, with parameters of its own), Lower farm to the outlet. */
async function seedZoned(request: APIRequestContext, name: string) {
	const project = await createProject(request, name);
	const outlet = node('Outflow gauge', 'gauge', null, 1, { pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const weir = node('Middle weir', 'gauge', outlet.id, 2, { areaKm2: 0, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const upper = node('Upper farm', 'farm', weir.id, 3, { areaKm2: 12, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const lower = node('Lower farm', 'farm', outlet.id, 4, { areaKm2: 20, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const model: Model = { nodes: [outlet, weir, upper, lower], crops: [], cropAreas: [], transfers: [] };
	await putModel(request, project.id, model);
	await updateSettings(request, project.id, { runoffModel: 'gr4j', unitRain: { mode: 'perUnit' }, apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110] });
	await putSeries(request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(DAYS) });
	await putSeries(request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(DAYS) });
	await putSeries(request, project.id, { kind: 'flow_observed_m3s', name: 'Weir record', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(DAYS).map((v) => v * 0.4) });
	const list = (await (await request.get(`${API_URL}/projects/${project.id}/series`)).json()).series as { id: string; name: string }[];
	expect((await request.patch(`${API_URL}/projects/${project.id}/series/${list.find((s) => s.name === 'Weir record')!.id}`, { data: { siteNodeId: weir.id } })).status()).toBe(200);
	const zone = { nodeId: weir.id, enabled: true, calibrationStart: null, calibrationEnd: null, calibrationFlowKind: null, calibrationExclusions: [], qualityFlags: null, gr4j: { x1: 420, x2: 0, x3: 95, x4: 1.8 }, fitRecord: null };
	// The outlet a calibration location too (issue #659), its units "the rest" as before: written out, so the spec
	// doesn't rest on what a new project is created with.
	await updateSettings(request, project.id, { calibrationZones: [zone], calibrateAtOutlet: true, calibrationRest: 'headline' });
	// Each farm's parcel, linked to its unit by name.
	const poly = (nm: string, ring: [number, number][]) => ({ type: 'Feature', properties: { name: nm }, geometry: { type: 'Polygon', coordinates: [ring] } });
	const imp = await request.post(`${API_URL}/projects/${project.id}/map/import`, {
		data: { fileName: 'zone-parcels.geojson', kind: 'farm_parcel', text: JSON.stringify({ type: 'FeatureCollection', features: [poly('Upper farm', box(21.31, -33.69, 0.03)), poly('Lower farm', box(21.36, -33.69, 0.02))] }) }
	});
	expect(imp.status(), await imp.text()).toBe(201);
	return { id: project.id, weir: weir.id, upper: upper.id, lower: lower.id };
}

const WEIR_ZONE = 'Middle weir zone';
const SITE_ZONE = 'Outflow gauge zone (outlet, headline)';

async function zoneRows(page: Page) {
	const table = page.getByTestId('zone-calibration');
	await expect(table.getByRole('heading', { name: 'Calibration locations' })).toBeVisible();
	return table.locator('tbody tr');
}

test('the Network and the Map colour each unit by its calibration zone, with a legend; a run scores each zone’s gauge on Calibration and in the report', async ({ page, owner }) => {
	test.setTimeout(120_000);
	void owner;
	const p = await seedZoned(page.request, 'Zones on the screens');

	// Network: no run yet, but the zones are the settings', so Calibration zone is offered.
	await page.goto(`/projects/${p.id}?tab=network`);
	const colourBy = page.getByLabel('Colour hydrological units by');
	await expect(colourBy.locator('option')).toHaveText(['Nothing', 'Calibration zone']);
	await colourBy.selectOption('zone');
	const key = page.getByTestId('map-key');
	await expect(key).toContainText('Colour: calibration zone');
	await expect(key).toContainText(`${WEIR_ZONE}: 1 unit`);
	await expect(key).toContainText(`${SITE_ZONE}: 1 unit`);
	// Never colour alone: each unit's zone is in its label line and the drainage tree, read out.
	const tree = page.getByRole('list', { name: 'Drainage tree' });
	await expect(tree.getByRole('listitem').filter({ hasText: 'Upper farm' })).toContainText(WEIR_ZONE);
	await expect(tree.getByRole('listitem').filter({ hasText: 'Lower farm' })).toContainText(SITE_ZONE);
	await expect(page.locator('g.node[data-supply="zone"]')).toHaveCount(2);
	await expectNoViolations(page);

	// Map: Colour areas by → Calibration zone; each parcel in its zone's colour, the legend in words.
	await openMap(page, p.id);
	await openKey(page);
	const results = page.getByTestId('map-results');
	await results.getByLabel('Colour areas by').selectOption('zone');
	await expect(page).toHaveURL(/[?&]measure=zone/);
	await expect(results).toHaveAttribute('data-view', 'zone');
	await expect(results).toHaveAttribute('data-ready', 'true');
	const legend = page.getByTestId('map-zone-legend');
	await expect(legend.locator('li')).toHaveText([`${WEIR_ZONE} (1 unit)`, `${SITE_ZONE} (1 unit)`]);
	// Each zone's swatch carries the colour the map was given, read from its own palette token.
	const colours = await legend.locator('li').evaluateAll((els) => els.map((e) => [e.getAttribute('data-token'), e.getAttribute('data-colour')]));
	expect(colours.map(([t]) => t)).toEqual(['--series-1', '--series-2']);
	for (const [, c] of colours) expect(c).toMatch(/^(#|rgb)/);
	expect(colours[0]![1]).not.toBe(colours[1]![1]);
	await expectNoViolations(page);

	// A run scores each zone's gauge: the weir's parameters were set by hand, so its scores are not in sample.
	const runId = await createRun(page.request, p.id, 'Zoned');
	await page.goto(`/projects/${p.id}?tab=calibration&run=${runId}#res-calibration`);
	let rows = await zoneRows(page);
	await expect(rows).toHaveCount(2);
	// The headline location first (issue #659), then the weir.
	await expect(rows.nth(0).getByRole('rowheader')).toHaveText('Outflow gaugeHeadline · outlet');
	await expect(rows.nth(1).getByRole('rowheader')).toHaveText('Middle weirGauge');
	await expect(rows.nth(1).getByTestId('zone-sample')).toHaveText('parameters not from an automatic fit');
	await expect(rows.nth(1)).toContainText('X1 420');
	await expectNoViolations(page);

	// The report lists the same zones.
	await page.goto(`/projects/${p.id}/report?run=${runId}`);
	rows = await zoneRows(page);
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(1)).toContainText('Middle weir');
	await expect(rows.nth(1).getByTestId('zone-sample')).toHaveText('parameters not from an automatic fit');

	// Compare runs: the zone's parameters changed, so the input diff words that zone, and each zone's gauge has its table.
	const zone = (x1: number) => ({ nodeId: p.weir, enabled: true, calibrationStart: null, calibrationEnd: null, calibrationFlowKind: null, calibrationExclusions: [], qualityFlags: null, gr4j: { x1, x2: 0, x3: 95, x4: 1.8 }, fitRecord: null });
	await updateSettings(page.request, p.id, { calibrationZones: [zone(510)] });
	const after = await createRun(page.request, p.id, 'Zoned again');
	await page.goto(`/projects/${p.id}?tab=compare&a=${p.id}:${runId}&b=${p.id}:${after}`);
	await expect(whatChanged(page).getByRole('listitem').filter({ hasText: 'Calibration location at Middle weir: X1 420 → 510' })).toBeVisible();
	const zoneTable = page.getByTestId('compare-zone');
	await expect(zoneTable).toHaveText('Calibration location at Middle weir');
	await expect(page.getByTestId('compare-headline-site')).toHaveText('At the headline location, the outlet.');
	await expect(page.getByRole('table', { name: 'Calibration statistics at Middle weir, a calibration location, for both runs' })).toBeVisible();
	await expectNoViolations(page);
});
