// How the shown run fits on the Calibration page (issue #586 Round 3, docs/ui.md
// § Calibration): Model quality for the run `?run=` names, moved here from Runs
// & results. Pins its panels in page order, every #res-* anchor landing on its
// panel's heading once the run shows, the line for a panel the run doesn't
// have, the run picker (the default, a pick is a step Back and Forward retrace),
// and the Summary's model checks linking here. runs-layout-pins.spec.ts pins
// what stayed on Runs & results. Names and numbers are invented.
import type { Page } from '@playwright/test';
import { createRun, seedRunnableProject } from '../support/api.ts';
import { seedEveryPanel } from '../support/everyPanel.ts';
import { expect, test } from '../support/fixtures.ts';
import { calibrationRunPicker, openCalibration } from '../support/runs.ts';

const VIEW = { width: 1440, height: 960 };

/** Model quality's #res-* panels in DOM order: `id: its first heading`. */
const panelOrder = (page: Page) =>
	page.evaluate(() => [...document.querySelectorAll('#cal-fit [id^="res-"]:not(h2, h3, h4)')].map((el) => `${el.id}: ${el.querySelector('h2, h3, h4')?.textContent?.trim() ?? ''}`));

const PANELS: [string, string][] = [
	['res-hydrograph', 'Hydrograph'],
	['res-fdc', 'Flow-duration curve'],
	['res-gauges', 'Flow at gauges in the network (checks only)'],
	['res-calibration', 'Calibration against observed flow'],
	['res-runoff', 'Runoff model: GR4J'],
	['res-unit-rain', 'Rain for each unit'],
	['res-wr2012', 'WR2012 check: Z99A'],
	['res-ewr-agreement', 'EWR test: model against observed flow'],
	['res-plausibility', 'Plausibility checks']
];

test.use({ viewport: VIEW });

test('a run with every optional panel: Model quality’s panels in page order, each anchor landing on its heading, focused', async ({ page, owner }) => {
	void owner;
	test.setTimeout(120_000); // ten fresh page loads
	const { id, runId } = await seedEveryPanel(page.request, 'Calibration every panel');
	await openCalibration(page, id, `&run=${runId}`);
	await expect(page.locator('#res-plausibility')).toBeAttached();
	expect(await panelOrder(page)).toEqual(PANELS.map(([a, h]) => `${a}: ${h}`));
	// Two sub-headings of Calibration against observed flow have ids of their own, for the side index's lines (issue #586 D4).
	// Each an h4 under the panel's h3 (issue #586 R3-D: the page's parts are its h2s).
	await expect(page.locator('#res-calibration h4#res-calibration-check')).toHaveText('Calibration check: flow against use, per gauge');
	await expect(page.locator('#res-calibration h4#res-fit-provenance')).toContainText('Where the parameters came from');

	for (const [anchor, heading] of PANELS) {
		// From another tab, so each is a fresh load and the page's landing runs.
		await page.goto(`/projects/${id}?tab=overview`);
		await page.goto(`/projects/${id}?tab=calibration&run=${runId}#${anchor}`);
		const panel = page.locator(`#${anchor}`);
		const h = panel.locator('h2, h3, h4').first();
		await expect(h, anchor).toHaveText(heading);
		// Shown, so the focus ring the link puts on it can be seen.
		expect(await h.evaluate((e) => !e.closest('.visually-hidden') && e.getBoundingClientRect().width > 1), anchor).toBe(true);
		await expect(h, anchor).toBeFocused();
		await expect.poll(async () => { const y = (await panel.boundingBox())!.y; return y >= 0 && y < VIEW.height; }, { message: anchor }).toBe(true);
	}
});

test('a link to a Model quality panel this run doesn’t have says what the panel needs, focused; another run picked drops it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Calibration missing panels');
	const runId = await createRun(page.request, project.id, 'Plain');
	for (const [anchor, needs, href] of [
		['res-wr2012', 'It needs a WR2012 reference for the catchment', '?tab=calibration#set-wr2012'],
		['res-gauges', 'It needs a flow record at a gauge that is not the calibration site', '?tab=series'],
		['res-unit-rain', 'It needs Per unit flow generation', '?tab=settings#set-share']
	] as const) {
		await page.goto(`/projects/${project.id}?tab=overview`);
		await page.goto(`/projects/${project.id}?tab=calibration&run=${runId}#${anchor}`);
		const line = page.getByTestId('missing-panel');
		await expect(line, anchor).toContainText(needs);
		await expect(line, anchor).toHaveAttribute('data-for', anchor);
		await expect(line.getByRole('link'), anchor).toHaveAttribute('href', href);
		await expect(line, anchor).toBeFocused();
		await expect(line, anchor).toBeInViewport();
	}
	const other = await createRun(page.request, project.id, 'Another');
	await page.goto(`/projects/${project.id}?tab=overview`);
	await page.goto(`/projects/${project.id}?tab=calibration&run=${runId}#res-wr2012`);
	await expect(page.getByTestId('missing-panel')).toBeVisible();
	await calibrationRunPicker(page).selectOption(other);
	await expect(page).toHaveURL(new RegExp(`run=${other}`));
	await expect(page.getByTestId('calibration-results')).toHaveAttribute('data-run', other);
	await expect(page.getByTestId('missing-panel')).toHaveCount(0);
});

test('the run picker: the newest by default, a pick writes ?run= as a step Back and Forward retrace', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Calibration picker');
	const oldest = await createRun(page.request, project.id, 'Oldest');
	const newest = await createRun(page.request, project.id, 'Newest');
	const picker = calibrationRunPicker(page);
	const shows = async (id: string, label: string) => {
		await expect(page.getByTestId('calibration-results')).toHaveAttribute('data-run', id);
		await expect(picker.locator('option:checked')).toHaveText(new RegExp(`^${label} · `));
	};

	await page.goto(`/projects/${project.id}?tab=overview`);
	await openCalibration(page, project.id);
	await shows(newest, 'Newest');
	// The options name each run as the other pages' pickers do, newest first, the newest marked latest.
	await expect(picker.locator('option')).toHaveText([/^Newest · .* · latest$/, /^Oldest · /]);

	// As a keyboard user would: focus it, then choose (selectOption alone doesn't focus it).
	await picker.focus();
	await picker.selectOption(oldest);
	await expect(page).toHaveURL(new RegExp(`\\?tab=calibration&run=${oldest}$`));
	await shows(oldest, 'Oldest');
	// The picker keeps the focus through the change.
	await expect(picker).toBeFocused();
	await page.goBack();
	await expect(page).toHaveURL(/\?tab=calibration$/);
	await shows(newest, 'Newest');
	await page.goForward();
	await expect(page).toHaveURL(new RegExp(`run=${oldest}$`));
	await shows(oldest, 'Oldest');

	// A run that's gone: the newest shows, and says so.
	await page.goto(`/projects/${project.id}?tab=calibration&run=no-such-run`);
	await expect(page.getByRole('note')).toContainText('That run no longer exists');
	await shows(newest, 'Newest');
});

test('the Summary’s model checks: the calibration item links to Calibration for the run, landing on its scores', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Calibration from the Summary');
	const older = await createRun(page.request, project.id, 'Older');
	await createRun(page.request, project.id, 'Newer');
	await page.goto(`/projects/${project.id}?tab=runs&run=${older}`);
	const checks = page.getByTestId('credibility');
	const item = checks.getByRole('link', { name: /^Calibration NSE / });
	await expect(item).toHaveAttribute('href', `?tab=calibration&run=${older}#res-calibration`);
	await expect(checks.getByRole('link', { name: /^Plausibility / })).toHaveAttribute('href', `?tab=calibration&run=${older}#res-plausibility`);
	await item.click();
	await expect(page).toHaveURL(new RegExp(`\\?tab=calibration&run=${older}#res-calibration$`));
	await expect(page.getByTestId('calibration-results')).toHaveAttribute('data-run', older);
	const h = page.locator('#res-calibration').locator('h2, h3, h4').first();
	await expect(h).toHaveText('Calibration against observed flow');
	await expect(h).toBeFocused();
	await expect(h).toBeInViewport();
});
