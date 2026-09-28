// The Data section (?tab=series, issue #17 option A): locators and seeding for data-page.spec.ts.
// Synthetic series only, dated back from today so "behind" is stable whatever day the suite runs.
import type { APIRequestContext, Page } from '@playwright/test';
import { putSeries } from './api.ts';
import { expect } from './fixtures.ts';

export const seriesTable = (page: Page) => page.getByRole('region', { name: 'Input time series' }).getByRole('table');
export const seriesRows = (page: Page) => seriesTable(page).getByRole('row').filter({ has: page.getByRole('rowheader') });
export const seriesRow = (page: Page, text: string) => seriesRows(page).filter({ hasText: text });
export const seriesChart = (page: Page) => page.getByRole('region', { name: 'Series chart' });
export const sections = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });

/** Today in UTC (the e2e browser runs in UTC), minus `days`, as YYYY-MM-DD. */
export function daysAgo(days: number): string {
	return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** A daily series of `length` days ending `endAgo` days before today (negative: into the future). */
export async function putEnding(
	request: APIRequestContext,
	projectId: string,
	s: { kind: string; name: string; endAgo: number; length?: number }
): Promise<void> {
	const length = s.length ?? 400;
	const values = Array.from({ length }, (_, d) => (s.kind.endsWith('_mm') ? (d % 7 === 0 ? 12 : 0) : 1 + ((d % 30) / 30)));
	await putSeries(request, projectId, {
		kind: s.kind,
		name: s.name,
		unit: s.kind.endsWith('_mm') ? 'mm' : 'm³/s',
		startDate: daysAgo(s.endAgo + length - 1),
		values
	});
}

/**
 * Five series, one of each role: catchment rain up to yesterday, CHIRPS 20 days old and A-pan 45 days old (both
 * behind: a run reads them), a logger 60 days old (only scores a run, so not behind) and a forecast running ahead.
 */
export async function seedFreshnessMix(request: APIRequestContext, projectId: string): Promise<void> {
	await putEnding(request, projectId, { kind: 'rain_catchment_mm', name: 'Gauge R1', endAgo: 1 });
	await putEnding(request, projectId, { kind: 'rain_chirps_mm', name: 'CHIRPS cell', endAgo: 20 });
	await putEnding(request, projectId, { kind: 'evap_apan_mm', name: 'Pan station', endAgo: 45 });
	await putEnding(request, projectId, { kind: 'flow_logger_m3s', name: 'Logger L1', endAgo: 60 });
	await putEnding(request, projectId, { kind: 'rain_forecast_mm', name: 'Forecast F1', endAgo: -10, length: 30 });
}

export async function openData(page: Page, projectId: string, query = '') {
	await page.goto(`/projects/${projectId}?tab=series${query}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Data' })).toBeVisible();
}

export const chartReady = (page: Page) => expect(seriesChart(page).locator('figure.chart')).toHaveAttribute('data-ready', 'true');
