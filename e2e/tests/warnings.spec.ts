// The Warnings page (`?tab=warnings`, issue #611, docs/ui.md § Warnings): one
// row per flagged period, filter chips in the URL with their counts, a
// decision per row (rain: Patch or Keep; flow: Exclude from calibration or
// Keep) and in bulk ("Select all N matching"), each saved at once into the
// setting it belongs to, so the next run reads the patched rain as missing and
// leaves the excluded flow out of its calibration statistics. A viewer reads
// it without the ticks and buttons. A sidebar row of its own after Data, with
// its count of open items; problems from elsewhere (the model, unsaved
// settings, data feeds, data behind, runs an erratum may affect) are rows
// linking to their fix, filtered by a source chip. Synthetic series only.
import type { Page } from '@playwright/test';
import { addMember, createRun, updateSettings } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { pinClockToProject } from '../support/clock.ts';
import { sections } from '../support/data.ts';
import { expectNoSidewaysScroll, squashedChecks } from '../support/reflow.ts';
import { expect, test } from '../support/fixtures.ts';
import {
	bulkBar,
	checkChips,
	checksPanel,
	openWarnings,
	runSummary,
	savedSettings,
	seedWarnings,
	statusChips,
	warningRow,
	warningRows,
	warningsTable
} from '../support/warnings.ts';

test.use({ timezoneId: 'UTC' });

/** The flow record's series id: its rows carry it in their item id. */
async function flowId(page: Page): Promise<string> {
	const item = await warningRow(page, 'Weir record').getAttribute('data-item');
	return item!.split(':')[1]!;
}

test.describe('1440×960', () => {
	test.use({ viewport: { width: 1440, height: 960 } });

	test('lists one row per period, one title, its chips in the URL with counts, and Back steps through them', async ({ page, owner }) => {
		void owner;
		const project = await seedWarnings(page.request, 'Warnings chips');
		await createRun(page.request, project.id, 'Baseline');
		await pinClockToProject(page, project.id, 'lastRunAt');
		// The data checks alone: the chips count them.
		await openWarnings(page, project.id, '&source=checks');

		// One page title; its sidebar row, right after Data, current.
		await expect(page.getByRole('heading', { name: 'Warnings', exact: true })).toHaveCount(1);
		const nav = sections(page);
		await expect(nav.getByRole('link', { name: /^Warnings/ })).toHaveAttribute('aria-current', 'page');
		// The seed's rain ends in 2022: behind today, a problem elsewhere.
		await expect(page.getByTestId('warnings-context')).toHaveText('3 open of 3 flagged periods in 2 records · 1 problem elsewhere');
		await expect(warningRows(page)).toHaveCount(3);
		await expect(warningRow(page, '11 Oct 2021 – 16 Oct 2021')).toContainText('Valley gauge');
		await expect(warningRow(page, '11 Oct 2021 – 16 Oct 2021')).toContainText('5.5 mm on every day');
		await expect(warningRow(page, 'Weir record')).toContainText('Left out of Fit automatically only');
		await expect(statusChips(page).getByRole('link', { name: 'Open 3' })).toHaveAttribute('aria-current', 'true');
		await expect(checkChips(page).getByRole('link', { name: 'Flat stretch 3' })).toBeVisible();

		// The record picker is in the URL, a step in history.
		const record = page.getByTestId('warnings-record');
		await record.selectOption({ label: 'Weir record (1)' });
		await expect(page).toHaveURL(/[?&]series=[0-9a-f-]{36}/);
		await expect(warningRows(page)).toHaveCount(1);
		// The chips count against the other filters.
		await expect(statusChips(page).getByRole('link', { name: 'Open 1' })).toBeVisible();
		await checkChips(page).getByRole('link', { name: 'Flat stretch 1' }).click();
		await expect(page).toHaveURL(/[?&]check=flatline/);
		await page.goBack();
		await expect(page).not.toHaveURL(/check=/);
		await page.goBack();
		await expect(page).not.toHaveURL(/series=/);
		await expect(record).toHaveValue('');
		await expect(warningRows(page)).toHaveCount(3);

		// Status: All is a link with its count; a filter with nothing in it says so and offers every period.
		await statusChips(page).getByRole('link', { name: 'All 3' }).click();
		await expect(page).toHaveURL(/[?&]status=all/);
		await openWarnings(page, project.id, '&source=checks&status=kept');
		await expect(page.getByTestId('warnings-none')).toContainText('Nothing matches these filters.');
		await expectNoViolations(page);

		// Leaving it, the row stays.
		await nav.getByRole('link', { name: /^Data/ }).click();
		await expect(page.getByRole('heading', { level: 1, name: 'Data' })).toBeVisible();
		await expect(nav.getByRole('link', { name: /^Warnings/ })).toBeVisible();
	});

	test('a tick patches rain and excludes flow; the run reads both as missing; Reopen takes one back', async ({ page, owner }) => {
		void owner;
		const project = await seedWarnings(page.request, 'Warnings decisions');
		const before = await createRun(page.request, project.id, 'Before');
		await pinClockToProject(page, project.id, 'lastRunAt');
		await openWarnings(page, project.id, '&source=checks');
		const weir = await flowId(page);

		await warningRow(page, '11 Oct 2021 – 16 Oct 2021').getByRole('button', { name: 'Patch: Flat stretch, Valley gauge, 11 Oct 2021 – 16 Oct 2021' }).click();
		await expect(page.getByTestId('warnings-notice')).toHaveText('Patched 1 flat stretch. Run the model to see which warnings remain.');
		// The row leaves the Open list; the focus goes to the row now in its place.
		await expect(warningRows(page)).toHaveCount(2);
		await expect(warningRows(page).first().locator('[data-row-action]')).toBeFocused();

		await warningRow(page, 'Weir record').getByRole('button', { name: 'Exclude from calibration: Flat stretch, Weir record, 20 Nov 2021 – 9 Dec 2021' }).click();
		await expect(page.getByTestId('warnings-notice')).toHaveText('Excluded from calibration 1 flat stretch. Run the model to see which warnings remain.');
		await expect(warningRows(page)).toHaveCount(1);

		// Each decision is in its own setting, as Settings shows it.
		const s = await savedSettings(page.request, project.id);
		expect((s.zeroRainRuns as { missing: unknown[] }).missing).toEqual([{ start: '2021-10-11', end: '2021-10-16', reason: 'Warnings: flat stretch' }]);
		expect(s.flowMissing).toEqual({ [weir]: [{ start: '2021-11-20', end: '2021-12-09', reason: 'Warnings: flat stretch' }] });

		// Decided rows show under Fixed or handled, each with its own word and where Settings lists it.
		await statusChips(page).getByRole('link', { name: 'Fixed or handled 2' }).click();
		await expect(warningRows(page)).toHaveCount(2);
		await expect(warningRow(page, 'Valley gauge')).toContainText('Patched');
		await expect(warningRow(page, 'Valley gauge').getByRole('link', { name: 'In settings' })).toHaveAttribute('href', '?tab=settings#set-rain');
		await expect(warningRow(page, 'Weir record')).toContainText('Excluded');
		await expect(warningRow(page, 'Weir record').getByRole('link', { name: 'In settings' })).toHaveAttribute('href', '?tab=calibration#set-record');

		// The usual notice: the inputs changed since the latest run.
		await sections(page).getByRole('link', { name: 'Runs & results' }).click();
		await expect(page.getByText(/Inputs changed since the latest run \(the model or settings were saved/)).toBeVisible();

		// The next run reads the patched days as missing rain, and scores 20 fewer days of the record.
		const after = await createRun(page.request, project.id, 'After');
		type S = { zeroRainInfill?: { periods: { start: string; end: string; source: string; days: number }[] }; calibration: { days: number } };
		const a = await runSummary<S>(page.request, project.id, after);
		const b = await runSummary<S>(page.request, project.id, before);
		expect(a.zeroRainInfill?.periods.find((p) => p.source === 'listed')).toMatchObject({ start: '2021-10-11', end: '2021-10-16', days: 6 });
		expect(b.calibration.days - a.calibration.days).toBe(20);

		// Reopen takes the period back out of its list.
		await openWarnings(page, project.id, '&source=checks&status=fixed');
		await warningRow(page, 'Valley gauge').getByRole('button', { name: /^Reopen/ }).click();
		await expect(warningRows(page)).toHaveCount(1);
		await expect(warningRow(page, 'Weir record')).toBeVisible();
		expect(((await savedSettings(page.request, project.id)).zeroRainRuns as { missing: unknown[] }).missing).toEqual([]);
	});

	test('a decision is built on the settings as saved now, so a save made elsewhere since the page loaded stays', async ({ page, owner }) => {
		void owner;
		const project = await seedWarnings(page.request, 'Warnings after another save');
		await openWarnings(page, project.id, '&source=checks');
		// Saved elsewhere after the page drew (another editor, another tab): a period of the same list.
		await updateSettings(page.request, project.id, { zeroRainRuns: { missing: [{ start: '2022-01-01', end: '2022-01-05', reason: 'Typed in Settings' }] } });
		await warningRow(page, '11 Oct 2021 – 16 Oct 2021').getByRole('button', { name: /^Patch:/ }).click();
		await expect(page.getByTestId('warnings-notice')).toHaveText('Patched 1 flat stretch. Run the model to see which warnings remain.');
		expect(((await savedSettings(page.request, project.id)).zeroRainRuns as { missing: unknown[] }).missing).toEqual([
			{ start: '2022-01-01', end: '2022-01-05', reason: 'Typed in Settings' },
			{ start: '2021-10-11', end: '2021-10-16', reason: 'Warnings: flat stretch' }
		]);
	});

	test('thirty periods: the list folds, Select all N matching takes the folded rows too, and one bulk Patch saves them', async ({ page, owner }) => {
		void owner;
		const project = await seedWarnings(page.request, 'Warnings big case', { days: 400, flats: 30 });
		await openWarnings(page, project.id, '&source=checks');
		await expect(warningRows(page)).toHaveCount(25);
		const bar = bulkBar(page);
		await expect(bar.getByText('None ticked')).toBeVisible();
		await expect(bar.getByRole('button', { name: 'Patch 0' })).toHaveAttribute('aria-disabled', 'true');

		// One tick, then every matching row (31, beyond the 25 shown).
		await warningRows(page).first().getByRole('checkbox').check();
		await expect(bar.getByText('1 ticked')).toBeVisible();
		await bar.getByRole('button', { name: 'Select all 31 matching' }).click();
		await expect(bar.getByText('31 ticked')).toBeVisible();
		await expect(bar.getByRole('button', { name: 'Exclude from calibration 1' })).toBeVisible();
		const patch = bar.getByRole('button', { name: 'Patch 30' });
		await patch.click();
		await expect(page.getByTestId('warnings-notice')).toHaveText('Patched 30 flat stretches. Run the model to see which warnings remain.');
		await expect(bar.getByRole('button', { name: 'Patch 0' })).toBeFocused();
		await expect(bar.getByText('None ticked')).toBeVisible();
		await expect(warningRows(page)).toHaveCount(1);
		await expect(statusChips(page).getByRole('link', { name: 'Fixed or handled 30' })).toBeVisible();
		const missing = ((await savedSettings(page.request, project.id)).zeroRainRuns as { missing: { reason: string }[] }).missing;
		expect(missing).toHaveLength(30);
		expect(new Set(missing.map((m) => m.reason))).toEqual(new Set(['Warnings: flat stretch']));

		// Show all opens the rest in place.
		await openWarnings(page, project.id, '&source=checks&status=all');
		await page.getByRole('button', { name: 'Show all 31 periods' }).click();
		await expect(warningRows(page)).toHaveCount(31);
		await expect(page.getByRole('button', { name: 'Show only the first 25 periods' })).toHaveAttribute('aria-expanded', 'true');
	});

	test('a viewer reads the rows and their statuses without ticks or buttons', async ({ page, owner, signIn }) => {
		void owner;
		const project = await seedWarnings(page.request, 'Warnings read-only');
		const viewer = await signIn('Warnings viewer');
		await addMember(page.request, project.id, viewer.user.email, 'viewer');
		await openWarnings(viewer.page, project.id);
		await expect(warningRows(viewer.page)).toHaveCount(3);
		await expect(warningsTable(viewer.page).getByRole('checkbox')).toHaveCount(0);
		await expect(warningsTable(viewer.page).getByRole('button')).toHaveCount(0);
		// Reading a period is for everyone: each row's View is a link.
		await expect(warningsTable(viewer.page).getByRole('link', { name: /^View on the chart:/ })).toHaveCount(3);
		await expect(bulkBar(viewer.page)).toHaveCount(0);
		await expect(warningRow(viewer.page, 'Weir record')).toContainText('Open');
		await expect(checksPanel(viewer.page)).toContainText('An editor patches rain');
		await expectNoViolations(viewer.page);
	});

	test('a period’s View opens its record on Data’s chart, on that period, hatched', async ({ page, owner }) => {
		void owner;
		const project = await seedWarnings(page.request, 'Warnings view');
		await openWarnings(page, project.id, '&source=checks');
		const row = warningRow(page, '11 Oct 2021 – 16 Oct 2021');
		await row.getByRole('link', { name: /^View on the chart:/ }).click();

		await expect(page).toHaveURL(/[?&]tab=series(&|$)/);
		await expect(page).toHaveURL(/[?&]view=2021-10-11~2021-10-16(&|#|$)/);
		await expect(page).toHaveURL(/#data-chart$/);
		const chart = page.locator('#data-chart');
		await expect(chart.locator('[data-band-from]')).toHaveAttribute('data-band-from', '2021-10-11');
		await expect(chart.locator('.band-key')).toContainText('Flagged');
		// The record the row named is the one charted.
		await expect(page.getByTestId('series-details')).toBeVisible();
		await expect(chart).toContainText('Valley gauge');
	});

	test('opens from Data’s checks panel and its row’s count, from Runs & results, and a #warn-run link lands on its heading', async ({ page, owner }) => {
		void owner;
		const project = await seedWarnings(page.request, 'Warnings links');
		const run = await createRun(page.request, project.id, 'Baseline');
		await pinClockToProject(page, project.id, 'lastRunAt');
		await page.goto(`/projects/${project.id}?tab=series`);
		// The Warnings row's count is the page's Open chip: the 3 open periods, the rain behind and the run's open warnings.
		await page.goto(`/projects/${project.id}?tab=warnings`);
		// Once every part has read what it lists: the table, the run's warnings, the feeds.
		await expect(warningsTable(page)).toBeVisible();
		await expect(page.getByTestId('warn-run-list')).toBeVisible();
		await expect(page.getByText('Reading the data feeds…')).toHaveCount(0);
		const openChip = page.getByTestId('warnings-status').getByRole('link', { name: /^Open \d+$/ });
		const n = Number((await openChip.innerText()).replace(/\D/g, ''));
		expect(n).toBeGreaterThan(4);
		await expect(sections(page).getByRole('link', { name: /^Warnings/ })).toHaveAccessibleName(`Warnings (${n} open)`);
		await page.goto(`/projects/${project.id}?tab=series`);
		// Data's name keeps only its own count.
		await expect(sections(page).getByRole('link', { name: /^Data/ })).toHaveAccessibleName('Data (1 series behind)');
		const toWarnings = page.getByTestId('checks-to-warnings');
		// The same number as the Warnings row's.
		await expect(toWarnings).toHaveText(`Patch, exclude or keep on Warnings (${n} open)`);
		await toWarnings.click();
		await expect(page.getByRole('heading', { level: 1, name: 'Warnings' })).toBeVisible();
		await expect(warningRows(page)).toHaveCount(3);

		await page.goto(`/projects/${project.id}?tab=runs`);
		await expect(page.getByTestId('run-to-warnings')).toHaveAttribute('href', `?tab=warnings&run=${run}#warn-run`);
		await page.getByTestId('run-to-warnings').click();
		await expect(page.getByRole('heading', { name: 'Run warnings' })).toBeFocused();
		await expect(page).toHaveURL(new RegExp(`[?&]run=${run}`));
	});
});

test.describe('problems from elsewhere', () => {
	test.use({ viewport: { width: 1440, height: 960 } });

	test('each is a row linking to its fix, the source chips are in the URL, and the data checks come first', async ({ page, owner }) => {
		void owner;
		const project = await seedWarnings(page.request, 'Warnings elsewhere');
		await openWarnings(page, project.id);
		const sources = page.getByTestId('warnings-sources');
		await expect(sources.getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'true');
		await expect(sources.getByRole('link', { name: 'Data checks 3' })).toBeVisible();
		await expect(sources.getByRole('link', { name: 'Data behind 1' })).toBeVisible();
		// The data checks first, then the problems elsewhere.
		const checksTop = (await page.locator('#warn-checks').boundingBox())!.y;
		const otherTop = (await page.locator('#warn-other').boundingBox())!.y;
		expect(checksTop).toBeLessThan(otherTop);

		const other = page.getByTestId('warn-other');
		const behind = other.locator('ul[data-source="data"] li');
		await expect(behind).toHaveCount(1);
		await expect(behind.filter({ hasText: 'Valley gauge' })).toContainText(/Its last day is \d+ days old/);
		// What to do, and the action that does it: an editor adds newer data.
		await expect(behind.filter({ hasText: 'Valley gauge' })).toContainText('How to fix: Add its newer data');
		await expect(behind.filter({ hasText: 'Valley gauge' }).getByRole('link', { name: 'Add newer data' })).toHaveAttribute('href', '?tab=series&add=data');
		// A problem can be ticked, and kept, like any row.
		await expect(behind.getByRole('checkbox')).toHaveCount(1);

		// One source: only that part shows; Back returns to all.
		await sources.getByRole('link', { name: 'Data behind 1' }).click();
		await expect(page).toHaveURL(/[?&]source=data/);
		await expect(page.locator('#warn-checks')).toHaveCount(0);
		await expect(page.locator('#warn-run')).toHaveCount(0);
		await expect(other.locator('li')).toHaveCount(1);
		await page.goBack();
		await expect(page.locator('#warn-checks')).toBeVisible();

		await expectNoViolations(page);
	});
});

test.describe('390×844', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('each period is a card, nothing scrolls sideways, and the page passes axe', async ({ page, owner }) => {
		void owner;
		const project = await seedWarnings(page.request, 'Warnings on a phone', { days: 400, flats: 30 });
		await createRun(page.request, project.id, 'Baseline');
		await pinClockToProject(page, project.id, 'lastRunAt');
		await openWarnings(page, project.id);
		expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
		const box = await warningsTable(page).evaluate((t) => ({ scroll: t.parentElement!.scrollWidth, client: t.parentElement!.clientWidth }));
		expect(box.scroll).toBeLessThanOrEqual(box.client);
		// The decisions are 44 px targets, side by side.
		const [patch, keep] = await Promise.all(
			['Patch', 'Keep'].map((n) => warningRows(page).first().getByRole('button', { name: new RegExp(`^${n}:`) }).boundingBox())
		);
		expect(patch!.height).toBeGreaterThanOrEqual(44);
		expect(Math.abs(patch!.y - keep!.y)).toBeLessThan(1);
		await expectNoViolations(page);
		// And at 320 px (WCAG 1.4.10): no sideways scroll, no squashed tick box.
		await page.setViewportSize({ width: 320, height: 640 });
		await expectNoSidewaysScroll(page);
		expect(await squashedChecks(page)).toEqual([]);
	});
});
