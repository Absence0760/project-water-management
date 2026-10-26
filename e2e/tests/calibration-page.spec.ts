// The Calibration page (?tab=calibration, issue #586 round 2): its own sidebar row, one title, its two parts in the
// side index, and, until round 3 moves the settings panels in, links that land on each panel's heading on Settings.
// How the shown run fits holds Model quality since round 3 (calibration-results.spec.ts), for the run picked. Old ?tab=calibration#set- links go on to Settings
// (settings-layout-pins.spec.ts pins each). The a11y scans at 1440 and 390 are a11y.spec.ts's. Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectAbove, expectNoSidewaysScroll } from '../support/reflow.ts';
import { sectionHeader } from '../support/sectionHeader.ts';

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });
const index = (page: Page) => page.getByRole('navigation', { name: 'Calibration sections' });
const title = (page: Page) => page.getByRole('heading', { level: 1, name: 'Calibration', exact: true });
const part = (page: Page, id: string) => page.locator(`#${id}`).getByRole('heading', { level: 2 });

test.describe('1440×960', () => {
	test.use({ viewport: { width: 1440, height: 960 } });

	test('one title, its two parts in the side index, and links that land on each panel where it is today', async ({ page, owner }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration page');
		await createRun(page.request, p.id, 'Older run');
		const newest = await createRun(page.request, p.id, 'Newest run');
		await page.goto(`/projects/${p.id}?tab=calibration`);
		await expect(title(page)).toBeVisible();
		// One page title: no heading of the page's own repeats it.
		await expect(page.getByRole('heading', { name: 'Calibration', exact: true })).toHaveCount(1);
		await expect(sectionHeader(page).getByTestId('calibration-context')).toHaveText('Fit the runoff parameters to observed flow, then judge the fit');
		await expect(sidebar(page).getByRole('link', { name: 'Calibration', exact: true })).toHaveAttribute('aria-current', 'page');

		// The side index (a rail at 1440) lists the two parts, each by its heading; a click focuses the heading.
		await expect(page.locator('nav.rail-nav[aria-label="Calibration sections"]')).toBeVisible();
		await expect(index(page).getByRole('link')).toHaveText(['Set up the fit', 'How the shown run fits']);
		await index(page).getByRole('link', { name: 'How the shown run fits' }).click();
		await expect(page).toHaveURL(/\?tab=calibration#cal-fit$/);
		await expect(part(page, 'cal-fit')).toBeFocused();

		// Set up the fit: the four panels on Settings, named by their headings, in its order.
		const setup = page.locator('#cal-setup');
		await expect(setup.getByRole('link')).toHaveText(['Flow calibration', 'Calibration record', 'Fit the parameters', 'WR2012 check']);
		// How the shown run fits: the newest run by default, with Model quality for it.
		await expect(page.locator('#cal-fit').getByRole('combobox', { name: 'Run', exact: true }).locator('option:checked')).toHaveText(/^Newest run · /);
		await expect(page.locator('#res-hydrograph').getByRole('heading', { name: 'Hydrograph' })).toBeVisible();

		// A link lands on its panel's heading there, focused, and Back comes home.
		await setup.getByRole('link', { name: 'Fit the parameters' }).click();
		await expect(page).toHaveURL(/\?tab=settings#set-fit$/);
		const fitHeading = page.locator('#set-fit').getByRole('heading', { level: 2 }).first();
		await expect(fitHeading).toBeInViewport();
		await expect(fitHeading).toBeFocused();
		await page.goBack();
		await expect(title(page)).toBeVisible();
	});

	test('the run picked on Runs & results: the sidebar link carries it, and the page shows it', async ({ page, owner }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration run pick');
		const older = await createRun(page.request, p.id, 'Older run');
		await createRun(page.request, p.id, 'Newest run');
		// Pick the older run on Runs & results.
		await page.goto(`/projects/${p.id}?tab=runs&run=${older}`);
		await expect(page.getByRole('heading', { level: 2, name: 'Older run' })).toBeVisible();
		const row = sidebar(page).getByRole('link', { name: 'Calibration', exact: true });
		await expect(row).toHaveAttribute('href', `?tab=calibration&run=${older}`);
		await row.click();
		await expect(title(page)).toBeFocused();
		await expect(page.locator('#cal-fit').getByRole('combobox', { name: 'Run', exact: true }).locator('option:checked')).toHaveText(/^Older run · /);
		await expect(page.getByTestId('calibration-results')).toHaveAttribute('data-run', older);
		// And back: Open in Runs & results keeps it.
		await page.locator('#cal-fit').getByRole('link', { name: 'Open in Runs & results' }).click();
		await expect(page).toHaveURL(new RegExp(`\\?tab=runs&run=${older}$`));
		await expect(page.getByRole('heading', { level: 2, name: 'Older run' })).toBeVisible();
	});

	test('a loaded #cal- link lands on its part; an old #set-feeds link goes on through Settings to Data', async ({ page, owner }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration links');
		await createRun(page.request, p.id, 'Baseline');
		await page.goto(`/projects/${p.id}?tab=overview`);
		await page.goto(`/projects/${p.id}?tab=calibration#cal-fit`);
		await expect(part(page, 'cal-fit')).toBeFocused();
		await expect(part(page, 'cal-fit')).toBeInViewport();

		await page.goto('about:blank');
		await page.goto(`/projects/${p.id}?tab=calibration#set-feeds`);
		await expect(page).toHaveURL(/\?tab=series#data-feeds$/);
		await expect(page.locator('#data-feeds').locator('h2, h3').first()).toBeFocused();
	});

	test('no run yet: the second part says what it will show, and an editor gets Run the model', async ({ page, owner }) => {
		void owner;
		const p = await createProject(page.request, 'Calibration no run');
		await page.goto(`/projects/${p.id}?tab=calibration`);
		await expect(title(page)).toBeVisible();
		const none = page.getByTestId('calibration-no-run');
		await expect(none).toContainText('No run yet. Once the model has run, this shows how its flows fit the observed record');
		await expect(none.getByRole('link', { name: 'Run the model' })).toHaveAttribute('href', '?tab=runs');
		await expect(page.locator('#cal-fit').getByRole('combobox')).toHaveCount(0);
		// The setup links don't need a run.
		await expect(page.locator('#cal-setup').getByRole('link')).toHaveCount(4);
		await expectNoViolations(page);
	});

	test('a viewer: the row without the model inputs, the same links, no editing actions', async ({ page, owner, signIn }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration viewer');
		await createRun(page.request, p.id, 'Baseline');
		const viewer = await signIn('Calibration viewer');
		await addMember(page.request, p.id, viewer.user.email, 'viewer');
		const v = viewer.page;
		await v.setViewportSize({ width: 1440, height: 960 });
		await v.goto(`/projects/${p.id}`);
		await expect(v.getByLabel('Show model inputs')).not.toBeChecked();
		await sidebar(v).getByRole('link', { name: 'Calibration', exact: true }).click();
		await expect(title(v)).toBeFocused();
		// One run: named, with no picker to choose from.
		await expect(v.getByTestId('calibration-run')).toContainText('Run Baseline');
		await expect(v.locator('#cal-fit').getByRole('combobox')).toHaveCount(0);
		await expect(v.locator('#cal-setup').getByRole('link')).toHaveCount(4);
		await expect(sectionHeader(v).getByRole('button', { name: 'Add data' })).toHaveCount(0);
	});
});

test.describe('1280×800', () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test('the index is the bar above the parts; How the shown run fits takes the page’s width, under Set up the fit', async ({ page, owner }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration 1280');
		await createRun(page.request, p.id, 'Baseline');
		await page.goto(`/projects/${p.id}?tab=calibration`);
		await expect(title(page)).toBeVisible();
		await expect(index(page).getByRole('link')).toHaveText(['Set up the fit', 'How the shown run fits']);
		await expect(page.locator('nav.rail-nav')).toHaveCount(0);
		await expectAbove(page.locator('#cal-setup'), page.locator('#cal-fit'));
		const body = (await page.locator('.cal-page').boundingBox())!;
		expect((await page.locator('#cal-fit').boundingBox())!.width).toBeGreaterThan(body.width - 2);
	});
});

test.describe('phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('the parts stack, nothing scrolls sideways, and Sections names the page', async ({ page, owner }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration phone');
		await createRun(page.request, p.id, 'Baseline');
		await page.goto(`/projects/${p.id}?tab=calibration`);
		await expect(title(page)).toBeVisible();
		await expect(page.getByRole('button', { name: /^Project sections: Calibration/ })).toBeVisible();
		await expectAbove(page.locator('#cal-setup'), page.locator('#cal-fit'));
		await expectNoSidewaysScroll(page);
	});
});
