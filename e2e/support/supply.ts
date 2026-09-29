// Units & supply (issue #17, docs/ui.md § Units & supply): a synthetic
// catchment where some units get all their demand and others fall short, and
// opening the page with its tiles and chart drawn. Names and numbers are
// invented.
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { createProject, putModel, putSeries, sampleModel, syntheticFlow, syntheticRain, updateSettings, type Model } from './api.ts';

/**
 * The sample network (Upper and Lower farm) plus `extra` more units, each
 * with a small catchment, no dam and a large orchard, so they run short;
 * `units` = 2 + extra. The rain covers 1 Oct 2021 to 28 Jan 2022, as
 * seedRunnableProject's (`days` longer for a realistic chart). Past 26 extra
 * units the names run long ("Unit 27 on the long tributary"), for the big case.
 */
export async function seedSupplyProject(request: APIRequestContext, name: string, extra = 2, days = 120): Promise<{ id: string; model: Model }> {
	const project = await createProject(request, name);
	const model = sampleModel();
	const gauge = model.nodes[0]!;
	const crop = model.crops[0]!;
	const template = model.nodes[2]!;
	for (let i = 0; i < extra; i++) {
		const id = crypto.randomUUID();
		// Smaller catchments and bigger orchards further down the list: from a little short to very short.
		model.nodes.push({ ...template, id, name: i < 26 ? `Unit ${String.fromCharCode(65 + i)}` : `Unit ${i + 1} on the long tributary`, downstreamNodeId: gauge.id, sortOrder: 4 + i, areaKm2: Math.max(0.5, 8 - i), damCapacityM3: i % 3 === 0 ? 40_000 : 0 });
		model.cropAreas.push({ nodeId: id, cropId: crop.id, areaM2: 150_000 + i * 60_000 });
	}
	await putModel(request, project.id, model);
	await updateSettings(request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: [2000, 1500, 1000, 1000, 1000, 1500, 2500, 4000, 5000, 5000, 4000, 3000]
	});
	const start = days > 120 ? '2019-10-01' : '2021-10-01';
	await putSeries(request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: start, values: syntheticRain(days) });
	await putSeries(request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: start, values: syntheticFlow(days) });
	return { id: project.id, model };
}

/** Opens Units & supply (with `query`, e.g. `&run=…&unit=…`) and waits for the tiles and the drawn chart. */
export async function openSupply(page: Page, projectId: string, query = '') {
	await page.goto(`/projects/${projectId}?tab=supply${query}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Hydrological units' })).toBeVisible();
	await expect(supplyTiles(page)).toHaveCount(4);
	await expect(unitChart(page).locator('figure.chart')).toHaveAttribute('data-ready', 'true');
}

/** The page's four KPI tiles. */
export const supplyTiles = (page: Page) => page.locator('dl.kpis > [data-kpi]');

/** One tile by its data-kpi id. */
export const supplyTile = (page: Page, id: 'supplied' | 'below' | 'week' | 'shortfall') => page.locator(`[data-kpi="${id}"]`);

/** The unit cards, in page order. */
export const unitCards = (page: Page) => page.getByRole('list', { name: 'Hydrological units' }).getByRole('listitem').filter({ has: page.locator('a.name') });

/** The picked unit's panel. */
export const unitChart = (page: Page) => page.getByRole('region', { name: /^Hydrological unit detail: / });
