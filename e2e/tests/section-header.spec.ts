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
import { openRiver, seedRiverProject } from '../support/river.ts';

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
		await expect(h.getByTestId('network-summary')).toContainText(/\d+ hydrological units? · \d+ dams? · \d+ gauges?/);
		await expect(h.locator('details.grids-menu summary')).toHaveText(/Grids/);
		const actions = h.getByRole('button');
		await expect(actions).toHaveText(['+ Add node', 'Add data', 'Run model']);
		await expectNoViolations(page);

		// Crops: its summary line and Add crop.
		await nav(page).getByRole('link', { name: 'Crops & demand' }).click();
		await expect(h.getByRole('heading', { level: 1, name: 'Crops & demand' })).toBeVisible();
		await expect(h.getByTestId('crops-summary')).toContainText(/crops? · /);
		await expect(actions).toHaveText(['+ Add crop', 'Add data', 'Run model']);

		// Data: Add data is the section's main action, after the tab's Preview all data; no Run model here. The context counts the series.
		await nav(page).getByRole('link', { name: /^Data/ }).click();
		await expect(h.getByRole('heading', { level: 1, name: 'Data' })).toBeVisible();
		await expect(h.getByTestId('section-context')).toHaveText('2 input series · 1 behind');
		await expect(actions).toHaveText(['Preview all data', 'Add data']);
		await expect(h.getByRole('button', { name: 'Add data' })).toHaveClass(/btn-primary/);

		// Runs: the tab's own run form (with a label) takes Run model's place, last in the header, after a plain Add data.
		await nav(page).getByRole('link', { name: 'Runs & results' }).click();
		await expect(h.getByRole('heading', { level: 1, name: 'Runs & results' })).toBeVisible();
		await expect(actions).toHaveText(['Add data', 'Run model']);
		await expect(h.getByRole('button', { name: 'Add data' })).not.toHaveClass(/btn-primary/);
		await expect(h.getByLabel(/^Run label/)).toBeVisible();
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

/**
 * How the header lays out its context line: how many lines the context's text
 * takes, and whether the controls sit beside the title (on its row) or under it.
 */
async function contextLayout(page: Page) {
	return header(page).evaluate((h) => {
		const ctx = h.querySelector('[data-testid="section-context"]')!;
		const mids: number[] = [];
		const walker = document.createTreeWalker(ctx, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			if (!n.textContent?.trim()) continue;
			const range = document.createRange();
			range.selectNodeContents(n);
			for (const r of range.getClientRects()) if (r.width > 0) mids.push(r.top + r.height / 2);
		}
		mids.sort((a, b) => a - b);
		let lines = 0;
		let last = -Infinity;
		for (const m of mids) {
			if (m - last <= 8) continue;
			lines++;
			last = m;
		}
		const title = h.querySelector('.title')!.getBoundingClientRect();
		const actions = h.querySelector('.actions')!.getBoundingClientRect();
		return { lines, beside: actions.top < title.bottom - 2 };
	});
}

test.describe('a long context line', () => {
	// The title column used to shrink to 16rem whatever its context, so with the controls
	// beside it a long context wrapped to 3 or 4 short lines (River & reserve for a viewer
	// at 1440, Compare runs at 1024). The controls now go under the title once the context
	// would wrap; a context that fits on one line keeps the controls beside it.
	const WIDTHS = [
		{ width: 1440, height: 960 },
		{ width: 1280, height: 800 },
		{ width: 1024, height: 768 }
	];

	test('River & reserve for a viewer: the context takes at most 2 lines, 1 beside the controls', async ({ page, owner, signIn }) => {
		void owner;
		const id = await seedRiverProject(page.request, 'Header long river');
		await createRun(page.request, id, 'Earlier run');
		await createRun(page.request, id, 'Baseline with the upper dam at its present level');
		const viewer = await signIn('Header long river viewer');
		await addMember(page.request, id, viewer.user.email, 'viewer');
		const v = viewer.page;
		for (const size of WIDTHS) {
			await v.setViewportSize(size);
			await openRiver(v, id);
			await expect(header(v).getByTestId('river-context')).toContainText('Baseline with the upper dam at its present level');
			// The run picker and Open in Runs & results make the controls wide.
			await expect(header(v).getByRole('combobox')).toBeVisible();
			await expect(header(v).getByRole('link', { name: 'Open in Runs & results' })).toBeVisible();
			const layout = await contextLayout(v);
			expect(layout.lines, `${size.width} px`).toBeLessThanOrEqual(2);
			if (layout.beside) expect(layout.lines, `${size.width} px, beside the controls`).toBe(1);
			expect(await noSideScroll(v)).toBe(true);
			await expectNoViolations(v);
		}
		// 1440: the controls no longer fit beside this context on one line, so they sit under the title.
		await v.setViewportSize(WIDTHS[0]!);
		await openRiver(v, id);
		expect(await contextLayout(v)).toEqual({ lines: 1, beside: false });
	});

	test('Compare runs: the context takes at most 2 lines, 1 beside the controls; a short context keeps them beside', async ({ page, owner }) => {
		void owner;
		const project = await seedRunnableProject(page.request, 'Header long compare');
		await createRun(page.request, project.id, 'Baseline with the upper dam at its present level');
		await createRun(page.request, project.id, 'What-if with the upper dam raised by two metres');
		for (const size of WIDTHS) {
			await page.setViewportSize(size);
			await page.goto(`/projects/${project.id}?tab=compare`);
			await expect(header(page).getByTestId('compare-context')).toContainText('against one what-if');
			await expect(page.getByRole('heading', { level: 2, name: 'Headline results' })).toBeVisible();
			const layout = await contextLayout(page);
			expect(layout.lines, `${size.width} px`).toBeLessThanOrEqual(2);
			if (layout.beside) expect(layout.lines, `${size.width} px, beside the controls`).toBe(1);
			expect(await noSideScroll(page)).toBe(true);
			await expectNoViolations(page);

			// Data's short context ("2 input series · 1 behind") keeps its controls beside it, as before.
			await nav(page).getByRole('link', { name: /^Data/ }).click();
			await expect(header(page).getByTestId('section-context')).toHaveText('2 input series · 1 behind');
			expect(await contextLayout(page), `Data at ${size.width} px`).toEqual({ lines: 1, beside: true });
		}
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
