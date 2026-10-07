// The calibration check on Runs & results (issue #444; docs/ui.md § Calibration
// check): under the calibration statistics, one chart per gauge the run has an
// observed record for, the outlet and the calibration site inside the
// network, each with observed, simulated, natural flow and the demand upstream
// on one axis, and the bed losses above it when the run has any. Names and
// numbers are invented.
import type { APIRequestContext } from '@playwright/test';
import { API_URL } from '../support/env.ts';
import { createProject, createRun, node, putModel, putSeries, syntheticFlow, syntheticRain, updateSettings, type Model } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';

const DAYS = 120;
const FOUR = 'Observed gauge, Simulated, Natural, Upstream demand';

/** Outflow gauge ← Middle weir (the calibration site, with its own record) ← Upper farm; Outflow gauge ← Lower farm. Run once. */
async function seedCheck(request: APIRequestContext, name: string, upperExtra: Record<string, unknown> = {}) {
	const project = await createProject(request, name);
	const outlet = node('Outflow gauge', 'gauge', null, 1, { pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const weir = node('Middle weir', 'gauge', outlet.id, 2, { areaKm2: 0, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const upper = node('Upper farm', 'farm', weir.id, 3, { damCapacityM3: 150_000, ...upperExtra });
	const lower = node('Lower farm', 'farm', outlet.id, 4, { areaKm2: 8 });
	const crop = { id: crypto.randomUUID(), name: 'Orchard', cropFactor: [0.6, 0.7, 0.8, 0.8, 0.8, 0.7, 0.6, 0.5, 0.4, 0.4, 0.5, 0.6] };
	const model: Model = {
		nodes: [outlet, weir, upper, lower],
		crops: [crop],
		cropAreas: [
			{ nodeId: upper.id, cropId: crop.id, areaM2: 200_000 },
			{ nodeId: lower.id, cropId: crop.id, areaM2: 120_000 }
		],
		transfers: []
	};
	await putModel(request, project.id, model);
	await updateSettings(request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: [2000, 1500, 1000, 1000, 1000, 1500, 2500, 4000, 5000, 5000, 4000, 3000]
	});
	await putSeries(request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(DAYS) });
	await putSeries(request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(DAYS) });
	// The weir's own record, the calibration site: the run stores it beside the outlet's.
	await putSeries(request, project.id, { kind: 'flow_observed_m3s', name: 'Weir record', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(DAYS) });
	const list = (await (await request.get(`${API_URL}/projects/${project.id}/series`)).json()).series as { id: string; name: string }[];
	expect((await request.patch(`${API_URL}/projects/${project.id}/series/${list.find((s) => s.name === 'Weir record')!.id}`, { data: { siteNodeId: weir.id } })).status()).toBe(200);
	await updateSettings(request, project.id, { calibrationSiteNodeId: weir.id });
	return { project, runId: await createRun(request, project.id, 'Checked') };
}

test('a chart per gauge with a record: observed, simulated, natural and upstream demand, with how to read it', async ({ page, owner }) => {
	void owner;
	const { project, runId } = await seedCheck(page.request, 'Calibration check');
	await page.goto(`/projects/${project.id}?tab=runs&run=${runId}#res-calibration`);
	const check = page.getByTestId('calibration-check');
	await expect(check.getByRole('heading', { level: 3, name: 'Calibration check: flow against use, per gauge' })).toBeVisible();
	await expect(check).toContainText('How to read it: simulated should track observed; natural sits above simulated by roughly the use upstream, and where');
	// No bed losses in this run, so nothing about them (the next test is the positive control).
	await expect(check).not.toContainText('bed losses', { ignoreCase: true });
	// One chart per gauge with a record, the outlet first, each with its four lines.
	const outletChart = page.getByRole('img', { name: `Calibration check at the outflow gauge: observed, simulated, natural and upstream demand: line chart of ${FOUR}` });
	const weirChart = page.getByRole('img', { name: `Calibration check at Middle weir: observed, simulated, natural and upstream demand: line chart of ${FOUR}` });
	await expect(outletChart.locator('canvas')).toBeVisible();
	await expect(weirChart.locator('canvas')).toBeVisible();
	const figure = (img: typeof outletChart) => check.locator('figure', { has: img });
	for (const img of [outletChart, weirChart]) {
		await expect(figure(img).locator('.u-legend tr.u-series .u-label')).toHaveText(['Date', 'Observed gauge (m³/s)', 'Simulated (m³/s)', 'Natural (m³/s)', 'Upstream demand (m³/s)']);
		// None starts hidden: the comparison is the point.
		await expect(figure(img).locator('.u-legend tr.u-series.u-off')).toHaveCount(0);
		await expect(figure(img).getByRole('button', { name: 'Log scale' })).toBeVisible();
	}
	// What each line sums: the whole catchment at the outlet, only what is above the weir there.
	await expect(figure(outletChart)).toContainText('Upstream demand: the demand (before any drought restriction, boreholes\' share included) of 2 hydrological units and water users above the gauge.');
	await expect(figure(weirChart)).toContainText('Natural: the natural runoff of the hydrological units above this gauge, before land cover takes its share.');
	await expect(figure(weirChart)).toContainText('of 1 hydrological unit or water user above the gauge.');
	// The page's one unit switch (the hydrograph's too) converts every line, demand included.
	await figure(outletChart).getByRole('button', { name: 'm³/day' }).click();
	await expect(check.getByRole('img', { name: /^Calibration check at the outflow gauge: .*, in m³\/day/ })).toBeVisible();
	await expect(page.getByRole('img', { name: /^Flow at the outflow gauge: .*, in m³\/day/ })).toBeVisible();
	await expectNoViolations(page);
});

test('with bed losses above the gauges, a fifth line sums them and the texts count them in', async ({ page, owner }) => {
	void owner;
	// A fifth of the upper farm's outflow lost in its reach, which leads to the weir and so to the outlet too.
	const { project, runId } = await seedCheck(page.request, 'Calibration check, losing reach', { reachLossFrac: 0.2 });
	await page.goto(`/projects/${project.id}?tab=runs&run=${runId}#res-calibration`);
	const check = page.getByTestId('calibration-check');
	await expect(check).toContainText('natural sits above simulated by roughly the use upstream plus the bed losses in the reaches above the gauge, and where');
	const FIVE = `${FOUR}, Bed losses upstream`;
	for (const name of ['the outflow gauge', 'Middle weir']) {
		const img = page.getByRole('img', { name: `Calibration check at ${name}: observed, simulated, natural and upstream demand, with bed losses: line chart of ${FIVE}` });
		await expect(img.locator('canvas')).toBeVisible();
		const figure = check.locator('figure', { has: img });
		await expect(figure.locator('.u-legend tr.u-series .u-label')).toHaveText(['Date', 'Observed gauge (m³/s)', 'Simulated (m³/s)', 'Natural (m³/s)', 'Upstream demand (m³/s)', 'Bed losses upstream (m³/s)']);
		await expect(figure).toContainText('Bed losses upstream: the water lost into the river bed in the reach above the gauge, which leaves the catchment, so simulated sits below natural by this too.');
	}
});
