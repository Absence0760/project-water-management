// The nearest gauging stations, proposed as the observed-flow source (issue
// #326 Part B "B-gauge"; docs/ui.md § Data feeds, docs/maps.md § Gauging
// stations). In Settings → Data feeds, choosing DWS lists the river gauges
// nearest the catchment's outlet from the synthetic station list (region Z,
// invented): on the seeded Sandspruit, measured from its outlet gauge's point,
// nearest first; "Use" fills the station field and nothing is attached until
// the owner does. Without an outlet gauge on the map, the boundary's centre
// is used, and the panel says so. Reads the table and the form, never the map.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { ANALYST, SANDSPRUIT, seedExamplesOnce } from '../support/examples.ts';
import { expect, test } from '../support/fixtures.ts';
import { boundaryGeoJson, loadSyntheticStations } from '../support/map.ts';

test.beforeAll(async ({ playwright }) => {
	test.setTimeout(90_000);
	await loadSyntheticStations();
	const api = await playwright.request.newContext();
	await seedExamplesOnce(api);
	await api.dispose();
});

async function signInAs(page: Page, who: { email: string; password: string }) {
	await page.goto('/login');
	await page.getByLabel('Email').fill(who.email);
	await page.getByLabel('Password').fill(who.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
}

/** Settings → Data feeds → Attach a feed → DWS, once the proposal has loaded. */
async function openDwsForm(page: Page, projectId: string) {
	await page.goto(`/projects/${projectId}?tab=settings`);
	const panel = page.getByRole('region', { name: 'Data feeds' });
	await panel.getByRole('button', { name: 'Attach a feed' }).click();
	await panel.getByLabel('Source').selectOption({ label: 'DWS gauge flow' });
	const nearest = panel.getByTestId('nearest-gauges');
	await expect(nearest).toHaveAttribute('data-ready', 'true');
	return { panel, nearest };
}

test('on the seeded Sandspruit, the stations nearest its outlet gauge are listed nearest first, and Use fills the station field', async ({ page }) => {
	await signInAs(page, ANALYST);
	const res = await page.request.get(`${API_URL}/projects`);
	const id = ((await res.json()) as { projects: { id: string; name: string }[] }).projects.find((p) => p.name === SANDSPRUIT)!.id;
	const { panel, nearest } = await openDwsForm(page, id);

	await expect(nearest.getByTestId('nearest-gauges-point')).toHaveText('River gauges within 50 km of the outlet gauge “Sandspruit Outlet” on the map, nearest first.');
	await expect(nearest.getByText('Sample stations')).toBeVisible();
	const rows = nearest.getByTestId('nearest-gauges-table').locator('tbody tr');
	// River gauges only (the reservoir Z1R001 beside the outlet is left out), nearest first.
	await expect(rows.locator('th strong')).toHaveText(['Z1H001', 'Z1H003', 'Z1H002', 'Z1H004', 'Z1H005']);
	const first = rows.first();
	await expect(first.getByRole('cell').nth(0)).toHaveText('Sandspruit');
	await expect(first.getByRole('cell').nth(1)).toHaveText('2.8 km');
	await expect(first.getByRole('cell').nth(2)).toHaveText('1968–2024 (56 years)');
	await expect(first.getByRole('rowheader')).toContainText('SYNTHETIC');

	await expectNoViolations(page, { include: '#set-feeds' });

	// Use fills the field and moves focus to it; the row says it's in the field. Nothing is attached.
	const station = panel.getByLabel('DWS station');
	await expect(station).toHaveValue('');
	await nearest.getByRole('button', { name: 'Use Z1H003' }).click();
	await expect(station).toHaveValue('Z1H003');
	await expect(station).toBeFocused();
	await expect(rows.nth(1).getByText('In the field')).toBeVisible();
	await expect(nearest.getByRole('button', { name: 'Use Z1H003' })).toHaveCount(0);
	await panel.getByRole('button', { name: 'Cancel' }).click();
	await expect(panel.getByRole('listitem').filter({ hasText: 'DWS' })).toHaveCount(0);
});

test('without an outlet gauge on the map, the stations are measured from the boundary’s centre, and the panel says so', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Nearest gauges from the boundary');
	const imported = await page.request.post(`${API_URL}/projects/${project.id}/map/import`, { data: { fileName: 'boundary.geojson', kind: 'catchment_boundary', text: boundaryGeoJson() } });
	expect(imported.status(), await imported.text()).toBe(201);
	const { nearest } = await openDwsForm(page, project.id);
	await expect(nearest.getByTestId('nearest-gauges-point')).toContainText('of the centre of the catchment boundary “Synthetic catchment”, nearest first. The outflow gauge has no point on the map');
	await expect(nearest.getByTestId('nearest-gauges-table').locator('tbody tr th strong').first()).toHaveText('Z1H002');
});
