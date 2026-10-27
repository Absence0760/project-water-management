// Model settings at 1440, 1280 and 390 px (issue #586 R4-B, docs/ui.md § Model settings): the panel that heads the
// page, renamed in plain words ("EWR the results are judged by", "Judge results by" until finding E14) with its line
// at the same gap under its heading as every other panel's (it ran into the heading); Demand's A-pan row on one
// line with its year total inside the panel (the label wrapped to three lines and the total ran past the panel
// beside the side index); Model selection for flow generation ("Flow generation" until issue #614, which put it
// first) saying what each method does and where the runoff model's parameters are set, so it can't be taken for
// Calibration's Flow calibration; and Find a setting finding the judge panel, which had no link. Synthetic data only
// (the Showcase's model and settings).
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject } from '../support/api.ts';
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
	test(`at ${width}: the head panel’s line clears its heading, Demand’s A-pan row fits on one line with its year total, and EWR’s row fits its box`, async ({ page, owner }) => {
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

		// EWR's Pragmatic EWR row (six-digit m³/day cells) and its l/s row: nothing scrolls sideways in its box, and
		// Sep, the last month, is whole inside it (issue #586 R4-B follow-up).
		const ewr = page.getByTestId('ewr-row');
		await ewr.scrollIntoViewIfNeeded();
		const ewrWrap = ewr.locator('xpath=..');
		expect(await ewrWrap.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
		const sep = (await ewr.locator('tbody tr').first().locator('td').last().boundingBox())!;
		const ewrBox = (await ewrWrap.boundingBox())!;
		expect(sep.x + sep.width).toBeLessThanOrEqual(ewrBox.x + ewrBox.width + 0.5);
		for (const input of await ewr.getByRole('spinbutton').all()) expect(await input.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
		await expectNoSidewaysScroll(page);
	});
}

test('Model selection for flow generation says what each method does and where the runoff parameters are, and its link lands on Calibration’s Flow calibration', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Model settings flow words');
	await openSettings(page, project.id);
	const panel = page.locator('#set-share');
	await expect(panel.getByRole('heading', { level: 2 })).toHaveText('Model selection for flow generation');
	// The choice is named for what it decides, each method described in plain words, shown without the explanations.
	const method = panel.getByRole('group', { name: /^How natural flow is made/ });
	await expect(page.getByRole('checkbox', { name: 'Explain each setting under its field' })).not.toBeChecked();
	await expect(method.getByRole('radio', { name: 'Fragmentation', exact: true })).toHaveAccessibleDescription('one runoff run on the catchment rain, split between the units');
	await expect(method.getByRole('radio', { name: 'Per unit', exact: true })).toHaveAccessibleDescription('a runoff run for each unit with land, on its own rain');
	for (const what of await panel.getByTestId('flowgen-what').all()) await expect(what).toBeVisible();
	// Each method's words under its name, inside its choice card (issue #614).
	for (const [i, name] of ['Fragmentation', 'Per unit'].entries()) {
		const card = (await method.locator('.opt').nth(i).boundingBox())!;
		const label = (await method.locator('label.check').nth(i).boundingBox())!;
		const words = (await method.getByTestId('flowgen-what').nth(i).boundingBox())!;
		expect(words.y, name).toBeGreaterThanOrEqual(label.y + label.height - 8);
		expect(words.y + words.height, name).toBeLessThanOrEqual(card.y + card.height);
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

test('the model selection panel leads the page and its two methods are choice cards (issue #614)', async ({ page, owner, signIn }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Model settings lead card');
	await openSettings(page, project.id);
	const lead = page.locator('#set-share');
	await expect(lead).toHaveAttribute('data-lead', '');
	// First on the page: above the judge panel, which is above every other panel.
	const leadBox = (await lead.boundingBox())!;
	const judgeBox = (await page.locator('#set-judge').boundingBox())!;
	expect(leadBox.y + leadBox.height).toBeLessThanOrEqual(judgeBox.y);
	expect(await page.locator('.settings-form > .panel').first().getAttribute('id')).toBe('set-share');
	// Framed in the accent, unlike the panel under it.
	const border = (sel: string) => page.locator(sel).evaluate((el) => getComputedStyle(el).borderTopColor);
	const accent = await page.evaluate(() => {
		const probe = document.createElement('span');
		probe.style.color = 'var(--accent)';
		document.body.append(probe);
		const c = getComputedStyle(probe).color;
		probe.remove();
		return c;
	});
	expect(await border('#set-share')).toBe(accent);
	expect(await border('#set-judge')).not.toBe(accent);

	// The two methods side by side as cards, the picked one marked, each a radio still.
	const method = lead.getByRole('group', { name: /^How natural flow is made/ });
	const cards = method.locator('.opt');
	await expect(cards).toHaveCount(2);
	const [a, b] = [(await cards.nth(0).boundingBox())!, (await cards.nth(1).boundingBox())!];
	expect(Math.abs(a.y - b.y)).toBeLessThan(1);
	expect(b.x).toBeGreaterThanOrEqual(a.x + a.width);
	const fragmentation = method.getByRole('radio', { name: 'Fragmentation', exact: true });
	const perUnit = method.getByRole('radio', { name: 'Per unit', exact: true });
	await expect(fragmentation).toBeChecked();
	// The keyboard picks a method as it did: the arrow moves the pick within the group.
	await fragmentation.focus();
	await page.keyboard.press('ArrowRight');
	await expect(perUnit).toBeChecked();
	await expect(perUnit).toBeFocused();
	// A click on a card's words picks it too: the label covers the card (a mouse click at the words, since the label
	// lies over them).
	const words = (await method.getByTestId('flowgen-what').nth(0).boundingBox())!;
	await page.mouse.click(words.x + words.width / 2, words.y + words.height / 2);
	await expect(fragmentation).toBeChecked();
	await expectNoViolations(page, { include: '#set-share' });

	// A viewer reads the cards and can't change the pick: a click on the other card's words leaves it.
	const viewer = await signIn('Lead card viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await openSettings(viewer.page, project.id);
	const seen = viewer.page.locator('#set-share').getByRole('group', { name: /^How natural flow is made/ });
	await expect(seen.getByRole('radio')).toHaveCount(2);
	for (const radio of await seen.getByRole('radio').all()) await expect(radio).toBeDisabled();
	await expect(seen.getByRole('radio', { name: 'Fragmentation', exact: true })).toBeChecked();
	const other = (await seen.getByTestId('flowgen-what').nth(1).boundingBox())!;
	await viewer.page.mouse.click(other.x + other.width / 2, other.y + other.height / 2);
	await expect(seen.getByRole('radio', { name: 'Fragmentation', exact: true })).toBeChecked();
	await expectNoViolations(viewer.page, { include: '#set-share' });
});

test('Find a setting finds the judge panel, by its heading, and the index lists it second, after the model selection', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Model settings find head');
	await openSettings(page, project.id);
	const menu = settingsMenu(page);
	// The model selection leads (issue #614), the judge panel right under it.
	await expect(menu.getByRole('link').first()).toHaveText('Model selection for flow generation');
	await expect(menu.getByRole('link').first()).toHaveAttribute('href', '#set-share');
	await expect(menu.getByRole('link').nth(1)).toHaveText('EWR the results are judged by');
	await expect(menu.getByRole('link').nth(1)).toHaveAttribute('href', '#set-judge');
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
				// The choice cards stack, each the group's width (issue #614).
				const group = (await method.boundingBox())!;
				const [one, two] = [(await method.locator('.opt').nth(0).boundingBox())!, (await method.locator('.opt').nth(1).boundingBox())!];
				expect(two.y).toBeGreaterThanOrEqual(one.y + one.height);
				expect(Math.abs(two.x - one.x)).toBeLessThanOrEqual(1);
				for (const card of [one, two]) expect(card.width).toBeGreaterThan(group.width - 24);
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
