// The checks-only gauges on Runs & results (issue #554; docs/ui.md § Runs &
// results): under the outlet's hydrograph and FDC, a hydrograph and an FDC for
// every gauge inside the network with its own flow record that the run doesn't
// score, with the record's NSE/KGE/PBIAS as an out-of-sample check and a link
// to its Series details. Names and numbers are invented.
import type { APIRequestContext } from '@playwright/test';
import { API_URL } from '../support/env.ts';
import { createProject, createRun, node, putModel, putSeries, syntheticFlow, syntheticRain, updateSettings, type Model } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { plantPreCheckGaugeRun } from '../support/db.ts';
import { expect, test } from '../support/fixtures.ts';

const DAYS = 120;
const START = '2021-10-01';

/** Outflow gauge ← Upper weir ← Upper farm; Outflow gauge ← Side weir ← Side farm. Each weir has its own record; the Side weir's is 30× too big. */
async function seedTwoGauges(request: APIRequestContext, name: string, site: 'upper' | null = null) {
	const project = await createProject(request, name);
	const gauge = { areaKm2: 0, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 };
	const outlet = node('Outflow gauge', 'gauge', null, 1, gauge);
	const upper = node('Upper weir', 'gauge', outlet.id, 2, gauge);
	const side = node('Side weir', 'gauge', outlet.id, 3, gauge);
	const model: Model = {
		nodes: [outlet, upper, side, node('Upper farm', 'farm', upper.id, 4, { areaKm2: 12 }), node('Side farm', 'farm', side.id, 5, { areaKm2: 8 })],
		crops: [],
		cropAreas: [],
		transfers: []
	};
	await putModel(request, project.id, model);
	await updateSettings(request, project.id, { apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110] });
	await putSeries(request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: START, values: syntheticRain(DAYS) });
	await putSeries(request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: START, values: syntheticFlow(DAYS) });
	await putSeries(request, project.id, { kind: 'flow_observed_m3s', name: 'Upper weir record', unit: 'm³/s', startDate: START, values: syntheticFlow(DAYS) });
	await putSeries(request, project.id, { kind: 'flow_observed_m3s', name: 'Side weir record', unit: 'm³/s', startDate: START, values: syntheticFlow(DAYS).map((v) => v * 30) });
	const list = (await (await request.get(`${API_URL}/projects/${project.id}/series`)).json()).series as { id: string; name: string }[];
	const idOf = (n: string) => list.find((s) => s.name === n)!.id;
	for (const [n, at] of [['Upper weir record', upper.id], ['Side weir record', side.id]] as const) {
		expect((await request.patch(`${API_URL}/projects/${project.id}/series/${idOf(n)}`, { data: { siteNodeId: at } })).status()).toBe(200);
	}
	if (site === 'upper') await updateSettings(request, project.id, { calibrationSiteNodeId: upper.id });
	return { project, sideRecordId: idOf('Side weir record'), runId: await createRun(request, project.id, 'Checked') };
}

const hydrograph = (page: import('@playwright/test').Page, gauge: string) =>
	page.getByRole('img', { name: `Flow at ${gauge} (checks only): simulated and observed: line chart of Observed gauge, Simulated flow` });

test('each gauge with its own record gets a hydrograph, an FDC and an out-of-sample check, with its Series details a click away', async ({ page, owner }) => {
	void owner;
	const { project, runId, sideRecordId } = await seedTwoGauges(page.request, 'Gauge checks');
	await page.goto(`/projects/${project.id}?tab=runs&run=${runId}#res-gauges`);
	const section = page.locator('#res-gauges');
	await expect(section.getByRole('heading', { level: 3, name: 'Flow at gauges in the network (checks only)' })).toBeVisible();
	const gauges = section.getByTestId('check-gauge');
	await expect(gauges).toHaveCount(2);
	// In the network's order (Upper weir before Side weir), not by node id.
	await expect(gauges.getByRole('heading', { level: 4 })).toHaveText(['Upper weir', 'Side weir']);
	await expect(section).toContainText('a check out of sample (the calibration doesn\'t score its record, and its excluded periods are left out), never the calibration score.');
	for (const name of ['Side weir', 'Upper weir']) {
		await expect(hydrograph(page, name).locator('canvas')).toBeVisible();
		await expect(page.getByRole('img', { name: `Flow-duration curve at ${name} (checks only): line chart of Simulated flow, Observed gauge` }).locator('canvas')).toBeVisible();
		await expect(gauges.filter({ has: hydrograph(page, name) }).getByRole('heading', { level: 4, name })).toBeVisible();
	}
	// The outlet keeps its own hydrograph; the run scores the outlet, so no calibration site chart.
	await expect(page.getByRole('img', { name: /^Flow at the outflow gauge: natural, simulated and observed/ })).toBeVisible();
	await expect(page.getByRole('img', { name: /the calibration site/ })).toHaveCount(0);
	// The statistics are a check, out of sample, never the calibration score. The 30× record shows it in PBIAS.
	const side = gauges.filter({ has: hydrograph(page, 'Side weir') });
	const stats = side.getByTestId('check-gauge-stats');
	await expect(stats).toHaveText(/^Check, out of sample: NSE −?-?[\d.,]+ · KGE −?-?[\d.,]+ · PBIAS 9\d\.\d % over 120 days\.$/u);
	const link = side.getByRole('link', { name: 'Series details of Side weir’s record' });
	await expect(link).toHaveAttribute('href', `?tab=series&series=${encodeURIComponent(sideRecordId)}#data-chart`);
	await expectNoViolations(page);
	await link.click();
	await expect(page).toHaveURL(new RegExp(`tab=series&series=${sideRecordId}`));
	await expect(page.getByText('Upload unit', { exact: true }).first()).toBeVisible();
});

test('the calibration site keeps its own chart and leaves the checks; a run made before says to re-run', async ({ page, owner }) => {
	void owner;
	const { project, runId } = await seedTwoGauges(page.request, 'Gauge checks, site', 'upper');
	await page.goto(`/projects/${project.id}?tab=runs&run=${runId}#res-gauges`);
	await expect(page.getByRole('img', { name: /^Flow at Upper weir, the calibration site: simulated and observed/ })).toBeVisible();
	const gauges = page.locator('#res-gauges').getByTestId('check-gauge');
	await expect(gauges).toHaveCount(1);
	await expect(hydrograph(page, 'Side weir').locator('canvas')).toBeVisible();

	await plantPreCheckGaugeRun(runId);
	await page.reload();
	await expect(page.getByTestId('check-gauges-before')).toHaveText('This run was made before gauge records were charted (engine 1.90.0): Side weir. Run the model again to see its charts.');
	await expect(gauges).toHaveCount(0);
	await expect(hydrograph(page, 'Side weir')).toHaveCount(0);
});

test('many gauges fold to the first three, the rest a click away', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Gauge checks, many');
	const gauge = { areaKm2: 0, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 };
	const outlet = node('Outflow gauge', 'gauge', null, 1, gauge);
	const weirs = [1, 2, 3, 4, 5].map((i) => node(`Weir ${i}`, 'gauge', outlet.id, 1 + i, gauge));
	const farms = weirs.map((w, i) => node(`Farm ${i + 1}`, 'farm', w.id, 10 + i, { areaKm2: 5 }));
	await putModel(page.request, project.id, { nodes: [outlet, ...weirs, ...farms], crops: [], cropAreas: [], transfers: [] });
	await updateSettings(page.request, project.id, { apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110] });
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: START, values: syntheticRain(DAYS) });
	for (const w of weirs) await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', name: `${w.name} record`, unit: 'm³/s', startDate: START, values: syntheticFlow(DAYS) });
	const list = (await (await page.request.get(`${API_URL}/projects/${project.id}/series`)).json()).series as { id: string; name: string }[];
	for (const w of weirs) {
		const id = list.find((s) => s.name === `${w.name} record`)!.id;
		expect((await page.request.patch(`${API_URL}/projects/${project.id}/series/${id}`, { data: { siteNodeId: w.id } })).status()).toBe(200);
	}
	const runId = await createRun(page.request, project.id, 'Many');
	await page.goto(`/projects/${project.id}?tab=runs&run=${runId}#res-gauges`);
	const section = page.locator('#res-gauges');
	await expect(section.getByRole('heading', { level: 4 })).toHaveText(['Weir 1', 'Weir 2', 'Weir 3']);
	await expect(hydrograph(page, 'Weir 3').locator('canvas')).toBeVisible();
	const more = section.getByRole('button', { name: 'Show all 5 gauges' });
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	await more.click();
	await expect(section.getByRole('heading', { level: 4 })).toHaveText(['Weir 1', 'Weir 2', 'Weir 3', 'Weir 4', 'Weir 5']);
	await expect(hydrograph(page, 'Weir 5').locator('canvas')).toBeVisible();
	await expect(section.getByRole('button', { name: 'Show the first 3' })).toHaveAttribute('aria-expanded', 'true');
});
