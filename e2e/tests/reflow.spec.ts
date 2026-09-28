// Reflow at 320 CSS px (WCAG 2.2 SC 1.4.10): a catchment tab never scrolls the
// page sideways. Genuinely wide content (a monthly table, the section menu)
// scrolls inside its own box instead. Issue #38. And at 1024 px, a small laptop,
// where the sidebar and the runs rail leave a panel much less than the window.
import { createProject, createRun, putModel, sampleModel } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { seedRiverProject } from '../support/river.ts';

const NARROW = { width: 320, height: 640 };

test.describe('320 px reflow', () => {
	test.use({ viewport: NARROW });

	test('the Settings tab fits the screen, the feeds panel included', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Reflow settings');
		await putModel(page.request, project.id, sampleModel());
		await page.goto(`/projects/${project.id}?tab=settings`);
		await expect(page.getByLabel('A-pan evaporation, Sep, mm')).toBeVisible();
		await expectNoSidewaysScroll(page);
		await expect(page.getByRole('region', { name: 'Data feeds' })).toBeVisible();
		await expectNoSidewaysScroll(page);

		// The zero-rain period lists with a water-year row and a date-range row.
		const zeroRain = page.getByTestId('zero-rain-settings');
		await zeroRain.getByRole('button', { name: 'Add a water year' }).first().click();
		await zeroRain.getByRole('button', { name: 'Add a date range' }).first().click();
		await expect(zeroRain.getByRole('button', { name: /^Remove / })).toHaveCount(2);
		await expectNoSidewaysScroll(page);
	});

	for (const tab of ['overview', 'network', 'crops', 'transfers', 'series', 'runs']) {
		test(`the ${tab} tab fits the screen`, async ({ page, owner }) => {
			void owner;
			const project = await createProject(page.request, `Reflow ${tab}`);
			await putModel(page.request, project.id, sampleModel());
			await page.goto(`/projects/${project.id}?tab=${tab}`);
			await expect(page.locator(`#tab-${tab}`)).toHaveAttribute('aria-current', 'page');
			await expectNoSidewaysScroll(page);
		});
	}
});

// A small laptop, 1024 px wide: the app sidebar takes its 240 px and Runs & results its rail, so a panel
// laid out by the viewport's width (not its own) is the first to overflow. Runs' runoff panel did, by 20 px.
test('every tab fits a 1024 px window with a five-year run', async ({ page, owner }) => {
	test.setTimeout(90_000);
	void owner;
	await page.setViewportSize({ width: 1024, height: 768 });
	const id = await seedRiverProject(page.request, 'Reflow 1024', 1827);
	await createRun(page.request, id, 'Five years');
	for (const tab of ['overview', 'network', 'crops', 'transfers', 'series', 'settings', 'runs', 'river', 'supply', 'dams', 'compare', 'scenarios', 'allocations', 'project', 'history']) {
		await page.goto(`/projects/${id}?tab=${tab}`);
		await expect(page.locator(`#tab-${tab}`)).toHaveAttribute('aria-current', 'page');
		if (tab === 'runs') await expect(page.getByRole('region', { name: /^Runoff model: GR4J/ }).locator('figure.chart')).toHaveAttribute('data-ready', 'true');
		await expectNoSidewaysScroll(page);
	}
});
