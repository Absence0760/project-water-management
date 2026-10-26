// Old links to the panels that moved to the Calibration page (issue #586 round 3; nav/anchorMoves.ts): a
// `?tab=settings#set-fit` or a `?tab=runs&run=…#res-calibration` written before the move (an email, a bookmark,
// a note) is sent on to `?tab=calibration` with a replace navigation, keeping what the link carried (every
// parameter from Settings; the run from Runs & results), and lands there on the panel's heading, focused, so Back
// returns to where the link was followed from. And the reverse: an old `?tab=calibration#set-ewr` (from when that
// tab opened Settings) goes on to Model settings, while the fit's panels stay. The layout pins for each page are
// settings-layout-pins.spec.ts and runs-layout-pins.spec.ts. Synthetic data only.
import type { Page } from '@playwright/test';
import { createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

test.use({ viewport: { width: 1280, height: 800 } });

const title = (page: Page) => page.getByRole('heading', { level: 1, name: 'Calibration', exact: true });
/** A panel's heading, whether the anchor is on the heading itself or on the panel around it. */
const anchoredHeading = (page: Page, id: string) => page.locator(`:is(h2, h3, h4)#${id}, #${id} :is(h2, h3, h4)`).first();

/** Opens the Summary, then `path` as a fresh load: an old link opened from outside. */
async function openOld(page: Page, projectId: string, path: string) {
	await page.goto(`/projects/${projectId}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Summary', exact: true })).toBeVisible();
	await page.goto(`/projects/${projectId}${path}`);
}

async function expectLanded(page: Page, id: string, heading: string | RegExp) {
	const h = anchoredHeading(page, id);
	await expect(h, id).toHaveText(heading, { useInnerText: true });
	await expect(h, id).toBeInViewport();
	await expect(h, id).toBeFocused();
}

/** Back from the forwarded page returns to the Summary: the old address was replaced. */
async function expectBackToSummary(page: Page, projectId: string) {
	await page.goBack();
	await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
	await expect(page.getByRole('heading', { level: 1, name: 'Summary', exact: true })).toBeVisible();
}

test('an old Settings link to a fit panel lands on that panel on Calibration, every parameter kept, Back skipping it', async ({ page, owner }) => {
	void owner;
	test.setTimeout(90_000); // five forwarded loads and their Backs
	const project = await seedRunnableProject(page.request, 'Forward settings to Calibration');
	for (const [id, heading] of [
		['set-fit', 'Fit the parameters'],
		['set-flow', 'Flow calibration'],
		['set-record', 'Calibration record'],
		['set-wr2012', 'WR2012 check'],
		// A lazy card inside Flow calibration: the page waits for it.
		['set-evaporation', 'Evaporation from the map']
	] as const) {
		await openOld(page, project.id, `?tab=settings&ref=mail#${id}`);
		await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=calibration&ref=mail#${id}$`));
		await expect(title(page)).toBeVisible();
		await expectLanded(page, id, heading);
		await expectBackToSummary(page, project.id);
	}
});

test('an old Runs & results link to a Model quality panel lands on it on Calibration, for the same run', async ({ page, owner }) => {
	void owner;
	test.setTimeout(90_000);
	const project = await seedRunnableProject(page.request, 'Forward results to Calibration');
	const older = await createRun(page.request, project.id, 'Older run');
	await createRun(page.request, project.id, 'Newest run');
	for (const [id, heading] of [
		['res-calibration', 'Calibration against observed flow'],
		['res-hydrograph', 'Hydrograph'],
		['res-plausibility', 'Plausibility checks']
	] as const) {
		// The older run, picked: the link names it, and the runs filter (`q=`) is Runs & results' own.
		await openOld(page, project.id, `?tab=runs&run=${older}&q=older#${id}`);
		await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=calibration&run=${older}#${id}$`));
		await expect(title(page)).toBeVisible();
		await expectLanded(page, id, heading);
		await expectBackToSummary(page, project.id);
	}
	// The old `?tab=results` spelling, with no run: Calibration shows its default run.
	await openOld(page, project.id, '?tab=results#res-calibration');
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=calibration#res-calibration$`));
	await expectLanded(page, 'res-calibration', 'Calibration against observed flow');
});

test('a fit panel’s old link followed while Settings is open forwards too; Calibration keeps its own, and sends Model settings’ on', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Forward in page');
	// Only the #fragment changes (a pasted link, a note's link with the page open).
	await page.goto(`/projects/${project.id}?tab=settings`);
	await expect(page.locator('#set-demand')).toBeVisible();
	await page.evaluate(() => (location.hash = '#set-fit'));
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=calibration#set-fit$`));
	await expectLanded(page, 'set-fit', 'Fit the parameters');

	// On Calibration, the fit's anchors land here; one that stayed on Model settings goes there.
	await page.evaluate(() => (location.hash = '#set-record'));
	await expect(page).toHaveURL(new RegExp(`\\?tab=calibration#set-record$`));
	await expectLanded(page, 'set-record', 'Calibration record');
	await page.evaluate(() => (location.hash = '#set-ewr'));
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=settings#set-ewr$`));
	await expectLanded(page, 'set-ewr', 'EWR');
});
