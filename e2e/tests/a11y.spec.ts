// Automated WCAG 2.1 AA scan (axe-core) of every page and workspace tab.
// axe finds a subset of problems — keyboard and screen-reader checks still
// need a person — but anything it does flag must stay fixed.
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function expectNoViolations(page: Page) {
	const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
	const report = violations.map((v) => ({
		id: v.id,
		impact: v.impact,
		help: v.help,
		nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5)
	}));
	expect(report).toEqual([]);
}

// Both themes: the dark palette has its own contrast to keep in check.
for (const colorScheme of ['light', 'dark'] as const) {
	test.describe(`${colorScheme} theme`, () => {
		test.use({ colorScheme });

		test.describe('signed out', () => {
			for (const path of ['/login', '/register']) {
				test(`${path} has no WCAG 2.1 AA violations`, async ({ page }) => {
					await page.goto(path);
					await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
					await expectNoViolations(page);
				});
			}

			test('the login error state has no violations', async ({ page }) => {
				await page.goto('/login');
				await page.getByLabel('Email').fill('nobody@example.com');
				await page.getByLabel('Password').fill('wrong password');
				await page.getByRole('button', { name: 'Sign in' }).click();
				await expect(page.getByRole('alert')).toBeVisible();
				await expectNoViolations(page);
			});
		});

		test.describe('signed in', () => {
			test('the empty project list has no violations', async ({ page, owner }) => {
				void owner;
				await page.goto('/');
				await expect(page.getByText('You have no projects yet.')).toBeVisible();
				await expectNoViolations(page);
			});

			test('the project list and new-project dialog have no violations', async ({ page, owner }) => {
				void owner;
				await seedRunnableProject(page.request, 'Accessible catchment');
				await page.goto('/');
				await expect(page.getByRole('rowheader', { name: 'Accessible catchment' })).toBeVisible();
				await expectNoViolations(page);

				await page.getByRole('button', { name: 'New project' }).click();
				await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible();
				await expectNoViolations(page);
			});

			// Each tab waits for the content axe should see, not just the tab shell.
			const TABS: { id: string; ready: (page: Page) => Promise<void> }[] = [
				{ id: 'overview', ready: (p) => expect(p.getByRole('columnheader', { name: 'Email' })).toBeVisible() },
				{ id: 'network', ready: (p) => expect(p.getByRole('list', { name: 'Drainage tree' })).toBeVisible() },
				{ id: 'crops', ready: (p) => expect(p.getByRole('heading', { name: 'Planted areas' })).toBeVisible() },
				{ id: 'transfers', ready: (p) => expect(p.getByLabel('Source of transfer 1')).toBeVisible() },
				{ id: 'settings', ready: (p) => expect(p.getByRole('heading', { name: 'Flow calibration' })).toBeVisible() },
				{ id: 'series', ready: (p) => expect(p.getByRole('button', { name: 'View' })).toHaveCount(2) },
				{
					id: 'runs',
					ready: async (p) => {
						await expect(p.getByRole('region', { name: 'Run summary' })).toBeVisible();
						await expect(p.getByRole('img', { name: /line chart/ }).first().locator('canvas')).toBeVisible();
					}
				}
			];

			for (const t of TABS) {
				test(`the ${t.id} tab has no violations`, async ({ page, owner }) => {
					void owner;
					const project = await seedRunnableProject(page.request, `A11y ${t.id}`);
					await createRun(page.request, project.id, 'Baseline');
					await page.goto(`/projects/${project.id}?tab=${t.id}`);
					await t.ready(page);
					await expectNoViolations(page);
				});
			}

			test('the model save bar and validation messages have no violations', async ({ page, owner }) => {
				void owner;
				const project = await seedRunnableProject(page.request, 'A11y save bar');
				await page.goto(`/projects/${project.id}?tab=network`);
				await page.getByLabel('Lower farm drains into').selectOption({ label: '— Outlet (none) —' });
				await expect(page.getByText('Fix before saving:')).toBeVisible();
				await expectNoViolations(page);
			});
		});
	});
}
