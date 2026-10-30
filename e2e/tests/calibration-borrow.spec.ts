// Similar units borrow a gauge's parameters (issue #659 option 2; docs/ui.md § Settings & calibration, § Network,
// § Map; docs/run-comparison.md; docs/model.md §2.10n). Two gauges are calibration locations, each with its own
// period; a unit on another tributary (no gauge of its own) is given the upstream gauge's parameters by Parameters
// from; Fit automatically fits the upstream donor first, its step taking the borrowed unit with it, then the gauge
// below; Apply writes both; the Network and the Map mark the borrowed unit in its donor's colour; and the input
// diff against the run before says what changed, one line for the unit. Names, places and numbers are invented.
//
// Needs slice B of issue #659 (the API's calibrateAtOutlet, calibrationRest and unitParamsFrom) and slice C (the
// Calibration page mounting UnitParamsTable, and the fit card's steps in dependency order).
import { API_URL } from '../support/env.ts';
import { createProject, createRun, node, putModel, putSeries, syntheticFlow, syntheticRain, updateSettings, type Model } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { whatChanged } from '../support/compare.ts';
import { expect, test } from '../support/fixtures.ts';
import { box, openKey, openMap } from '../support/map.ts';
import { openFold, saveSettings } from '../support/settings.ts';

const DAYS = 120;
const quiet = { pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 };

test('a unit on another tributary borrows the upstream gauge’s parameters: fitted with it first, marked on the Network and the Map, and one line in the comparison', async ({ page, owner }) => {
	test.setTimeout(180_000);
	void owner;
	const project = await createProject(page.request, 'Borrowed parameters');
	// The upper weir drains to the middle weir, the middle weir to the outlet. The side farm is on a tributary of
	// its own with no gauge, straight into the outlet.
	const outlet = node('Outflow gauge', 'gauge', null, 1, quiet);
	const middle = node('Middle weir', 'gauge', outlet.id, 2, { areaKm2: 0, ...quiet });
	const upper = node('Upper weir', 'gauge', middle.id, 3, { areaKm2: 0, ...quiet });
	const top = node('Top farm', 'farm', upper.id, 4, { areaKm2: 12, ...quiet });
	const mid = node('Mid farm', 'farm', middle.id, 5, { areaKm2: 20, ...quiet });
	const side = node('Side farm', 'farm', outlet.id, 6, { areaKm2: 8, ...quiet });
	const model: Model = { nodes: [outlet, middle, upper, top, mid, side], crops: [], cropAreas: [], transfers: [] };
	await putModel(page.request, project.id, model);
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j', apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110] });
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(DAYS) });
	for (const [name, k] of [
		['Upper record', 0.3],
		['Middle record', 0.7]
	] as const)
		await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', name, unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(DAYS).map((v) => v * k) });
	const list = (await (await page.request.get(`${API_URL}/projects/${project.id}/series`)).json()).series as { id: string; name: string }[];
	for (const [name, site] of [
		['Upper record', upper.id],
		['Middle record', middle.id]
	] as const)
		expect((await page.request.patch(`${API_URL}/projects/${project.id}/series/${list.find((s) => s.name === name)!.id}`, { data: { siteNodeId: site } })).status()).toBe(200);
	// 1. Two gauges ticked, each with its own period; the outlet has no record and isn't a location.
	const row = (nodeId: string, start: string, end: string) => ({ nodeId, enabled: true, calibrationStart: start, calibrationEnd: end, calibrationFlowKind: null, calibrationExclusions: [], qualityFlags: null, gr4j: null, fitRecord: null });
	await updateSettings(page.request, project.id, {
		calibrateAtOutlet: false,
		calibrationRest: 'nearest',
		calibrationZones: [row(upper.id, '2021-10-01', '2021-12-31'), row(middle.id, '2021-11-01', '2022-01-28')]
	});
	// The run before the change, to compare against.
	const before = await createRun(page.request, project.id, 'Before borrowing');

	// 2. Give the side farm the upper weir's parameters.
	await page.goto(`/projects/${project.id}?tab=calibration`);
	const params = page.getByTestId('unit-params');
	await openFold(params, 'unit-params-fold');
	const sideRow = params.getByTestId('unit-params-row').filter({ hasText: 'Side farm' });
	// With no location downstream it takes the nearest upstream on its river: the middle weir.
	await expect(sideRow.getByTestId('unit-params-runs-on')).toHaveText('Middle weir (nearest upstream)');
	await params.getByLabel('Parameters from: Side farm').selectOption({ label: 'Upper weir' });
	await expect(sideRow.getByTestId('unit-params-runs-on')).toHaveText('Upper weir (borrowed)');
	await expect(params.getByTestId('unit-params-error')).toHaveCount(0);
	await saveSettings(page);
	const saved = (await (await page.request.get(`${API_URL}/projects/${project.id}`)).json()).project.settings;
	expect(saved.unitParamsFrom).toEqual({ [side.id]: upper.id });
	await expectNoViolations(page);

	// 3–4. A short fit: the upper weir (the donor, upstream) first, taking the side farm with it, then the middle weir.
	const fit = page.getByRole('region', { name: /^Fit automatically/ });
	await openFold(fit, 'fit-search');
	await fit.getByLabel('Model runs per fit').fill('50');
	await fit.getByLabel('Starts').fill('1');
	await fit.getByRole('checkbox', { name: /^Validate/ }).uncheck();
	await fit.getByRole('button', { name: 'Fit automatically', exact: true }).click();
	const steps = fit.getByTestId('fit-steps').getByTestId('fit-step');
	await expect(steps).toHaveCount(2);
	await expect(steps.nth(0)).toContainText('Upper weir');
	await expect(steps.nth(0)).toContainText('Side farm');
	await expect(steps.nth(1)).toContainText('Middle weir');
	await expect(steps.nth(1)).toContainText('after: Upper weir');

	// 5. Apply: both rows get their parameters, the upper weir's fit record naming the borrowed unit.
	await fit.getByRole('button', { name: 'Apply to form' }).click();
	await saveSettings(page);
	const after = (await (await page.request.get(`${API_URL}/projects/${project.id}`)).json()).project.settings;
	const upperRow = after.calibrationZones.find((z: { nodeId: string }) => z.nodeId === upper.id);
	const middleRow = after.calibrationZones.find((z: { nodeId: string }) => z.nodeId === middle.id);
	expect(upperRow.gr4j).toEqual(expect.objectContaining({ x1: expect.any(Number) }));
	expect(upperRow.fitRecord.zone).toEqual(expect.objectContaining({ nodeId: upper.id, borrowed: [side.id] }));
	expect(middleRow.fitRecord.zone).toEqual(expect.objectContaining({ nodeId: middle.id }));
	// Each row kept its own period.
	expect([upperRow.calibrationStart, middleRow.calibrationStart]).toEqual(['2021-10-01', '2021-11-01']);

	// The Network: the side farm in the upper weir's colour, ringed, "borrowed from" in its label line and the key.
	await page.goto(`/projects/${project.id}?tab=network`);
	await page.getByLabel('Colour hydrological units by').selectOption('zone');
	const key = page.getByTestId('map-key');
	await expect(key).toContainText('Borrowed from Upper weir: 1 unit');
	await expect(page.getByTestId('borrowed-mark')).toHaveCount(1);
	const marked = page.locator('g.node[data-marker="borrowed"]');
	await expect(marked).toHaveCount(1);
	const topNode = page.locator('g.node').filter({ hasText: 'Top farm' });
	await expect(marked).toHaveAttribute('style', (await topNode.getAttribute('style'))!);
	await expect(page.getByRole('list', { name: 'Drainage tree' }).getByRole('listitem').filter({ hasText: 'Side farm' })).toContainText('borrowed from Upper weir');
	await expectNoViolations(page);

	// The Map: the side farm's parcel in its donor's colour, its own key line, its card naming the donor.
	const poly = (nm: string, ring: [number, number][]) => ({ type: 'Feature', properties: { name: nm }, geometry: { type: 'Polygon', coordinates: [ring] } });
	const imp = await page.request.post(`${API_URL}/projects/${project.id}/map/import`, {
		data: { fileName: 'borrow-parcels.geojson', kind: 'farm_parcel', text: JSON.stringify({ type: 'FeatureCollection', features: [poly('Top farm', box(21.31, -33.69, 0.03)), poly('Side farm', box(21.36, -33.69, 0.02))] }) }
	});
	expect(imp.status(), await imp.text()).toBe(201);
	await openMap(page, project.id);
	await openKey(page);
	const results = page.getByTestId('map-results');
	await results.getByLabel('Colour areas by').selectOption('zone');
	await expect(results).toHaveAttribute('data-ready', 'true');
	const legend = page.getByTestId('map-zone-legend');
	const lent = legend.locator('li[data-marker="borrowed"]');
	await expect(lent).toHaveText('Borrowed from Upper weir (1 unit)');
	await expect(lent).toHaveAttribute('data-colour', (await legend.locator(`li[data-zone="${upper.id}"]`).getAttribute('data-colour'))!);
	await expectNoViolations(page);

	// The comparison against the run before: one line for the unit.
	const now = await createRun(page.request, project.id, 'Side farm borrows');
	await page.goto(`/projects/${project.id}?tab=compare&a=${project.id}:${before}&b=${project.id}:${now}`);
	await expect(whatChanged(page).getByRole('listitem').filter({ hasText: 'Parameters from, Side farm: its own zone → Upper weir' })).toBeVisible();
	await expectNoViolations(page);
});
