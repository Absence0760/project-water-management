// The Calibration page's first line (issue #586 R4-A, docs/ui.md § Calibration): the page's answer on its first screen,
// how the shown run fits or why there is nothing to read yet, since the settings panels push Model quality's scores
// ~3,800 px down at 1440 × 960. Also the note when the form's GR4J parameters differ from the shown run's, the score
// tiles' 3 + 3, the run picker's day-first dates, the annual water balance on a phone, and a run with no observed
// record. Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { answerConfirm } from '../support/confirm.ts';
import { addMember, createProject, createRun, putModel, putSeries, sampleModel, seedRunnableProject, syntheticRain, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { settingsBar } from '../support/settings.ts';

const line = (page: Page) => page.getByTestId('calibration-status');
const nseTile = (page: Page) => page.locator('#res-calibration .metric').filter({ hasText: 'Nash–Sutcliffe (NSE)' }).locator('.value');

/** A project with a model, rain and A-pan but no observed flow record, and one run of it. */
async function seedRainOnly(page: Page, name: string): Promise<string> {
	const p = await createProject(page.request, name);
	await putModel(page.request, p.id, sampleModel());
	await updateSettings(page.request, p.id, { apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110] });
	await putSeries(page.request, p.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(120) });
	await createRun(page.request, p.id, 'Rain only');
	return p.id;
}

test.describe('1440×960', () => {
	test.use({ viewport: { width: 1440, height: 960 } });

	test('the shown run’s scores on the first screen, toned and in words, linking on to the tiles; the tiles 3 + 3', async ({ page, owner }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration first line');
		await createRun(page.request, p.id, 'Baseline');
		await page.goto(`/projects/${p.id}?tab=calibration`);
		await expect(line(page)).toContainText(/^Shown run, Baseline: NSE /);
		await expect(line(page)).toBeInViewport();
		// Above the first part, under the header: the first thing the page says.
		expect((await line(page).boundingBox())!.y).toBeLessThan((await page.locator('#cal-setup-h').boundingBox())!.y);
		// The synthetic record's fit is no better than the mean flow: the line says so in words and takes the warning rule.
		const nse = (await nseTile(page).textContent())!.trim();
		await expect(line(page)).toContainText(`NSE ${nse}, no better than the mean flow · KGE `);
		await expect(line(page)).toContainText(/ · volume bias [\d.]+% too (dry|wet)\./);
		await expect(line(page)).toHaveClass(/\bwarn\b/);
		await expect(page.getByTestId('calibration-changed')).toHaveCount(0);

		// Six tiles, 3 + 3: no row with an empty half beside it.
		const tops = await page.locator('#res-calibration .metric').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
		expect(tops).toHaveLength(6);
		expect(new Set(tops.slice(0, 3)).size, 'the first three tiles on one row').toBe(1);
		expect(new Set(tops.slice(3)).size, 'the last three on the next').toBe(1);
		expect(tops[3]).toBeGreaterThan(tops[0]!);

		// The link lands on the panel's heading, focused.
		await line(page).getByRole('link', { name: 'All the scores' }).click();
		await expect(page).toHaveURL(/\?tab=calibration#res-calibration$/);
		await expect(page.locator('#res-calibration').getByRole('heading', { name: 'Calibration against observed flow' })).toBeFocused();
		await expect(page.locator('#res-calibration').getByRole('heading', { name: 'Calibration against observed flow' })).toBeInViewport();
	});

	test('an edit to the GR4J parameters: the line and a note over the results say the run used others, by how much', async ({ page, owner }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration changed');
		await createRun(page.request, p.id, 'Baseline');
		await page.goto(`/projects/${p.id}?tab=calibration`);
		await expect(line(page)).toContainText(/^Shown run, Baseline: NSE /);
		const x1 = page.getByLabel(/^Production store capacity X1/);
		await x1.fill('321');
		await x1.blur();
		await expect(line(page)).toContainText('The form’s GR4J parameters differ from this run’s: run the model to score them.');
		const note = page.getByTestId('calibration-changed');
		await expect(note).toHaveText('The form’s GR4J parameters differ from the ones this run used (X1 350 → 321 mm): the fit below is this run’s. Run the model to score the form’s.');
		// Discarded, the form is the run's again: both go.
		await settingsBar(page).getByRole('button', { name: 'Discard', exact: true }).click();
		await answerConfirm(page, true, 'Your unsaved changes to the settings will be lost.');
		await expect(note).toHaveCount(0);
		await expect(line(page)).not.toContainText('differ');
	});

	test('the run picker names when each run ran day first, as the run line does', async ({ page, owner }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration picker dates');
		await createRun(page.request, p.id, 'Older run');
		await createRun(page.request, p.id, 'Newest run');
		await page.goto(`/projects/${p.id}?tab=calibration#cal-fit`);
		const options = page.locator('#cal-fit').getByRole('combobox', { name: 'Run', exact: true }).locator('option');
		await expect(options).toHaveCount(2);
		for (const text of await options.allTextContents()) {
			expect(text, 'no year-first date').not.toMatch(/\d{4}-\d{2}-\d{2}/);
			expect(text).toMatch(/ · (today|yesterday|\d{1,2} [A-Z][a-z]{2} \d{4}) \d{2}:\d{2} · /);
		}
	});

	test('a run with no observed record: the line says it isn’t scored and why, and the charts don’t claim an observed line', async ({ page, owner }) => {
		void owner;
		const id = await seedRainOnly(page, 'Calibration rain only');
		await page.goto(`/projects/${id}?tab=calibration`);
		await expect(line(page)).toHaveText('Shown run, Rain only: not scored, the project has no observed flow record. Add one on Data');
		await expect(line(page).getByRole('link', { name: 'Add one on Data' })).toHaveAttribute('href', '?tab=series');
		await expect(line(page)).not.toHaveClass(/\bwarn\b/);
		await expect(page.getByRole('img', { name: /^Flow at the outflow gauge: natural and simulated \(no observed record in this run\)/ })).toBeVisible();
		await expect(page.getByRole('img', { name: /^Flow-duration curve at the outflow gauge: natural and simulated \(no observed record in this run\)/ })).toBeVisible();
		await expect(page.locator('#res-hydrograph')).not.toContainText('Observed flow is a line broken');
	});

	test('no record, no run: the line says what to do first and links to Data; a viewer’s says who can run the model', async ({ page, owner, signIn }) => {
		void owner;
		const p = await createProject(page.request, 'Calibration first line empty');
		await page.goto(`/projects/${p.id}?tab=calibration`);
		await expect(line(page)).toHaveText('No observed flow record yet. A fit needs a flow record measured at a gauge: add one on Data.');
		await expect(line(page).getByRole('link', { name: 'add one on Data' })).toHaveAttribute('href', '?tab=series');
		await expect(line(page)).toBeInViewport();

		const q = await seedRunnableProject(page.request, 'Calibration first line viewer');
		const viewer = await signIn('Calibration first line viewer');
		await addMember(page.request, q.id, viewer.user.email, 'viewer');
		await viewer.page.setViewportSize({ width: 1440, height: 960 });
		await viewer.page.goto(`/projects/${q.id}?tab=calibration`);
		await expect(line(viewer.page)).toHaveText('No run yet. An editor can run the model.');
		await expectNoViolations(viewer.page);
	});
});

test.describe('phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('the line on the first screen; the tiles one to a row and the annual water balance stacked, nothing sideways', async ({ page, owner }) => {
		void owner;
		const p = await seedRunnableProject(page.request, 'Calibration first line phone');
		await createRun(page.request, p.id, 'Baseline');
		await page.goto(`/projects/${p.id}?tab=calibration`);
		await expect(line(page)).toContainText(/^Shown run, Baseline: NSE /);
		await expect(line(page)).toBeInViewport();

		await page.locator('#res-calibration').scrollIntoViewIfNeeded();
		const xs = await page.locator('#res-calibration .metric').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
		expect(new Set(xs).size, 'one tile to a row').toBe(1);
		// The year table: each row a block, its cells named, no box scrolling sideways.
		const wrap = page.locator('#res-calibration .years-wrap');
		await expect(wrap).toBeVisible();
		expect(await wrap.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
		const days = page.locator('#res-calibration .years tbody td').first();
		await expect(days).toHaveText(/^\d+ of \d+$/);
		expect(await days.evaluate((e) => getComputedStyle(e, '::before').content)).toBe('"Days observed"');
		await expectNoSidewaysScroll(page);
		await expectNoViolations(page);
	});
});
