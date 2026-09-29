// River & reserve (issue #17, docs/ui.md § River & reserve): a synthetic
// catchment with a few water years of rain and a monthly EWR the river misses
// in the dry months, and opening the page with its chart drawn.
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { createProject, putModel, putSeries, sampleModel, syntheticFlow, syntheticRain, updateSettings } from './api.ts';

/** Three water years (1 Oct 2019 – 30 Sep 2022) of invented rain and observed flow on the sample network. */
export async function seedRiverProject(request: APIRequestContext, name: string, days = 1096): Promise<string> {
	const project = await createProject(request, name);
	await putModel(request, project.id, sampleModel());
	await updateSettings(request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: [2000, 1500, 1000, 1000, 1000, 1500, 2500, 4000, 5000, 5000, 4000, 3000]
	});
	await putSeries(request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2019-10-01', values: syntheticRain(days) });
	await putSeries(request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2019-10-01', values: syntheticFlow(days) });
	return project.id;
}

/** Opens River & reserve (for `runId`, else the newest run) and waits for the tiles and the drawn flow chart. */
export async function openRiver(page: Page, projectId: string, runId?: string) {
	await page.goto(`/projects/${projectId}?tab=river${runId ? `&run=${runId}` : ''}`);
	await expect(riverTiles(page)).toHaveCount(4);
	await expect(page.getByRole('region', { name: 'Flow vs reserve' }).locator('figure.chart')).toHaveAttribute('data-ready', 'true');
}

/** The page's four KPI tiles. */
export const riverTiles = (page: Page) => page.locator('dl.kpis > [data-kpi]');

/** One tile by its data-kpi id (met, below, outflow, worst). */
export const riverTile = (page: Page, id: 'ewr' | 'below' | 'outflow' | 'worst') => page.locator(`[data-kpi="${id}"]`);
