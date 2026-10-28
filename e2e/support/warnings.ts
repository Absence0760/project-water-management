// The Warnings page (`?tab=warnings`, issue #611, docs/ui.md § Warnings): a
// synthetic project whose rain and flow carry flat stretches the data checks
// flag, and locators for the page's parts. No client data: the series are made up.
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_URL } from './env.ts';
import { createProject, putModel, putSeries, sampleModel, syntheticFlow, syntheticRain, updateSettings } from './api.ts';

export const START = '2021-10-01';

/** Rain with `flats` flat stretches of 6 days at 5.5 mm, one every 12 days from 11 Oct 2021 (the first 11–16 Oct). */
export function flatRain(days: number, flats: number): number[] {
	const v = syntheticRain(days);
	for (let k = 0; k < flats; k++) for (let i = 10 + 12 * k; i < 16 + 12 * k && i < days; i++) v[i] = 5.5;
	return v;
}

/** Observed flow with one flat stretch of 20 days at 0.2 m³/s from 20 Nov 2021: suspect, open. */
export function flatFlow(days: number): number[] {
	const v = syntheticFlow(days);
	for (let i = 50; i < 70; i++) v[i] = 0.2;
	return v;
}

/**
 * A runnable project: the sample model, `flats` rain flat stretches over `days` days of rain, and (unless
 * `flow` is false) an observed flow record with one flat stretch.
 */
export async function seedWarnings(request: APIRequestContext, name: string, { days = 120, flats = 2, flow = true } = {}): Promise<{ id: string }> {
	const project = await createProject(request, name);
	await putModel(request, project.id, sampleModel());
	await updateSettings(request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: [2000, 1500, 1000, 1000, 1000, 1500, 2500, 4000, 5000, 5000, 4000, 3000]
	});
	await putSeries(request, project.id, { kind: 'rain_catchment_mm', name: 'Valley gauge', unit: 'mm', startDate: START, values: flatRain(days, flats) });
	if (flow) await putSeries(request, project.id, { kind: 'flow_observed_m3s', name: 'Weir record', unit: 'm³/s', startDate: START, values: flatFlow(days) });
	return project;
}

export async function openWarnings(page: Page, projectId: string, query = '') {
	await page.goto(`/projects/${projectId}?tab=warnings${query}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Warnings' })).toBeVisible();
	await expect(warningsTable(page).or(page.getByTestId('warnings-empty')).or(page.getByTestId('warnings-none')).or(page.getByTestId('warn-other')).first()).toBeVisible();
}

export const checksPanel = (page: Page) => page.getByRole('region', { name: 'Data checks' });
export const warningsTable = (page: Page) => page.getByTestId('warnings-table');
export const warningRows = (page: Page) => warningsTable(page).locator('tbody tr[data-item]');
export const warningRow = (page: Page, text: string | RegExp) => warningRows(page).filter({ hasText: text });
export const statusChips = (page: Page) => checksPanel(page).getByRole('group', { name: 'Status' });
export const checkChips = (page: Page) => checksPanel(page).getByRole('group', { name: 'Check' });
export const bulkBar = (page: Page) => page.getByRole('toolbar', { name: 'Decide the ticked periods' });
export const runWarnings = (page: Page) => page.getByRole('region', { name: 'Run warnings' });

/** The project's saved settings, as the API answers them. */
export async function savedSettings(request: APIRequestContext, projectId: string): Promise<Record<string, unknown>> {
	const res = await request.get(`${API_URL}/projects/${projectId}`);
	expect(res.status()).toBe(200);
	return ((await res.json()) as { project: { settings: Record<string, unknown> } }).project.settings;
}

/** A run's summary, as the API answers it. */
export async function runSummary<T = Record<string, unknown>>(request: APIRequestContext, projectId: string, runId: string): Promise<T> {
	const res = await request.get(`${API_URL}/projects/${projectId}/runs/${runId}`);
	expect(res.status()).toBe(200);
	return ((await res.json()) as { run: { summary: T } }).run.summary;
}
