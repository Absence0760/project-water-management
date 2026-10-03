// Automated WCAG 2.2 A/AA scan (axe-core) of every page, every workspace tab
// and the main dialogs and states, in both themes, plus the phone layout.
// axe finds a subset of problems (keyboard and screen-reader checks still
// need a person), but anything it does flag must stay fixed: fix it at the
// source, never by disabling a rule here.
import type { Page } from '@playwright/test';
import { expectNoViolations, violations } from '../support/a11y.ts';
import { addMember, createProject, createRun, seedRunnableProject, uniqueEmail, updateSettings } from '../support/api.ts';
import { plantInviteToken } from '../support/db.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { closeModal, openNodeForm } from '../support/network.ts';

const DEAD_TOKEN = 'q'.repeat(43);

// Two of axe's best-practice rules the WCAG tags leave out, held to anyway on
// the workspace: an empty table header is an unnamed column to a screen
// reader, and two landmarks with one name can't be told apart.
const BEST_PRACTICE = { rules: ['empty-table-header', 'landmark-unique'] };

// Each tab waits for the content axe should see, not just the tab shell.
const TABS: { id: string; ready: (page: Page) => Promise<void> }[] = [
	// The first screen with its reserve strip, and the alerts and published baseline below it (issue #17, #162).
	{
		id: 'overview',
		ready: async (p) => {
			await expect(p.getByRole('region', { name: 'Days below the reserve' }).getByRole('listitem').first()).toBeVisible();
			await expect(p.getByRole('region', { name: 'Supply by hydrological unit' })).toBeVisible();
			await expect(p.getByRole('region', { name: 'Active alerts' })).toHaveAttribute('data-ready', 'true');
			await expect(p.getByRole('region', { name: 'Published baseline' })).toHaveAttribute('aria-busy', 'false');
		}
	},
	{ id: 'network', ready: (p) => expect(p.getByRole('list', { name: 'Drainage tree' })).toBeVisible() },
	{ id: 'crops', ready: (p) => expect(p.getByRole('heading', { name: 'Planted area by hydrological unit' })).toBeVisible() },
	{ id: 'transfers', ready: (p) => expect(p.getByLabel('From, transfer 1', { exact: true })).toBeVisible() },
	{ id: 'settings', ready: (p) => expect(p.getByRole('heading', { name: 'Flow calibration' })).toBeVisible() },
	{ id: 'series', ready: (p) => expect(p.getByRole('button', { name: 'View', exact: true })).toHaveCount(2) },
	{
		id: 'runs',
		ready: async (p) => {
			await expect(p.getByRole('region', { name: 'Run summary' })).toBeVisible();
			await expect(p.getByRole('img', { name: /line chart/ }).first().locator('canvas')).toBeVisible();
		}
	},
	// The unit cards, the picked unit's chart drawn, and the three tables below (issue #17).
	{
		id: 'supply',
		ready: async (p) => {
			await expect(p.getByRole('region', { name: /^Hydrological unit detail: / }).locator('figure.chart')).toHaveAttribute('data-ready', 'true');
			await expect(p.getByRole('region', { name: 'Hydrological unit results' }).getByRole('rowheader', { name: 'All hydrological units' })).toBeVisible();
			await expect(p.locator('#res-curtailment').getByTestId('curtailment-period')).toBeVisible();
		}
	},
	// The two farm dams' cards with their days at the minimum, and the picked one's storage chart drawn.
	{
		id: 'dams',
		ready: async (p) => {
			await expect(p.getByRole('region', { name: /^Storage: / }).locator('figure.chart')).toHaveAttribute('data-ready', 'true');
			await expect(p.getByRole('list', { name: 'Dams' }).getByTestId('dam-days-at-min')).toHaveCount(2);
		}
	},
	// One seeded run, so the tab says there is nothing to compare yet.
	{ id: 'compare', ready: (p) => expect(p.getByRole('heading', { name: 'Only one run so far' })).toBeVisible() },
	// Nothing made yet on these three: their empty states, once their lists have loaded.
	{ id: 'scenarios', ready: (p) => expect(p.getByTestId('scenarios-empty')).toBeVisible() },
	{ id: 'allocations', ready: (p) => expect(p.getByTestId('allocations-empty')).toBeVisible() },
	// The model's facts, details and who has access, moved from the Summary (issue #17).
	// (The Email column folds into the name cell on a phone, so wait on a member row.)
	{
		id: 'project',
		ready: async (p) => {
			await expect(p.getByRole('region', { name: 'Members' }).getByRole('rowheader').first()).toBeVisible();
			await expect(p.getByRole('region', { name: 'Recent notes' })).toHaveAttribute('data-notes-ready', 'true');
		}
	},
	{ id: 'applications', ready: (p) => expect(p.getByTestId('applications-empty')).toBeVisible() },
	{ id: 'history', ready: (p) => expect(p.getByTestId('history-entry').first()).toBeVisible() }
];

// The positive control: the fast scan (legacy mode, violation details only,
// support/a11y.ts) still reports what it should, a missing alt text and faint
// text among them, still keeps to the WCAG tags, and refuses a page with a
// frame, which it would not scan.
test('the scan reports violations it is shown, and refuses a page with a frame', async ({ page }) => {
	await page.goto('/login');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	expect(await violations(page)).toEqual([]);
	await page.evaluate(() => {
		const main = document.querySelector('main') ?? document.body;
		main.insertAdjacentHTML('beforeend', '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40"><p style="color:#ccc;background:#fff">Faint text</p>');
	});
	// An empty table header breaks only axe's best-practice rule (empty-table-header),
	// which the WCAG tags leave out.
	await page.evaluate(() => {
		const main = document.querySelector('main') ?? document.body;
		main.insertAdjacentHTML('beforeend', '<table><tr><th></th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>');
	});
	const ids = (await violations(page)).map((v) => v.id);
	expect(ids).toEqual(expect.arrayContaining(['image-alt', 'color-contrast']));
	expect(ids).not.toContain('empty-table-header');
	await page.evaluate(() => document.body.append(document.createElement('iframe')));
	await expect.poll(() => page.frames().length).toBe(2);
	await expect(violations(page)).rejects.toThrow(/has a frame/);
});

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
					await expectNoViolations(page, BEST_PRACTICE);
				});
			}

			test('the model save bar and validation messages have no violations', async ({ page, owner }) => {
				void owner;
				const project = await seedRunnableProject(page.request, 'A11y save bar');
				await page.goto(`/projects/${project.id}?tab=network&grid=nodes`);
				await page.getByLabel('Lower farm drains into').selectOption({ label: '— Outlet (none) —' });
				await expect(page.getByRole('dialog', { name: 'Node table' }).getByText('Fix before saving:')).toBeVisible();
				await expectNoViolations(page);
			});

			test('the one-node form and the Add data dialog have no violations', async ({ page, owner }) => {
				void owner;
				const project = await seedRunnableProject(page.request, 'A11y one node');
				await page.goto(`/projects/${project.id}?tab=network`);
				await openNodeForm(page);
				await page.getByLabel('Node to edit').selectOption({ label: '2. Upper farm · hydrological unit' });
				await expect(page.getByLabel('Capacity (m³)')).toHaveValue('150\u202f000');
				await expectNoViolations(page);
				await closeModal(page);

				await page.getByRole('button', { name: 'Add data' }).click();
				await expect(page.getByRole('dialog', { name: 'Add data' })).toBeVisible();
				await expectNoViolations(page);
			});

			// One tab per test, like TABS above: each scan gets its own budget.
			for (const t of TABS.filter((x) => ['overview', 'project', 'network', 'runs'].includes(x.id))) {
				test(`the view-only ${t.id} tab has no violations`, async ({ page, owner, signIn }) => {
					void owner;
					const project = await seedRunnableProject(page.request, `A11y view only ${t.id}`);
					await createRun(page.request, project.id, 'Baseline');
					const viewer = await signIn('A11y viewer');
					await addMember(page.request, project.id, viewer.user.email, 'viewer');
					await viewer.page.goto(`/projects/${project.id}?tab=${t.id}`);
					await t.ready(viewer.page);
					await expect(viewer.page.getByText('View only', { exact: false }).first()).toBeVisible();
					await expectNoViolations(viewer.page);
				});
			}

			const GR4J = { runoffModel: 'gr4j', gr4j: { x1: 350, x2: -0.5, x3: 90, x4: 1.7, warmupDays: 365 } };

			test('GR4J settings have no violations', async ({ page, owner }) => {
				void owner;
				const project = await seedRunnableProject(page.request, 'A11y GR4J settings');
				await updateSettings(page.request, project.id, GR4J);
				await page.goto(`/projects/${project.id}?tab=settings`);
				await expect(page.getByLabel(/^Groundwater exchange X2/)).toHaveValue('-0.5');
				await expectNoViolations(page);
			});

			// GR4J's PE as a monthly row with its source (issue #39), in place of the pan coefficient.
			test('GR4J settings with a monthly PE have no violations', async ({ page, owner }) => {
				void owner;
				const project = await seedRunnableProject(page.request, 'A11y GR4J monthly PE');
				await updateSettings(page.request, project.id, { ...GR4J, pe: { kind: 'monthly', mm: new Array(12).fill(90), source: 'Synthetic station ET₀' } });
				await page.goto(`/projects/${project.id}?tab=settings`);
				await expect(page.getByLabel('Monthly PE, Oct, mm')).toHaveValue('90');
				await expectNoViolations(page);
			});

			test('a GR4J run has no violations', async ({ page, owner }) => {
				void owner;
				const project = await seedRunnableProject(page.request, 'A11y GR4J run');
				await updateSettings(page.request, project.id, GR4J);
				await createRun(page.request, project.id, 'GR4J');
				await page.goto(`/projects/${project.id}?tab=runs`);
				const runoff = page.getByRole('region', { name: /^Runoff model: GR4J/ });
				await expect(runoff.getByRole('rowheader', { name: /Groundwater exchange/ })).toBeVisible();
				await expect(runoff.getByRole('img', { name: /^Model stores/ }).locator('canvas')).toBeVisible();
				await expectNoViolations(page);
				await expectNoViolations(page, BEST_PRACTICE);
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

			// One page per test, so each scan has the test budget to itself (the
			// glossary alone is ~3,000 elements).
			test('the teams list has no violations', async ({ page, owner }) => {
				void owner;
				await page.goto('/teams');
				await expect(page.getByRole('heading', { level: 1, name: 'Teams' })).toBeVisible();
				await expectNoViolations(page);
			});

			test('a team page has no violations', async ({ page, owner }) => {
				void owner;
				const res = await page.request.post(`${API_URL}/teams`, { data: { name: 'A11y team' } });
				expect(res.status()).toBe(201);
				const { team } = (await res.json()) as { team: { id: string } };
				await page.goto(`/teams/${team.id}`);
				await expect(page.getByRole('heading', { level: 1, name: 'A11y team' })).toBeVisible();
				await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
				await expectNoViolations(page);
			});

			const HELP_PAGES: { path: string; ready: (page: Page) => Promise<void> }[] = [
				{
					path: '/help',
					ready: async (p) => {
						await expect(p.getByRole('heading', { level: 1, name: 'How the catchment model works' })).toBeVisible();
						await expect(p.getByRole('img', { name: /An illustrated catchment/ })).toBeVisible();
					}
				},
				{ path: '/help/glossary', ready: (p) => expect(p.getByRole('heading', { level: 1, name: 'Glossary' })).toBeVisible() },
				{
					path: '/help/search?q=dam',
					ready: async (p) => {
						await expect(p.getByRole('heading', { level: 1, name: 'Search help' })).toBeVisible();
						await expect(p.getByRole('region', { name: 'Guides' })).toBeVisible();
					}
				},
				// A guide with every block type and two diagrams.
				{
					path: '/help/guides/how-calibration-works',
					ready: (p) => expect(p.getByRole('heading', { level: 1, name: 'How calibration works' })).toBeVisible()
				}
			];
			for (const h of HELP_PAGES) {
				test(`help page ${h.path} has no violations`, async ({ page, owner }) => {
					void owner;
					await page.goto(h.path);
					await h.ready(page);
					await expectNoViolations(page);
				});
			}

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

	test('the empty project list, with its example block stacked, has no violations', async ({ page, owner }) => {
		void owner;
		await page.goto('/');
		await expect(page.getByRole('button', { name: 'Start from an example' })).toBeVisible();
		await expectNoViolations(page);
	});

	test('help, with its contents open, and a guide with diagrams have no violations', async ({ page, owner }) => {
		void owner;
		await page.goto('/help');
		await page.getByRole('button', { name: 'Help contents' }).click();
		await expect(page.getByRole('navigation', { name: 'Help' })).toBeVisible();
		await expectNoViolations(page);

		await page.goto('/help/guides/how-the-model-works');
		await expect(page.getByRole('img', { name: /runoff model, GR4J, which makes/ })).toBeVisible();
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
			await expectNoViolations(page, BEST_PRACTICE);
		});
	}
});
