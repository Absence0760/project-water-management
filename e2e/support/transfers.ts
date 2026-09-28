// The Transfers page (?tab=transfers, issue #17 option A): locators and a
// big synthetic catchment. Invented names and numbers only.
import type { APIRequestContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { createProject, putModel, sampleModel, type Model } from './api.ts';

export const rulesCard = (page: Page) => page.getByRole('region', { name: 'Transfer rules' });
export const monthsCard = (page: Page) => page.getByRole('region', { name: 'When water moves' });
/** Each month's line as a screen reader hears it ("Nov: 1 rule, up to 864 m³ a day"). */
export const monthSentences = (page: Page) => monthsCard(page).getByRole('listitem').locator('.visually-hidden').allTextContents();

/**
 * Opens the Transfers page and waits for the tab itself, not just the page's title: the section header (and
 * its rule count) render as soon as the model loads, while the rules and months come from a code-split
 * chunk that arrives after. The rules card is drawn in every state (rules, none yet, too few units).
 */
export async function openTransfers(page: Page, projectId: string) {
	await page.goto(`/projects/${projectId}?tab=transfers`);
	await expect(page.getByRole('heading', { level: 1, name: 'Transfers' })).toBeVisible();
	await expect(rulesCard(page)).toBeVisible();
}

/** A project with the outflow gauge, `farms` farms with long names and `rules` transfer rules between them (every sixth off). */
export async function seedManyTransfers(request: APIRequestContext, name: string, farms = 14, rules = 30): Promise<{ id: string; model: Model }> {
	const project = await createProject(request, name);
	const model = sampleModel();
	const gauge = model.nodes[0]!;
	const units = Array.from({ length: farms }, (_, i) => ({
		...model.nodes[1]!,
		id: crypto.randomUUID(),
		name: `${['Upper', 'Middle', 'Lower', 'Riverside', 'Hillcrest'][i % 5]} ${['Kloof', 'Vlei', 'Rant', 'Bos'][i % 4]} farm ${i + 1}`,
		sortOrder: i + 2,
		downstreamNodeId: gauge.id
	}));
	model.nodes = [gauge, ...units];
	model.cropAreas = [];
	model.transfers = Array.from({ length: rules }, (_, i) => ({
		id: crypto.randomUUID(),
		fromNodeId: units[i % farms]!.id,
		toNodeId: units[(i * 3 + 1) % farms]!.id,
		months: [[11, 12, 1, 2], [6, 7, 8], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], [10, 11]][i % 4]!,
		maxRateM3s: 0.005 * (1 + (i % 7)),
		dailyCapM3: i % 3 === 0 ? 400 : null,
		minStoragePct: 0.1 * (i % 5),
		enabled: i % 6 !== 5,
		priority: i % 10
	}));
	await putModel(request, project.id, model);
	return { id: project.id, model };
}
