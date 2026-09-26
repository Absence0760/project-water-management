// Automated WCAG 2.2 A/AA scan (axe-core) of every page, every workspace tab
// and the main dialogs and states, in both themes, plus the phone layout.
// axe finds a subset of problems (keyboard and screen-reader checks still
// need a person), but anything it does flag must stay fixed: fix it at the
// source, never by disabling a rule here.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, createRun, seedRunnableProject, uniqueEmail, updateSettings } from '../support/api.ts';
import { plantInviteToken } from '../support/db.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const DEAD_TOKEN = 'q'.repeat(43);

// Each tab waits for the content axe should see, not just the tab shell.
const TABS: { id: string; ready: (page: Page) => Promise<void> }[] = [
	// (The Email column folds into the name cell on a phone, so wait on a member row.)
	{ id: 'overview', ready: (p) => expect(p.getByRole('region', { name: 'Members' }).getByRole('rowheader').first()).toBeVisible() },
	{ id: 'network', ready: (p) => expect(p.getByRole('list', { name: 'Drainage tree' })).toBeVisible() },
	{ id: 'crops', ready: (p) => expect(p.getByRole('heading', { name: 'Planted areas' })).toBeVisible() },
	{ id: 'transfers', ready: (p) => expect(p.getByLabel('Source of transfer 1')).toBeVisible() },
	{ id: 'settings', ready: (p) => expect(p.getByRole('heading', { name: 'Flow calibration' })).toBeVisible() },
	{ id: 'series', ready: (p) => expect(p.getByRole('button', { name: 'View', exact: true })).toHaveCount(2) },
	{
		id: 'runs',
		ready: async (p) => {
			await expect(p.getByRole('region', { name: 'Run summary' })).toBeVisible();
			await expect(p.getByRole('img', { name: /line chart/ }).first().locator('canvas')).toBeVisible();
		}
	}
];

// Both themes: the dark palette has its own contrast to keep in check.
for (const colorScheme of ['light', 'dark'] as const) {
	test.describe(`${colorScheme} theme`, () => {
		test.use({ colorScheme });

		test.describe('signed out', () => {
			for (const path of ['/login', '/register', '/forgot-password']) {
				test(`${path} has no WCAG 2.2 AA violations`, async ({ page }) => {
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

			// Emailed-link pages in their "this link is no good" states.
			for (const path of [`/reset-password?token=${DEAD_TOKEN}`, `/verify-email?token=${DEAD_TOKEN}`, `/register?invite=${DEAD_TOKEN}`]) {
				test(`${path.split('?')[0]} with a dead link has no violations`, async ({ page }) => {
					await page.goto(path);
					await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
					if (!path.startsWith('/reset-password')) await expect(page.getByRole('alert')).toBeVisible();
					await expectNoViolations(page);
				});
			}
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

			test('the one-node form and the Add data dialog have no violations', async ({ page, owner }) => {
				void owner;
				const project = await seedRunnableProject(page.request, 'A11y one node');
				await page.goto(`/projects/${project.id}?tab=network`);
				await page.getByRole('button', { name: 'One node' }).click();
				await page.getByLabel('Node to edit').selectOption({ label: '2. Upper farm · farm' });
				await expect(page.getByLabel('Capacity (m³)')).toHaveValue('150,000');
				await expectNoViolations(page);

				await page.getByRole('button', { name: 'Add data' }).click();
				await expect(page.getByRole('dialog', { name: 'Add data' })).toBeVisible();
				await expectNoViolations(page);
			});

			test('the view-only workspace has no violations', async ({ page, owner, signIn }) => {
				void owner;
				const project = await seedRunnableProject(page.request, 'A11y view only');
				await createRun(page.request, project.id, 'Baseline');
				const viewer = await signIn('A11y viewer');
				await addMember(page.request, project.id, viewer.user.email, 'viewer');
				for (const t of TABS.filter((x) => ['overview', 'network', 'runs'].includes(x.id))) {
					await viewer.page.goto(`/projects/${project.id}?tab=${t.id}`);
					await t.ready(viewer.page);
					await expect(viewer.page.getByText('View only', { exact: false }).first()).toBeVisible();
					await expectNoViolations(viewer.page);
				}
			});

			test('GR4J settings and a GR4J run have no violations', async ({ page, owner }) => {
				void owner;
				const project = await seedRunnableProject(page.request, 'A11y GR4J');
				await updateSettings(page.request, project.id, { runoffModel: 'gr4j', gr4j: { x1: 350, x2: -0.5, x3: 90, x4: 1.7, warmupDays: 365 } });
				await page.goto(`/projects/${project.id}?tab=settings`);
				await expect(page.getByLabel(/^Groundwater exchange X2/)).toHaveValue('-0.5');
				await expectNoViolations(page);
				await createRun(page.request, project.id, 'GR4J');
				await page.goto(`/projects/${project.id}?tab=runs`);
				const runoff = page.getByRole('region', { name: /^Runoff model: GR4J/ });
				await expect(runoff.getByRole('rowheader', { name: /Groundwater exchange/ })).toBeVisible();
				await expect(runoff.getByRole('img', { name: /^Model stores/ }).locator('canvas')).toBeVisible();
				await expectNoViolations(page);
			});

			test('an automatic calibration result has no violations', async ({ page, owner }) => {
				void owner;
				const project = await seedRunnableProject(page.request, 'A11y fit');
				await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
				await page.goto(`/projects/${project.id}?tab=settings`);
				const fit = page.getByRole('region', { name: /^Fit automatically/ });
				await fit.getByLabel('Model runs per fit').fill('50');
				await fit.getByRole('button', { name: 'Fit automatically', exact: true }).click();
				await expect(fit.getByRole('table', { name: /^Fit, and validation/ })).toBeVisible();
				await expectNoViolations(page);
			});

			test('comparing two runs has no violations', async ({ page, owner }) => {
				void owner;
				const project = await seedRunnableProject(page.request, 'A11y compare');
				await createRun(page.request, project.id, 'First');
				await createRun(page.request, project.id, 'Second');
				await page.goto(`/compare?project=${project.id}`);
				await expect(page.getByRole('heading', { name: 'Headline results' })).toBeVisible();
				await expect(page.getByRole('img', { name: /line chart/ }).first().locator('canvas')).toBeVisible();
				await expectNoViolations(page);
			});

			test('teams, a team page, help and a help guide have no violations', async ({ page, owner }) => {
				void owner;
				await page.goto('/teams');
				await expect(page.getByRole('heading', { level: 1, name: 'Teams' })).toBeVisible();
				await expectNoViolations(page);

				const res = await page.request.post(`${API_URL}/teams`, { data: { name: 'A11y team' } });
				expect(res.status()).toBe(201);
				const { team } = (await res.json()) as { team: { id: string } };
				await page.goto(`/teams/${team.id}`);
				await expect(page.getByRole('heading', { level: 1, name: 'A11y team' })).toBeVisible();
				await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
				await expectNoViolations(page);

				await page.goto('/help');
				await expect(page.getByRole('heading', { level: 1, name: 'How the catchment model works' })).toBeVisible();
				await expect(page.getByRole('img', { name: /An illustrated catchment/ })).toBeVisible();
				await expectNoViolations(page);

				await page.goto('/help/glossary');
				await expect(page.getByRole('heading', { level: 1, name: 'Glossary' })).toBeVisible();
				await expectNoViolations(page);

				await page.goto('/help/search?q=dam');
				await expect(page.getByRole('heading', { level: 1, name: 'Search help' })).toBeVisible();
				await expect(page.getByRole('region', { name: 'Guides' })).toBeVisible();
				await expectNoViolations(page);

				// A guide with every block type and two diagrams.
				await page.goto('/help/guides/how-calibration-works');
				await expect(page.getByRole('heading', { level: 1, name: 'How calibration works' })).toBeVisible();
				await expectNoViolations(page);
			});

			test('an invitation opened while signed in has no violations', async ({ page, owner, signIn }) => {
				void owner;
				const project = await createProject(page.request, 'A11y invite');
				const email = uniqueEmail('a11y-invitee');
				const res = await page.request.post(`${API_URL}/projects/${project.id}/members`, { data: { email, role: 'viewer' } });
				expect(res.status()).toBe(201);
				const token = await plantInviteToken(email);
				const other = await signIn('A11y other account');
				await other.page.goto(`/register?invite=${token}`);
				await expect(other.page.getByRole('heading', { level: 1, name: 'You’re already signed in' })).toBeVisible();
				await expect(other.page.getByRole('alert')).toBeVisible();
				await expectNoViolations(other.page);
			});
		});
	});
}

// Phone width: the one-node default, stacked layouts, and 24 px targets.
test.describe('phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('the login page has no violations', async ({ page }) => {
		await page.goto('/login');
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		await expectNoViolations(page);
	});

	test('help, with its contents open, and a guide with diagrams have no violations', async ({ page, owner }) => {
		void owner;
		await page.goto('/help');
		await page.getByRole('button', { name: 'Help contents' }).click();
		await expect(page.getByRole('navigation', { name: 'Help' })).toBeVisible();
		await expectNoViolations(page);

		await page.goto('/help/guides/how-the-model-works');
		await expect(page.getByRole('img', { name: /runoff model, GR4J or legacy/ })).toBeVisible();
		await expectNoViolations(page);
	});

	test('a box that scrolls sideways takes focus and scrolls with the arrow keys', async ({ page, owner }) => {
		void owner;
		const project = await seedRunnableProject(page.request, 'A11y phone scroll');
		await page.goto(`/projects/${project.id}?tab=network`);
		const drawing = page.getByRole('group', { name: 'Schematic drawing' });
		await drawing.focus();
		await expect(drawing).toBeFocused();
		await page.keyboard.press('ArrowRight');
		await expect.poll(() => drawing.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);

		// Wide enough to show it all: no extra tab stop.
		await page.setViewportSize({ width: 1280, height: 800 });
		await expect(page.getByRole('group', { name: 'Schematic drawing' })).toHaveCount(0);
		await expect(page.locator('[data-scroll-region]')).not.toHaveAttribute('tabindex');
	});

	for (const t of TABS) {
		test(`the ${t.id} tab has no violations on a phone`, async ({ page, owner }) => {
			void owner;
			const project = await seedRunnableProject(page.request, `A11y phone ${t.id}`);
			await createRun(page.request, project.id, 'Baseline');
			await page.goto(`/projects/${project.id}?tab=${t.id}`);
			await t.ready(page);
			await expectNoViolations(page);
		});
	}
});
