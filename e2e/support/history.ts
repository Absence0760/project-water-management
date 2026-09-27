// The History page's helpers (?tab=history, docs/ui.md § History): open it,
// its parts, and a long synthetic history to test it at size. Names and
// numbers are made up.
import type { APIRequestContext, Page } from '@playwright/test';
import { putSeries, seedRunnableProject, updateSettings, type Model } from './api.ts';
import { API_URL } from './env.ts';

/** The timeline card (a region named by its heading). */
export const historyCard = (page: Page) => page.getByRole('region', { name: 'Changes, newest first' });
/** The picked change, beside the timeline on a wide page. */
export const historyDetail = (page: Page) => page.getByTestId('history-detail');
/** The timeline's entries: whole entries in a narrow column, compact rows beside the detail on a wide one. */
export const historyEntries = (page: Page) => page.getByTestId('history-entry');
/** The section header's one-line context. */
export const historyContext = (page: Page) => page.getByTestId('section-header').getByTestId('section-context');

export async function openHistory(page: Page, projectId: string, query = '') {
	await page.goto(`/projects/${projectId}?tab=history${query}`);
	await historyEntries(page).first().or(page.getByTestId('history-empty')).waitFor();
}

/** Save the model with a reason, as the save bar does. */
async function saveModel(request: APIRequestContext, projectId: string, model: Model, reason?: string) {
	const res = await request.put(`${API_URL}/projects/${projectId}/model`, { data: reason ? { ...model, reason } : model });
	if (res.status() !== 200) throw new Error(`PUT model ${res.status()}: ${await res.text()}`);
}

export const LONG_REASON =
	'The owner confirmed the dam wall was raised after the 2019 floods, so the capacity in the licence is out of date until the survey report arrives';
const REASONS = ['Surveyed in August', LONG_REASON, 'Irrigation scheduling changed to drip on the lower blocks', '', 'Back to the licence figure'];

/**
 * A runnable project (Upper farm, Lower farm; its seeding writes four
 * entries) with `changes` more on top, oldest first, in a cycle of six: a dam
 * capacity save with a reason, an irrigation efficiency save, a settings
 * change, another dam capacity save, the rain series replaced, and a
 * catchment area save. Every save changes something, so each is an entry.
 */
export async function seedLongHistory(request: APIRequestContext, name: string, changes = 36): Promise<{ id: string; upper: string; lower: string }> {
	const project = await seedRunnableProject(request, name);
	const model = project.model;
	const upper = model.nodes.find((n) => n.name === 'Upper farm')!;
	const lower = model.nodes.find((n) => n.name === 'Lower farm')!;
	for (let i = 0; i < changes; i++) {
		const step = i % 6;
		if (step === 0 || step === 3) {
			upper.damCapacityM3 = 150_000 + (i + 1) * 2_500;
			await saveModel(request, project.id, model, REASONS[i % REASONS.length]);
		} else if (step === 1) {
			lower.irrigationEfficiency = lower.irrigationEfficiency === 0.8 ? 0.85 : 0.8;
			await saveModel(request, project.id, model, REASONS[(i + 2) % REASONS.length]);
		} else if (step === 2) {
			await updateSettings(request, project.id, { ewrPragmaticM3PerDay: Array.from({ length: 12 }, (_, m) => 1_000 + ((i + m) % 5) * 500 + i) });
		} else if (step === 4) {
			await putSeries(request, project.id, {
				kind: 'rain_catchment_mm',
				unit: 'mm',
				startDate: '2021-10-01',
				values: Array.from({ length: 120 }, (_, d) => ((d + i) % 9 === 0 ? 20 : 0))
			});
		} else {
			lower.areaKm2 = 8 + i / 6;
			await saveModel(request, project.id, model);
		}
	}
	return { id: project.id, upper: String(upper.id), lower: String(lower.id) };
}
