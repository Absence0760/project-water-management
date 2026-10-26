// Model settings at 1440, 1280 and 390 px (issue #586 R4-B, docs/ui.md § Model settings): the panel that heads the
// page, renamed in plain words ("EWR the results are judged by", "Judge results by" until finding E14) with its line
// at the same gap under its heading as every other panel's (it ran into the heading); Demand's A-pan row on one
// line with its year total inside the panel (the label wrapped to three lines and the total ran past the panel
// beside the side index); Flow generation saying what each method does and where the runoff model's parameters are
// set, so it can't be taken for Calibration's Flow calibration; and Find a setting finding the head panel, which had
// no link. Synthetic data only (the Showcase's model and settings).
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { openSettings, settingsMenu } from '../support/settings.ts';
import { seedShowcaseModel } from '../support/showcase.ts';

/** The gap (px) between a panel's h2 and the line of values under it. */
const headingGap = (page: Page, panel: string, line: string) =>
	page.evaluate(
		([p, l]) => {
			const h = document.querySelector(`#${p} h2`)!.getBoundingClientRect();
			const s = document.querySelector(`[data-testid="${l}"]`)!.getBoundingClientRect();
			return s.top - h.bottom;
		},
		[panel, line] as const
	);

/** How many lines the A-pan row's label (its words and unit, not its ⓘ) takes: its height in the row's line heights. */
const apanLabelLines = (page: Page) =>
	page.getByTestId('apan-row').locator('tbody th').evaluate((th) => {
		const r = document.createRange();
		r.setStartBefore(th.firstChild!);
		r.setEndAfter(th.querySelector('.u')!);
		return Math.round(r.getBoundingClientRect().height / parseFloat(getComputedStyle(th).lineHeight));
	});

for (const [width, height] of [
	[1440, 960],
	[1280, 800]
] as const) {
	test(`at ${width}: the head panel’s line clears its heading, and Demand’s A-pan row fits on one line with its year total`, async ({ page, owner }) => {
		void owner;
		await page.setViewportSize({ width, height });
		const project = await seedShowcaseModel(page.request, `Model settings layout ${width}`);
		await openSettings(page, project.id);

		// Plain words for the panel that heads the page (E14), and no Rule table here, so its one line says so.
		const judge = page.locator('#set-judge');
		await expect(judge.getByRole('heading', { level: 2 })).toHaveText('EWR the results are judged by');
		await expect(page.getByTestId('judge-nothing')).toBeVisible();
		// Its line sits under the heading at the same gap as every other panel's, never over it (it was 1 px).
		const gap = await headingGap(page, 'set-judge', 'judge-nothing');
		const other = await headingGap(page, 'set-period', 'summary-period');
		expect(gap).toBeGreaterThanOrEqual(4);
		expect(Math.abs(gap - other)).toBeLessThanOrEqual(1);

		// The A-pan row: its label on one line, twelve months and the year total inside the panel, nothing scrolling sideways.
		const table = page.getByTestId('apan-row');
		await table.scrollIntoViewIfNeeded();
		expect(await apanLabelLines(page)).toBe(1);
		const wrap = table.locator('xpath=..');
		expect(await wrap.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
		const year = (await table.locator('tbody td').last().boundingBox())!;
		const box = (await wrap.boundingBox())!;
		expect(year.x + year.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
		await expect(table.locator('tbody td').last()).toHaveText('1 780');
		// Each month's value whole in its field.
		for (const input of await table.getByRole('spinbutton').all()) expect(await input.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
		await expectNoSidewaysScroll(page);
	});
}

test('Flow generation says what each method does and where the runoff parameters are, and its link lands on Calibration’s Flow calibration', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Model settings flow words');
	await openSettings(page, project.id);
	const panel = page.locator('#set-share');
	await expect(panel.getByRole('heading', { level: 2 })).toHaveText('Flow generation');
	// The choice is named for what it decides, each method described in plain words, shown without the explanations.
	const method = panel.getByRole('group', { name: /^How natural flow is made/ });
	await expect(page.getByRole('checkbox', { name: 'Explain each setting under its field' })).not.toBeChecked();
	await expect(method.getByRole('radio', { name: 'Fragmentation', exact: true })).toHaveAccessibleDescription('one runoff run on the catchment rain, split between the units');
	await expect(method.getByRole('radio', { name: 'Per unit', exact: true })).toHaveAccessibleDescription('a runoff run for each unit with land, on its own rain');
	for (const what of await panel.getByTestId('flowgen-what').all()) await expect(what).toBeVisible();
	// Each method's words on its name's line at 1440.
	for (const name of ['Fragmentation', 'Per unit']) {
		const radio = (await method.getByRole('radio', { name, exact: true }).boundingBox())!;
		const words = (await method.getByTestId('flowgen-what').nth(name === 'Fragmentation' ? 0 : 1).boundingBox())!;
		expect(Math.abs(words.y + words.height / 2 - (radio.y + radio.height / 2))).toBeLessThan(6);
	}

	// Where the runoff model's parameters are: on Calibration, under Flow calibration, which the link lands on.
	const where = panel.getByTestId('flowgen-where');
	await expect(where).toHaveText('The runoff model’s parameters are fitted on Calibration, under Flow calibration.');
	await where.getByRole('link', { name: 'Flow calibration' }).click();
	await expect(page).toHaveURL(/\?tab=calibration#set-flow$/);
	// A panel under Calibration's "Set up the fit" part, a level down (issue #586 round 3).
	const flowCal = page.locator('#set-flow').getByRole('heading', { name: /^Flow calibration/ }).first();
	await expect(flowCal).toBeFocused();
	await expect(flowCal).toBeInViewport();
	await page.goBack();
	await expect(page).toHaveURL(/\?tab=settings$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Model settings' })).toBeVisible();
	await expectNoViolations(page);
});

test('Find a setting finds the panel that heads the page, by its heading, and the index lists it first', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Model settings find head');
	await openSettings(page, project.id);
	const menu = settingsMenu(page);
	await expect(menu.getByRole('link').first()).toHaveText('EWR the results are judged by');
	await expect(menu.getByRole('link').first()).toHaveAttribute('href', '#set-judge');
	// It had no link, so the find box had nothing to find (issue #586 R4-B).
	const box = page.getByRole('searchbox', { name: 'Find a setting' });
	await box.fill('judged');
	const matches = menu.getByRole('list', { name: 'Matches' });
	await expect(matches.getByRole('link', { name: 'EWR the results are judged by' })).toBeVisible();
	await page.locator('#set-period').scrollIntoViewIfNeeded();
	await matches.getByRole('link', { name: 'EWR the results are judged by' }).click();
	await expect(page).toHaveURL(/#set-judge$/);
	await expect(page.getByRole('heading', { level: 2, name: 'EWR the results are judged by' })).toBeInViewport();
});

test.describe('on a phone', () => {
	for (const colorScheme of ['light', 'dark'] as const) {
		test.describe(colorScheme, () => {
			test.use({ viewport: { width: 390, height: 844 }, colorScheme });

			test(`each method’s words sit under its name, lined up with it, nothing scrolls sideways, and axe passes (${colorScheme})`, async ({ page, owner }) => {
				void owner;
				const project = await createProject(page.request, `Model settings phone ${colorScheme}`);
				await openSettings(page, project.id);
				const method = page.locator('#set-share').getByRole('group', { name: /^How natural flow is made/ });
				await method.scrollIntoViewIfNeeded();
				/** Where an element's words start (its text, not its padding), after `skip` when given (the radio). */
				const textLeft = (el: Element, skip: string | null) => {
					const r = document.createRange();
					r.selectNodeContents(el);
					const after = skip ? el.querySelector(skip) : null;
					if (after) r.setStartAfter(after);
					return r.getBoundingClientRect().left;
				};
				for (const [i, name] of ['Fragmentation', 'Per unit'].entries()) {
					const label = method.locator('label.check').nth(i);
					const words = method.getByTestId('flowgen-what').nth(i);
					const labelBox = (await label.boundingBox())!;
					// Under the name, starting where the name's words start (past the radio), not under the radio.
					expect((await words.boundingBox())!.y, name).toBeGreaterThanOrEqual(labelBox.y + labelBox.height - 8);
					const nameLeft = await label.evaluate(textLeft, 'input');
					const wordsLeft = await words.evaluate(textLeft, null);
					expect(Math.abs(wordsLeft - nameLeft), name).toBeLessThanOrEqual(4);
				}
				await expect(page.locator('#set-judge').getByRole('heading', { level: 2 })).toHaveText('EWR the results are judged by');
				await expectNoSidewaysScroll(page);
				await expectNoViolations(page);
			});
		});
	}
});
