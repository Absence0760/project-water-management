// The Scenarios section (?tab=scenarios, issue #17 option A): locators and a
// big synthetic case. Invented names and numbers only.
import type { APIRequestContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { createRun, seedRunnableProject, type Model } from './api.ts';
import { API_URL } from './env.ts';

export const header = (page: Page) => page.getByTestId('section-header');
/** The rail: the list of scenarios (or an applicant's applications). */
export const rail = (page: Page) => page.getByRole('region', { name: /^(All scenarios|Your applications)$/ });
export const scenarioList = (page: Page) => rail(page).getByRole('list');
export const newDialog = (page: Page, name = 'New scenario') => page.getByRole('dialog', { name });

export async function openScenarios(page: Page, projectId: string, query = '') {
	await page.goto(`/projects/${projectId}?tab=scenarios${query}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Scenarios' })).toBeVisible();
}

export async function createScenario(request: APIRequestContext, projectId: string, body: Record<string, unknown>): Promise<string> {
	const res = await request.post(`${API_URL}/projects/${projectId}/scenarios`, { data: body });
	expect(res.status()).toBe(201);
	return ((await res.json()) as { scenario: { id: string } }).scenario.id;
}

/** A runnable project with one run and `n` scenarios on it (long names; every other one raises the Upper farm dam). Newest last. */
export async function seedManyScenarios(
	request: APIRequestContext,
	name: string,
	n = 30
): Promise<{ id: string; model: Model; runId: string; upper: string; ids: string[] }> {
	const project = await seedRunnableProject(request, name);
	const runId = await createRun(request, project.id, 'Baseline');
	const upper = (project.model.nodes as { id: string; name: string }[]).find((x) => x.name === 'Upper farm')!.id;
	const ids: string[] = [];
	for (let i = 1; i <= n; i++) {
		ids.push(
			await createScenario(request, project.id, {
				name: `${['Upper', 'Middle', 'Lower'][i % 3]} catchment what-if ${i}: ${['dam raised', 'new orchard block', 'river pump licence', 'dry-year rainfall'][i % 4]}`,
				baseRunId: runId,
				ops: i % 2 ? [{ op: 'node.set', nodeId: upper, field: 'damCapacityM3', value: 150_000 + i * 1000 }] : []
			})
		);
	}
	return { ...project, runId, upper, ids };
}
