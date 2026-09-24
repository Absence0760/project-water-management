// The invented example catchments (`pnpm seed:examples`) as their demo users
// see them: several catchments each, some owned, some shared through a team
// or directly, with a pre-computed run. Seeds them into water_e2e with the
// backend's own seeding CLI, once per suite run.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { API_URL, APP_E2E_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

// DEV-ONLY demo credentials, as printed by `pnpm seed:examples`.
const DEMO = { email: 'demo@example.com', password: 'demo-password' };
const ANALYST = { email: 'analyst@example.com', password: 'demo-password' };
const KLEINBERG = 'Example · Kleinberg (winter rainfall)';
const DROEVLEI = 'Example · Droëvlei (water-stressed)';
const SANDSPRUIT = 'Example · Sandspruit (summer rainfall, larger network)';

const backendDir = fileURLToPath(new URL('../../backend/', import.meta.url));

// One seeding per run: the tests in this file share the seeded users.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }) => {
	// Seeding is real work, not waiting: it runs Kleinberg's automatic GR4J
	// calibration for its stored fit (~7 s alone) and three 15-year model runs:
	// 15–20 s on an idle laptop, too close to the default 30 s once the e2e
	// servers share the machine.
	test.setTimeout(90_000);
	const api = await playwright.request.newContext();
	const probe = await api.post(`${API_URL}/auth/login`, { data: DEMO });
	await api.dispose();
	if (probe.ok()) return; // already seeded earlier in this run (e.g. --repeat-each)
	execFileSync('pnpm', ['exec', 'tsx', 'scripts/seed-examples.ts'], {
		cwd: backendDir,
		env: { ...process.env, DATABASE_URL: APP_E2E_URL },
		stdio: 'pipe'
	});
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
		// The "Your role" cell (column positions vary: the Team column only shows in some groups).
		.getByRole('cell')
		.filter({ hasText: /^(owner|editor|viewer)$/ });

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
	await page.getByRole('link', { name: SANDSPRUIT }).click();
	await expect(page.getByRole('heading', { level: 1, name: SANDSPRUIT })).toBeVisible();

	await page.getByRole('link', { name: 'Network' }).click();
	await expect(page.getByText('You have view-only access to this project.')).toBeVisible();
	await expect(page.getByRole('textbox', { name: 'Name' }).first()).not.toBeEditable();
	await expect(page.getByRole('button', { name: '+ Add node' })).toHaveCount(0);

	await page.getByRole('link', { name: 'Runs' }).click();
	await expect(page.getByRole('button', { name: /^Initial run \(seed\)/ })).toHaveAttribute('aria-current', 'true');
	await expect(page.getByRole('region', { name: 'Run summary' }).getByRole('heading', { name: 'Farms' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Run model' })).toHaveCount(0);
});
