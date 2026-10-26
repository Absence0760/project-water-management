// A run with every optional panel (issue #586's layout pins): Runs & results' forecast and Model quality's
// checks-only gauges, WR2012 check and rain for each unit, on the Calibration page since Round 3. Names and
// numbers are invented.
import type { APIRequestContext } from '@playwright/test';
import { node, putModel, putSeries, seedRunnableProject, syntheticFlow, updateSettings } from './api.ts';
import { plantUnitRainSummary } from './db.ts';
import { API_URL } from './env.ts';
import { expect } from './fixtures.ts';

/**
 * seedRunnableProject with every optional Model quality panel: a gauge inside the network with its own
 * record that the run doesn't score (Flow at gauges, issue #554), a WR2012 reference (an invented
 * quaternary), forecast rain past the record and a forecast run (WP-2.12), and a planted
 * summary.unitRain (Rain for each unit, issue #482; as unit-rain.spec.ts plants it).
 */
export async function seedEveryPanel(request: APIRequestContext, name: string): Promise<{ id: string; runId: string }> {
	const project = await seedRunnableProject(request, name);
	const [outlet, upper, lower] = project.model.nodes as { id: string; downstreamNodeId: string | null }[];
	const weir = node('Upper weir', 'gauge', outlet!.id, 4, { areaKm2: 0, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	upper!.downstreamNodeId = weir.id;
	await putModel(request, project.id, { ...project.model, nodes: [...project.model.nodes, weir] });
	await putSeries(request, project.id, { kind: 'flow_observed_m3s', name: 'Upper weir record', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(120) });
	const list = (await (await request.get(`${API_URL}/projects/${project.id}/series`)).json()).series as { id: string; name: string }[];
	const record = list.find((s) => s.name === 'Upper weir record')!.id;
	expect((await request.patch(`${API_URL}/projects/${project.id}/series/${record}`, { data: { siteNodeId: weir.id } })).status()).toBe(200);
	await updateSettings(request, project.id, {
		wr2012: { reference: { quaternary: 'Z99A', areaKm2: 60, marMm3: 6, monthlyMm3: new Array(12).fill(0.5), periodStart: 1990, periodEnd: 2025, mapMm: null, source: 'Synthetic' } }
	});
	// seedRunnableProject records rain 2021-10-01 … 2022-01-28; the forecast follows it.
	await putSeries(request, project.id, { kind: 'rain_forecast_mm', unit: 'mm', startDate: '2022-01-29', values: Array.from({ length: 14 }, (_, i) => (i % 4 === 0 ? 9 : 0)) });
	const res = await request.post(`${API_URL}/projects/${project.id}/runs`, { data: { label: 'Every panel', forecast: true } });
	expect(res.status(), await res.text()).toBe(201);
	const runId = ((await res.json()) as { run: { id: string } }).run.id;
	const days = { unitGauge: 0, gaugeMap: 0, unitChirps: 0, catchment: 0, forecast: 0, none: 0 };
	const unit = { areaKm2: 12, gaugeMapClamped: false, chirps: null, petMm: 1200, exchangeMm: 0, storageStartMm: 0, storageEndMm: 0 };
	await plantUnitRainSummary(runId, {
		mode: 'perUnit',
		gaugeMapMm: 640,
		gaugeMapSource: 'a synthetic gauge record',
		mapPeriod: { start: '1991-01-01', end: '2020-12-31' },
		units: [
			{ ...unit, nodeId: upper!.id, name: 'Upper farm', mapMm: 800, mapSource: 'a synthetic MAP grid', rule: 'gaugeMap', rainKey: 'rain_catchment_mm', factor: 1.25, factorSource: 'gaugeMap', gaugeMapFactor: 1.25, gaugeMapOwnFactor: 1.25, days: { ...days, gaugeMap: 120 }, rainMm: 900, aetMm: 700, flowMm: 150, runoffM3: 1_800_000, runoffCoefficient: 0.167 },
			{ ...unit, nodeId: lower!.id, name: 'Lower farm', areaKm2: 8, mapMm: null, mapSource: null, rule: 'catchment', rainKey: null, factor: null, factorSource: 'catchment', gaugeMapFactor: null, gaugeMapOwnFactor: null, days: { ...days, catchment: 120 }, rainMm: 700, aetMm: 600, flowMm: 90, runoffM3: 720_000, runoffCoefficient: 0.129 }
		]
	});
	return { id: project.id, runId };
}
