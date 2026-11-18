// Regression guard: repeated full page loads must keep working. Against the
// Vite dev server the fourth load failed every time (hundreds of unbundled
// module requests per load exhausted Chromium: net::ERR_INSUFFICIENT_RESOURCES,
// "Failed to fetch dynamically imported module"), which is why e2e runs against
// a built site (playwright.config.ts). Any failed request or page error fails it.
// So each load waits until the page's own reads have answered before the next
// goto: the Settings tab's unit MAP proposal (its body's data-ready) and the
// project page's idle-time Warnings count and feeds (<main data-warnings-ready>).
// A read still in flight is cancelled by the next load (net::ERR_ABORTED), which
// would fail the test for the test's own navigation rather than for a load that
// broke; since Playwright 1.65's Chromium those reads were often still out.
import { createProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

test('the Settings tab survives six full page loads in a row', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Repeated loads');
	const failed: string[] = [];
	page.on('requestfailed', (r) => failed.push(`${r.failure()?.errorText} ${r.url()}`));
	page.on('pageerror', (e) => failed.push(`pageerror: ${e.message}`));
	for (let i = 1; i <= 6; i++) {
		await test.step(`load ${i}`, async () => {
			await page.goto(`/projects/${project.id}?tab=settings`);
			await expect(page.getByLabel('A-pan evaporation, Oct, mm')).toHaveValue('0');
			await expect(page.getByTestId('unit-map-body')).toHaveAttribute('data-ready', 'true');
			await expect(page.locator('main[data-warnings-ready="true"]')).toBeAttached();
		});
	}
	expect(failed).toEqual([]);
});
