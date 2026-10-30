// Calibrating at several gauges, upstream units first (issue #555, engine
// 1.106.0; docs/ui.md § Settings & calibration, docs/model.md §2.10n). Per unit
// is the only flow generation method (issue #658), so a project that never set
// settings.unitRain can tick a gauge at once: it ticks, saves into settings.calibrationZones, and Fit
// automatically fits two steps (the weir's zone, then the outlet's) that Apply
// writes as one. Names and numbers are invented.
import { API_URL } from '../support/env.ts';
import { createProject, node, putModel, putSeries, syntheticFlow, syntheticRain, updateSettings, type Model } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';
import { saveSettings, openFold } from '../support/settings.ts';

const DAYS = 120;

test('a ticked gauge fits its own zone first, then the outlet, and both apply', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Calibration zones');
	const outlet = node('Outflow gauge', 'gauge', null, 1, { pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const weir = node('Middle weir', 'gauge', outlet.id, 2, { areaKm2: 0, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const upper = node('Upper farm', 'farm', weir.id, 3, { areaKm2: 12, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const lower = node('Lower farm', 'farm', outlet.id, 4, { areaKm2: 20, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const model: Model = { nodes: [outlet, weir, upper, lower], crops: [], cropAreas: [], transfers: [] };
	await putModel(page.request, project.id, model);
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j', apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110] });
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(DAYS) });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(DAYS) });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', name: 'Weir record', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(DAYS).map((v) => v * 0.4) });
	const list = (await (await page.request.get(`${API_URL}/projects/${project.id}/series`)).json()).series as { id: string; name: string }[];
	const rec = list.find((s) => s.name === 'Weir record')!;
	expect((await page.request.patch(`${API_URL}/projects/${project.id}/series/${rec.id}`, { data: { siteNodeId: weir.id } })).status()).toBe(200);

	// No method to switch first (issue #658): the weir's tick is enabled, with no note.
	await page.goto(`/projects/${project.id}?tab=calibration`);
	const zones = page.getByTestId('calibration-zones');
	const tick = zones.getByRole('checkbox', { name: 'Calibrate here: Middle weir' });
	await expect(tick).toBeEnabled();
	await expect(zones.getByTestId('calibration-zones-fragmentation')).toHaveCount(0);
	await expect(zones.getByTestId('calibration-zone-site')).toContainText('Outflow gauge');
	await tick.check();
	await expect(zones.getByTestId('calibration-zones-ticked')).toHaveText('Fit automatically fits 2 zones, upstream first.');
	await saveSettings(page);
	const saved = (await (await page.request.get(`${API_URL}/projects/${project.id}`)).json()).project.settings;
	expect(saved.calibrationZones).toEqual([expect.objectContaining({ nodeId: weir.id, enabled: true, gr4j: null, fitRecord: null })]);
	await expectNoViolations(page);

	// A short fit: two steps, the weir's zone first.
	const fit = page.getByRole('region', { name: /^Fit automatically/ });
	await openFold(fit, 'fit-search');
	await fit.getByLabel('Model runs per fit').fill('50');
	await fit.getByLabel('Starts').fill('1');
	await fit.getByRole('checkbox', { name: /^Validate/ }).uncheck();
	await fit.getByRole('button', { name: 'Fit automatically', exact: true }).click();
	const steps = fit.getByTestId('fit-steps').getByTestId('fit-step');
	await expect(steps).toHaveCount(2);
	await expect(steps.nth(0)).toContainText('1. Upstream zone');
	await expect(steps.nth(0)).toContainText('Middle weir');
	await expect(steps.nth(1)).toContainText('2. Calibration site');
	await expect(steps.nth(1)).toContainText('Outflow gauge');
	await fit.getByRole('button', { name: 'Apply to form' }).click();
	// The weir's row now shows its own parameters and fit record.
	await expect(zones.getByTestId('calibration-zone-row')).not.toContainText('Not fitted yet');
	await saveSettings(page);
	const after = (await (await page.request.get(`${API_URL}/projects/${project.id}`)).json()).project.settings;
	expect(after.calibrationZones[0].gr4j).toEqual(expect.objectContaining({ x1: expect.any(Number) }));
	expect(after.calibrationZones[0].fitRecord.zone).toEqual({ nodeId: weir.id, units: [upper.id] });
	expect(after.fitRecord.zone).toEqual({ nodeId: null, units: [lower.id] });
	await expectNoViolations(page);
});
