// Runs & results (issue #17, docs/ui.md § Runs & results): a runnable
// synthetic catchment with many stored runs, and opening the page on a run
// with its results drawn. Labels are invented.
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { createRun, seedRunnableProject } from './api.ts';

/** A long label, three times the seed's, to find clipping in the rail. */
export const LONG_LABEL = 'Dam raise on the upper tributary with the 2026 licence volumes and the new EWR table';

/**
 * seedRunnableProject plus `count` runs (at most 20, RUNS_KEPT_PER_PROJECT),
 * every third with LONG_LABEL. Sent together: the local suite shares one API
 * process, and one-by-one requests queue behind other workers' runs.
 */
export async function seedManyRuns(request: APIRequestContext, name: string, count = 20): Promise<{ id: string; runIds: string[] }> {
	const project = await seedRunnableProject(request, name);
	const runIds = await Promise.all(Array.from({ length: count }, (_, i) => createRun(request, project.id, i % 3 ? `Run ${String(i + 1).padStart(2, '0')}` : `${LONG_LABEL} ${i + 1}`)));
	return { id: project.id, runIds };
}

/** Opens Runs & results (with `query`, e.g. `&run=…`) and waits for the shown run's results (its water balance by water year). */
export async function openRuns(page: Page, projectId: string, query = '') {
	await page.goto(`/projects/${projectId}?tab=runs${query}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Runs & results' })).toBeVisible();
	await expect(page.locator('#res-water-balance')).toBeVisible();
}

/**
 * Opens Calibration (with `query`, e.g. `&run=…`, or a `#res-…` anchor) and waits for the shown run's hydrograph:
 * Model quality is under How the shown run fits there (issue #586 Round 3).
 */
export async function openCalibration(page: Page, projectId: string, query = '') {
	await page.goto(`/projects/${projectId}?tab=calibration${query}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Calibration', exact: true })).toBeVisible();
	await expect(page.getByRole('img', { name: /^Flow at the outflow gauge/ }).locator('canvas')).toBeVisible();
}

/** How the shown run fits' run picker on Calibration. */
export const calibrationRunPicker = (page: Page) => page.locator('#cal-fit').getByRole('combobox', { name: 'Run', exact: true });

/** The runs list (the rail's "Runs" region). */
export const runsList = (page: Page) => page.getByRole('region', { name: 'Runs', exact: true });
