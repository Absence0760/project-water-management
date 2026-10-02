// The frame the three map-proposal panels share (issue #326 Part B: land cover
// in a unit's planted-areas drawer, the dams on Dams, evaporation in Settings;
// components/proposals/ProposalPanel.svelte): pinned before it was folded into
// one component, and kept as its guard. Each panel says when its proposals
// can't be loaded, with the reason, and Try again loads them; the dams panel
// says when a unit has no dam on the map. The happy paths, Use and the
// viewer's view are each panel's own spec (cropland-proposals.spec.ts,
// dam-proposals.spec.ts, evaporation-proposal.spec.ts). Invented data only.
import type { Page } from '@playwright/test';
import { seedRunnableProject } from '../support/api.ts';
import { loadSyntheticDamRegister } from '../support/damRegister.ts';
import { API_URL } from '../support/env.ts';
import { loadSyntheticEvaporation } from '../support/evaporation.ts';
import { expect, test } from '../support/fixtures.ts';
import { loadSyntheticLandCover } from '../support/landCover.ts';
import { box } from '../support/map.ts';

/** The first GET matching `pattern` answers 500 with `error`; later ones reach the API. */
async function failOnce(page: Page, pattern: RegExp, error: string) {
	let failed = false;
	await page.route(pattern, async (route) => {
		if (failed || route.request().method() !== 'GET') return route.continue();
		failed = true;
		await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error }) });
	});
}

async function feature(page: Page, projectId: string, data: Record<string, unknown>) {
	const made = await page.request.post(`${API_URL}/projects/${projectId}/map/features`, { data });
	expect(made.status(), await made.text()).toBe(201);
}

test.beforeAll(async () => {
	await Promise.all([loadSyntheticLandCover(), loadSyntheticDamRegister(), loadSyntheticEvaporation()]);
});

test('land cover: a failed load says why, and Try again loads the summary', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Panel frame land cover');
	const upper = String(project.model.nodes.find((n) => n.name === 'Upper farm')!.id);
	await feature(page, project.id, { kind: 'farm_parcel', name: 'Lower lands', nodeId: upper, geometry: { type: 'Polygon', coordinates: [box(21.31, -33.69, 0.01)] } });
	await failOnce(page, /\/cropland-proposals(\?|$)/, 'Test outage');
	await page.goto(`/projects/${project.id}?tab=crops&farm=${upper}`);
	const panel = page.getByTestId('cropland-proposals');
	await expect(panel.getByTestId('cropland-body')).toHaveAttribute('data-ready', 'true');
	await expect(panel.getByRole('alert')).toHaveText(/^The land-cover summary couldn’t be loaded \(Test outage\)\.\s*Try again$/);
	await panel.getByRole('button', { name: 'Try again' }).click();
	await expect(panel.getByTestId('cropland-parcels').locator('tbody tr')).toHaveCount(1);
	await expect(panel.getByRole('alert')).toHaveCount(0);
	await expect(panel.getByTestId('cropland-synthetic')).toContainText('Synthetic test data.');
});

test('dams: a failed load says why and Try again loads it; a unit with no dam on the map is told to draw one', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Panel frame dams');
	await failOnce(page, /\/dam-proposals(\?|$)/, 'Test outage');
	await page.goto(`/projects/${project.id}?tab=dams`);
	const panel = page.getByTestId('dam-proposals');
	await expect(panel.getByTestId('dam-proposals-body')).toHaveAttribute('data-ready', 'true');
	await expect(panel.getByRole('alert')).toHaveText(/^The proposals couldn’t be loaded \(Test outage\)\.\s*Try again$/);
	await panel.getByRole('button', { name: 'Try again' }).click();
	await expect(panel.getByRole('alert')).toHaveCount(0);
	await panel.getByLabel('Dam of').selectOption({ label: 'Upper farm' });
	await expect(panel.getByTestId('dam-proposals-no-dam')).toContainText('No dam on the map is linked to Upper farm.');
	await expect(panel.getByTestId('dam-proposals-no-dam').getByRole('link', { name: 'Open the Map' })).toHaveAttribute('href', '?tab=map');
});

test('evaporation: a failed load says why, and Try again loads the proposal', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Panel frame evaporation');
	await feature(page, project.id, { kind: 'catchment_boundary', name: 'Catchment', geometry: { type: 'Polygon', coordinates: [box(21.26, -33.74, 0.18)] } });
	await failOnce(page, /\/evaporation-proposals(\?|$)/, 'Test outage');
	await page.goto(`/projects/${project.id}?tab=settings`);
	const panel = page.getByTestId('evaporation-proposal');
	await expect(panel.getByTestId('evaporation-body')).toHaveAttribute('data-ready', 'true');
	await expect(panel.getByRole('alert')).toHaveText(/^The evaporation summary couldn’t be loaded \(Test outage\)\.\s*Try again$/);
	await panel.getByRole('button', { name: 'Try again' }).click();
	await expect(panel.getByTestId('evaporation-rows')).toBeVisible();
	await expect(panel.getByRole('alert')).toHaveCount(0);
	await expect(panel.getByTestId('evaporation-synthetic')).toContainText('Synthetic test data.');
});
