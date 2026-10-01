// The invented example catchments (`pnpm seed:examples`) as their demo users
// see them: several catchments each, some owned, some shared through a team
// or directly, with a pre-computed run. Seeds them into water_e2e with the
// backend's own seeding CLI, once per suite run.
import type { Page } from '@playwright/test';
import { API_URL } from '../support/env.ts';
import { ANALYST, DEMO, DROEVLEI, FARMER1, KLEINBERG, SANDSPRUIT, seedExamplesOnce } from '../support/examples.ts';
import { expect, test } from '../support/fixtures.ts';
import { closeModal, openNodeTable } from '../support/network.ts';

// One seeding per run: the tests in this file share the seeded users.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }) => {
	test.setTimeout(90_000);
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

const roleIn = (page: Page, name: string) =>
	page
		.getByRole('row')
		.filter({ has: page.getByRole('rowheader', { name, exact: true }) })
		// The role sits under the name in the row header since the Projects list redesign (#17).
		.getByTestId('project-role');

test('each demo user sees their own and shared example catchments with the right role', async ({ page, browser }) => {
	await signInAs(page, DEMO);
	await expect(roleIn(page, KLEINBERG)).toHaveText('owner');
	await expect(roleIn(page, DROEVLEI)).toHaveText('owner');
	await expect(roleIn(page, SANDSPRUIT)).toHaveText('viewer');

	const context = await browser.newContext();
	const analyst = await context.newPage();
	await signInAs(analyst, ANALYST);
	await expect(roleIn(analyst, KLEINBERG)).toHaveText('editor');
	await expect(roleIn(analyst, DROEVLEI)).toHaveText('editor');
	await expect(roleIn(analyst, SANDSPRUIT)).toHaveText('owner');
	await context.close();
});

test('a shared example opens read-only with its seeded run', async ({ page }) => {
	await signInAs(page, DEMO);
	await page.locator('table.projects').getByRole('link', { name: SANDSPRUIT, exact: true }).click();
	await expect(page.getByTestId('project-name').filter({ hasText: SANDSPRUIT })).toBeVisible();

	// A viewer's model inputs sit behind "Show model inputs" (issue #6).
	await page.getByLabel('Show model inputs').check();
	await page.getByRole('link', { name: 'Network', exact: true }).click();
	await openNodeTable(page);
	await expect(page.getByText('You have view-only access to this project.')).toBeVisible();
	await expect(page.getByRole('textbox', { name: 'Name' }).first()).not.toBeEditable();
	await expect(page.getByRole('button', { name: '+ Add node' })).toHaveCount(0);
	await closeModal(page);

	await page.getByRole('link', { name: 'Runs & results' }).click();
	await expect(page.getByRole('button', { name: /^Initial run \(seed\)/ })).toHaveAttribute('aria-current', 'true');
	await expect(page.getByRole('region', { name: 'Run summary' }).getByRole('heading', { name: 'Catchment' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Run model' })).toHaveCount(0);
	// The per-unit table is on Units & supply (issue #17), which a viewer sees too.
	await page.getByRole('link', { name: 'Hydrological units', exact: true }).click();
	await expect(page.getByRole('heading', { level: 3, name: 'Hydrological unit results' })).toBeVisible();
});

// Issue #288: Sandspruit's invented map (backend/scripts/examples/map.ts), read from the list, not the map's pixels.
test('a shared example has a seeded catchment map: a boundary, linked parcels, dams, gauges and streams', async ({ page }) => {
	await signInAs(page, DEMO);
	await page.locator('table.projects').getByRole('link', { name: SANDSPRUIT, exact: true }).click();
	await expect(page.getByTestId('project-name').filter({ hasText: SANDSPRUIT })).toBeVisible();
	await page.goto(`${page.url().split('?')[0]}?tab=map`);

	const list = page.getByTestId('map-feature-list');
	await expect(list.getByRole('listitem')).toHaveCount(23);
	await expect(page.getByTestId('map-no-boundary')).toHaveCount(0);
	await expect(page.getByTestId('map-summary')).toHaveText(/^23 features · boundary 210[.,]\d+ km² · 0 of 8 unit areas from the map$/);
	// Grouped by kind, parcels first (#326 E3); each row its size, what it stands for, and a parcel's unit's area source.
	await expect(list.getByRole('heading', { level: 3 })).toHaveText([/^Farm parcels/, /^Dams/, /^Gauges/, /^Rivers/, /^Catchment boundary/]);
	const item = (name: string) => list.getByRole('listitem').filter({ has: page.getByRole('button', { name: new RegExp(`^${name}\\b`) }) }).first();
	await expect(item('Sandspruit catchment')).toContainText(/210[.,]\d+ km²/);
	await expect(item('Klipdrift')).toContainText(/km² · linked · area typed/);
	await expect(item('Klipdrift dam')).toContainText(/ha · Klipdrift/);
	await expect(item('Melkhout Gauge')).toContainText(/E · linked/);
	await expect(list.getByRole('group', { name: /Rivers/ }).getByRole('listitem').filter({ hasText: /^\s*Sandspruit\s*1 line\s*$/ })).toHaveCount(1);
	await page.getByTestId('map-open-grid').click();
	await expect(page.getByRole('dialog', { name: 'Every map feature' }).getByText('sandspruit-map.synthetic.geojson', { exact: true })).toBeVisible();
});

// WP-2.1: the seeded farmers, as the owner manages them and as a farmer's own list shows them.
test('the owner sees the seeded farmers with their farms, and a farmer sees only their own catchment', async ({ page, browser }) => {
	await signInAs(page, ANALYST);
	await page.locator('table.projects').getByRole('link', { name: SANDSPRUIT, exact: true }).click();
	await expect(page.getByTestId('project-name').filter({ hasText: SANDSPRUIT })).toBeVisible();
	// Who has access is on the Project page (issue #17).
	await page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Project', exact: true }).click();
	const farmers = page.getByRole('region', { name: /^Farmers/ });
	// The two farmers, and the demo applicant (WP-3.3), who keeps a farm link too.
	await expect(farmers.getByRole('heading', { name: 'Farmers (3)' })).toBeVisible();
	await expect(farmers.getByRole('row').filter({ has: page.getByRole('rowheader', { name: /^Demo Applicant/ }) })).toContainText('Klipdrift');
	await expect(farmers.getByRole('row').filter({ has: page.getByRole('rowheader', { name: /^Demo Farmer\b(?! Two)/ }) })).toContainText('Vaalbank');
	await expect(farmers.getByRole('row').filter({ has: page.getByRole('rowheader', { name: /^Demo Farmer Two/ }) })).toContainText('Rietspruit');
	// Farmers aren't listed as members.
	await expect(page.getByRole('region', { name: /Members|Shared directly with/ }).getByText('farmer1@example.com')).toHaveCount(0);

	// A farmer has no workspace (WP-2.6): signing in lands on the farm view,
	// and the workspace URL of their catchment sends them there too. Their
	// project list (the API) still holds only their own catchment, as a farmer.
	const context = await browser.newContext();
	const farmer = await context.newPage();
	await farmer.goto('/login');
	await farmer.getByLabel('Email').fill(FARMER1.email);
	await farmer.getByLabel('Password').fill(FARMER1.password);
	await farmer.getByRole('button', { name: 'Sign in' }).click();
	await expect(farmer).toHaveURL(/\/farm(\/|$)/);
	const listed = (await (await context.request.get(`${API_URL}/projects`)).json()) as { projects: { id: string; name: string; role: string }[] };
	expect(listed.projects.map((p) => [p.name, p.role])).toEqual([[SANDSPRUIT, 'farmer']]);
	expect(listed.projects.map((p) => p.name)).not.toContain(KLEINBERG);
	expect(listed.projects.map((p) => p.name)).not.toContain(DROEVLEI);
	await farmer.goto(`/projects/${listed.projects[0]!.id}`);
	await expect(farmer).toHaveURL(new RegExp(`/farm/${listed.projects[0]!.id}`));
	await context.close();
});

// WP-2.3: every example's seeded run is published by its owner, Sandspruit with an
// advisory notice, so the seeded farmer has figures (the farm page itself is WP-2.6's).
test('the seeded farmer reads their published farm and the advisory notice', async ({ page }) => {
	// A farmer lands on their farm view, not the project list (WP-2.6).
	await page.goto('/login');
	await page.getByLabel('Email').fill(FARMER1.email);
	await page.getByLabel('Password').fill(FARMER1.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/farm\//);
	const projects = (await (await page.request.get(`${API_URL}/projects`)).json()).projects as { id: string; name: string }[];
	const sandspruit = projects.find((p) => p.name === SANDSPRUIT)!;
	const index = await (await page.request.get(`${API_URL}/projects/${sandspruit.id}/farm`)).json();
	expect(index.farms.map((f: { name: string }) => f.name)).toEqual(['Vaalbank']);
	expect(index.publication.restriction.level).toBe('advisory');
	const view = await page.request.get(`${API_URL}/projects/${sandspruit.id}/farm/${index.farms[0].nodeId}`);
	expect(view.status()).toBe(200);
	const body = await view.json();
	expect(body.farm.name).toBe('Vaalbank');
	expect(body.publication.restriction.level).toBe('advisory');
	expect(body.publication.restriction.notice.af).toMatch(/^Die rivier is laag/);
	expect(body.farm.monthly).toHaveLength(12);
});
