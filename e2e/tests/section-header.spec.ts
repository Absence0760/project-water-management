// One header per workspace section (issue #17, option A; docs/ui.md §
// Section header): the section's title, a one-line context, and on the right
// the rain-freshness pill, the section's own actions, Add data and Run model.
// The notices (view only, new data) are one slim line under it; the
// project's name and your role are at the top of the sidebar (a compact line
// on a phone); Data carries a badge counting the series behind. Synthetic
// data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, createRun, putModel, putSeries, sampleModel, seedRunnableProject, syntheticRain } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { closeModal } from '../support/network.ts';

const header = (page: Page) => page.getByTestId('section-header');
const nav = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test.describe('desktop', () => {
	test.use({ viewport: { width: 1440, height: 960 } });

	test('each section has one header: title, context and its actions', async ({ page, owner }) => {
		void owner;
		const project = await seedRunnableProject(page.request, 'Header sections');
		await page.goto(`/projects/${project.id}`);

		// The project's name and role sit at the top of the sidebar, not in a row above the page.
		await expect(page.getByTestId('project-name')).toHaveText('Header sections');
		await expect(page.getByTestId('project-role')).toHaveText('owner');
		await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

		// Summary: no run yet, so the context says so; the freshness pill, Add data and Run model on the right.
		const h = header(page);
		await expect(h.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible();
		await expect(h.getByTestId('section-context')).toHaveText('No runs yet');
		await expect(h.locator('summary', { hasText: 'Rain up to' })).toBeVisible();
		await expect(h.getByRole('button', { name: 'Add data' })).toBeVisible();
		await expect(h.getByRole('button', { name: 'Run model' })).toBeEnabled();
		// The title and the actions share one row.
		const title = (await h.getByRole('heading', { level: 1 }).boundingBox())!;
		const run = (await h.getByRole('button', { name: 'Run model' }).boundingBox())!;
		expect(run.y).toBeLessThan(title.y + title.height + 30);
		expect(run.x).toBeGreaterThan(title.x + title.width);
		await expectNoViolations(page);

		// Network: its summary, Grids and Add node come from the tab, before Add data and Run model.
		await nav(page).getByRole('link', { name: 'Network' }).click();
		await expect(h.getByRole('heading', { level: 1, name: 'Network' })).toBeVisible();
		await expect(h.getByTestId('network-summary')).toContainText(/\d+ farms? · \d+ dams? · \d+ gauges?/);
		await expect(h.locator('details.grids-menu summary')).toHaveText(/Grids/);
		const actions = h.getByRole('button');
		await expect(actions).toHaveText(['+ Add node', 'Add data', 'Run model']);
		await expectNoViolations(page);

		// Crops: its summary line and Add crop.
		await nav(page).getByRole('link', { name: 'Crops & demand' }).click();
		await expect(h.getByRole('heading', { level: 1, name: 'Crops & demand' })).toBeVisible();
		await expect(h.getByTestId('crops-summary')).toContainText(/crops? · /);
		await expect(actions).toHaveText(['+ Add crop', 'Add data', 'Run model']);

		// Data: Add data is the section's main action; no Run model here. The context counts the series.
		await nav(page).getByRole('link', { name: /^Data/ }).click();
		await expect(h.getByRole('heading', { level: 1, name: 'Data' })).toBeVisible();
		await expect(h.getByTestId('section-context')).toHaveText('2 input series · 1 behind');
		await expect(actions).toHaveText(['Add data']);
		await expect(h.getByRole('button', { name: 'Add data' })).toHaveClass(/btn-primary/);

		// Runs: the tab's own form runs the model (with a label), so the header doesn't repeat it.
		await nav(page).getByRole('link', { name: 'Runs & results' }).click();
		await expect(h.getByRole('heading', { level: 1, name: 'Runs & results' })).toBeVisible();
		await expect(h.getByRole('button', { name: 'Run model' })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Run model' })).toHaveCount(1);
	});

	test('Run model in the header starts a run and opens it; the Summary then names it', async ({ page, owner }) => {
		void owner;
		const project = await seedRunnableProject(page.request, 'Header run');
		await page.goto(`/projects/${project.id}?tab=network`);
		await header(page).getByRole('button', { name: 'Run model' }).click();
		await expect(page).toHaveURL(/[?&]tab=runs&run=[\w-]+$/);
		await expect(page.getByRole('heading', { level: 2, name: 'Untitled run' })).toBeVisible();

		await nav(page).getByRole('link', { name: 'Summary' }).click();
		const context = header(page).getByTestId('section-context');
		await expect(context).toContainText('Untitled run');
		await expect(context).toContainText(/engine \d+\.\d+\.\d+ · ran today/);
		await expect(context.getByRole('link', { name: 'Open in Runs' })).toBeVisible();
	});

	test('Run model waits for rain, and says why', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Header run needs');
		await putModel(page.request, project.id, sampleModel());
		await page.goto(`/projects/${project.id}`);
		const run = header(page).getByRole('button', { name: 'Run model' });
		await expect(run).toBeDisabled();
		await expect(run).toHaveAccessibleDescription('A run needs a rainfall series first.');
	});

	test('Data carries a badge counting the series behind, in its accessible name', async ({ page, owner }) => {
		void owner;
		const project = await seedRunnableProject(page.request, 'Header data badge');
		// A second recorded-rain series, also long past; a forecast never counts.
		await putSeries(page.request, project.id, { kind: 'rain_chirps_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(30) });
		await putSeries(page.request, project.id, { kind: 'rain_forecast_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(10) });
		await page.goto(`/projects/${project.id}`);
		const data = nav(page).getByRole('link', { name: /^Data/ });
		await expect(data).toHaveAccessibleName('Data (2 series behind)');
		await expect(data.locator('.count-badge [aria-hidden="true"]')).toHaveText('2');
	});

	test('new data since the last run is one slim line with Re-run model', async ({ page, owner }) => {
		void owner;
		const project = await seedRunnableProject(page.request, 'Header new data');
		await createRun(page.request, project.id, 'Baseline');
		// The rain now reaches past the run.
		await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(140) });
		await page.goto(`/projects/${project.id}`);
		const line = header(page).getByTestId('notice-line');
		await expect(line.getByRole('status')).toContainText('New data since the last run (Rainfall — catchment).');
		// One line: the notice is no taller than a button plus its padding.
		expect((await line.boundingBox())!.height).toBeLessThan(60);
		await line.getByRole('button', { name: 'Re-run model' }).click();
		await expect(page).toHaveURL(/[?&]tab=runs&run=[\w-]+$/);
		await expect(page.getByRole('heading', { level: 2, name: /^Data to 2022-02-17$/ })).toBeVisible();
	});

	test('a viewer: the view-only notice in the header line, no Add data or Run model, the role in the sidebar', async ({ page, owner, signIn }) => {
		void owner;
		const project = await seedRunnableProject(page.request, 'Header viewer');
		const viewer = await signIn('Header viewer');
		await addMember(page.request, project.id, viewer.user.email, 'viewer');
		const v = viewer.page;
		await v.setViewportSize({ width: 1440, height: 960 });
		await v.goto(`/projects/${project.id}`);
		await expect(v.getByTestId('project-role')).toHaveText('viewer');
		const line = header(v).getByTestId('notice-line');
		await expect(line.getByRole('note')).toContainText('View only. You have view-only access to this project.');
		await expect(header(v).getByRole('button', { name: 'Add data' })).toHaveCount(0);
		await expect(header(v).getByRole('button', { name: 'Run model' })).toHaveCount(0);
		await expect(header(v).locator('summary', { hasText: 'Rain up to' })).toBeVisible();
		await expectNoViolations(v);
	});

	test('unsaved changes show beside the title; the save bar keeps Save and Discard', async ({ page, owner }) => {
		void owner;
		const project = await seedRunnableProject(page.request, 'Header unsaved');
		await page.goto(`/projects/${project.id}?tab=network`);
		await header(page).getByRole('button', { name: '+ Add node' }).click();
		await closeModal(page);
		await expect(header(page).getByText('Unsaved changes', { exact: true })).toBeVisible();
		const bar = page.getByRole('region', { name: 'Unsaved model changes' });
		await expect(bar.getByRole('button', { name: 'Save changes' })).toBeVisible();
		await bar.getByRole('button', { name: 'Discard' }).click();
		await expect(header(page).getByText('Unsaved changes', { exact: true })).toHaveCount(0);
	});
});

test.describe('phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('the header stacks: a compact project line, Sections, then the title, context and actions', async ({ page, owner }) => {
		void owner;
		const project = await seedRunnableProject(page.request, 'Header phone');
		await page.goto(`/projects/${project.id}?tab=network`);
		await expect(page.getByTestId('project-name')).toHaveText('Header phone');
		await expect(page.getByTestId('project-role')).toHaveText('owner');
		const h = header(page);
		await expect(h.getByRole('heading', { level: 1, name: 'Network' })).toBeVisible();
		await expect(h.getByTestId('network-summary')).toBeVisible();
		await expect(h.getByRole('button', { name: 'Run model' })).toBeVisible();
		await expect(h.getByRole('button', { name: 'Add data' })).toBeVisible();
		const toggle = (await page.getByRole('button', { name: /^Project sections:/ }).boundingBox())!;
		const title = (await h.getByRole('heading', { level: 1 }).boundingBox())!;
		expect(title.y).toBeGreaterThan(toggle.y);
		expect(await noSideScroll(page)).toBe(true);
		await expectNoViolations(page);

		await page.goto(`/projects/${project.id}`);
		await expect(h.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible();
		expect(await noSideScroll(page)).toBe(true);
		await expectNoViolations(page);
	});
});
