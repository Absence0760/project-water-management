// The Transfers page (?tab=transfers, issue #17 option A): the section header carries the count, Show on the map
// and + Add transfer; under it one card per rule (a head line with its number, From → To, an On/Off switch and
// Remove; its rates, limits and source in groups), the list growing with its rules while the page scrolls (never a
// scroll box inside it). Synthetic data only.
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, putModel, sampleModel } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { saveModelChanges } from '../support/network.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { answerConfirm } from '../support/confirm.ts';
import { openTransfers, ruleCard, rulesCard, rulesListBox, seedManyTransfers } from '../support/transfers.ts';

const header = (page: import('@playwright/test').Page) => page.getByTestId('section-header');
const saveBar = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Unsaved model changes' });

test('the header carries the count and the actions; + Add transfer adds a rule and focuses it', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Transfers page');
	await putModel(page.request, project.id, sampleModel());
	await openTransfers(page, project.id);

	await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
	await expect(header(page).getByTestId('section-context')).toHaveText('1 transfer rule · 1 active');
	await expect(header(page).getByRole('link', { name: 'Show on the map', exact: true })).toHaveAttribute('href', '?tab=network');
	await expect(header(page).getByRole('button', { name: '+ Add transfer', exact: true })).toBeVisible();
	await expect(header(page).getByRole('button', { name: 'Run model', exact: true })).toBeVisible();
	// The add button lives in the header only on the page.
	await expect(rulesCard(page).getByRole('button', { name: /Add transfer/ })).toHaveCount(0);

	// No month chart: the rules are the page (the "When water moves" card only restated the month rates).
	await expect(page.getByRole('region', { name: 'When water moves' })).toHaveCount(0);
	// One rule: the card is as tall as its rule, not stretched to the window, and the page doesn't scroll.
	const rules = (await rulesCard(page).boundingBox())!;
	expect(rules.y + rules.height).toBeLessThan(960 - 200);
	expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(960);
	await expectNoSidewaysScroll(page);

	// + Add transfer adds a rule after the others and puts the cursor in its From.
	await header(page).getByRole('button', { name: '+ Add transfer', exact: true }).click();
	await expect(page.getByLabel('Source of transfer 2', { exact: true })).toBeFocused();
	await expect(header(page).getByTestId('section-context')).toHaveText('2 transfer rules · 2 active');
	// Each month has its own rate (engine 1.14.0): October at 0.02 m³/s, the rest blank (off).
	await page.getByLabel('Max rate of transfer 2 in Oct, m³/s', { exact: true }).fill('0.02');
	await page.getByLabel('Max rate of transfer 2 in Oct, m³/s', { exact: true }).press('Tab');
	// Tab moves on to the next month's field.
	await expect(page.getByLabel('Max rate of transfer 2 in Nov, m³/s', { exact: true })).toBeFocused();
	await expect(page.getByRole('group', { name: /^Max rate of transfer 2 by month/ })).toContainText('Oct, up to 0.02 m³/s');
	// Switching the first rule off says so in its heading, beside the switch and in the header's count.
	await page.getByLabel('transfer 1 enabled', { exact: true }).uncheck();
	await expect(header(page).getByTestId('section-context')).toHaveText('2 transfer rules · 1 active');
	await expect(page.getByRole('heading', { level: 3, name: 'Transfer 1 off', exact: true })).toBeVisible();
	await expect(ruleCard(page, 1).locator('.switch')).toHaveText('Off');
	await expect(ruleCard(page, 2).locator('.switch')).toHaveText('On');

	await saveModelChanges(page);
	await expect(saveBar(page)).toBeHidden();
	await page.reload();
	await expect(page.getByLabel('Max rate of transfer 2 in Oct, m³/s', { exact: true })).toHaveValue('0.02');
	await expect(page.getByLabel('Max rate of transfer 2 in Nov, m³/s', { exact: true })).toHaveValue('');
	await expect(page.getByLabel('transfer 1 enabled', { exact: true })).not.toBeChecked();
});

test('each month has its own rate: a workbook rule shows its rate in its months, an edit changes that month only', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Transfers monthly rates');
	await putModel(page.request, project.id, sampleModel());
	await openTransfers(page, project.id);
	const rate = (m: string) => page.getByLabel(`Max rate of transfer 1 in ${m}, m³/s`, { exact: true });
	// The sample rule: one rate, 0.01 m³/s, in Nov–Feb; the other months are blank (off).
	for (const m of ['Nov', 'Dec', 'Jan', 'Feb']) await expect(rate(m)).toHaveValue('0.01');
	for (const m of ['Oct', 'Mar', 'Sep']) await expect(rate(m)).toHaveValue('');
	// Half the rate in February, and March on at 0.005: only those months change.
	await rate('Feb').fill('0.005');
	await rate('Mar').fill('0.005');
	await rate('Mar').press('Tab');
	for (const m of ['Nov', 'Dec', 'Jan']) await expect(rate(m)).toHaveValue('0.01');
	for (const m of ['Feb', 'Mar']) await expect(rate(m)).toHaveValue('0.005');
	await expect(rate('Apr')).toHaveValue('');
	// Clearing a month turns it off.
	await rate('Nov').fill('');
	await rate('Nov').press('Tab');
	await expect(rate('Nov')).toHaveValue('');
	// The button puts the largest rate in every month.
	await page.getByRole('button', { name: '0.01 in every month', exact: true }).click();
	for (const m of ['Oct', 'Nov', 'Apr', 'Sep']) await expect(rate(m)).toHaveValue('0.01');
	// The page has taken the save in (the bar goes once the editor holds what the server returned), so the
	// reload leaves a saved page, not one still mid-save behind its unsaved-changes guard.
	await saveModelChanges(page);
	await expect(saveBar(page)).toBeHidden();
	await page.reload();
	await expect(rate('Sep')).toHaveValue('0.01');
});

test('a rule can be a river off-take: its fields show in place of the minimum storage and survive a save', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Transfers off-take');
	await putModel(page.request, project.id, sampleModel());
	await openTransfers(page, project.id);
	const takes = page.getByLabel('Where transfer 1 takes its water', { exact: true });
	await expect(takes).toHaveValue('dam');
	await expect(page.getByLabel('Minimum source storage for transfer 1, %', { exact: true })).toBeVisible();
	await takes.selectOption('river');
	// The dam's minimum gives way to the off-take's own fields.
	await expect(page.getByLabel('Minimum source storage for transfer 1, %', { exact: true })).toHaveCount(0);
	await page.getByLabel('Hands-off flow for transfer 1, m³/day', { exact: true }).fill('250');
	await page.getByLabel('Conveyance losses of transfer 1, %', { exact: true }).fill('10');
	// Canal seepage back to the river (engine 1.42.0): where it rejoins shows once a share is set, the source by default.
	const rejoins = page.getByLabel('Where the seepage of transfer 1 rejoins the river', { exact: true });
	await expect(rejoins).toHaveCount(0);
	await page.getByLabel('Share of the losses of transfer 1 seeping back to the river, %', { exact: true }).fill('40');
	await expect(rejoins).toHaveValue('');
	await page.getByLabel('How much transfer 1 takes', { exact: true }).selectOption('capacity');
	await page.getByLabel('transfer 1 leaves the EWR in the river', { exact: true }).check();
	// The page has taken the save in (the bar goes once the editor holds what the server returned), so the
	// reload leaves a saved page, not one still mid-save behind its unsaved-changes guard.
	await saveModelChanges(page);
	await expect(saveBar(page)).toBeHidden();
	await page.reload();
	await expect(page.getByLabel('Where transfer 1 takes its water', { exact: true })).toHaveValue('river');
	await expect(page.getByLabel('Hands-off flow for transfer 1, m³/day', { exact: true })).toHaveValue('250');
	await expect(page.getByLabel('Conveyance losses of transfer 1, %', { exact: true })).toHaveValue('10');
	await expect(page.getByLabel('Share of the losses of transfer 1 seeping back to the river, %', { exact: true })).toHaveValue('40');
	await expect(page.getByLabel('Where the seepage of transfer 1 rejoins the river', { exact: true })).toHaveValue('');
	await expect(page.getByLabel('How much transfer 1 takes', { exact: true })).toHaveValue('capacity');
	await expect(page.getByLabel('transfer 1 leaves the EWR in the river', { exact: true })).toBeChecked();
	await expect(page.getByLabel('transfer 1 tops up the destination’s dam', { exact: true })).not.toBeChecked();
	await expectNoSidewaysScroll(page);
});

// One viewport per test, and the axe scan in a test of its own (as a11y.spec.ts does). Thirty rules make a
// 4,400-element page (sixteen fields a rule) whose WCAG scan takes 1.75 s idle and 6 s at a 4× CPU throttle,
// color-contrast two thirds of it and growing with every row: on top of two page loads that left a loaded run
// (twelve workers) too little of the 30 s budget.
for (const [width, height] of [
	[1440, 960],
	[1280, 800]
] as const) {
	test(`thirty rules at ${width} × ${height}: the page scrolls, not the rules list, and every rule's fields fit`, async ({ page, owner }) => {
		void owner;
		const project = await seedManyTransfers(page.request, 'Transfers big');
		await page.setViewportSize({ width, height });
		await openTransfers(page, project.id);
		await expect(page.getByLabel('Source of transfer 30', { exact: true })).toBeAttached();
		await expect(header(page).getByTestId('section-context')).toHaveText('30 transfer rules · 25 active');
		// One scroll: the list holds all thirty cards (nothing scrolls inside it) and the page is what scrolls.
		const box = await rulesListBox(page);
		expect(box.sh).toBeLessThanOrEqual(box.ch);
		expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(height);
		// A rule on a dam, off-season rates and the "in every month" shortcut stays near the old table's row
		// (120 px): the card redesign first made each ~225 px, so thirty rules scrolled twice as far.
		const heights = await page.getByTestId('transfer-rule').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
		expect(Math.max(...heights)).toBeLessThanOrEqual(width >= 1440 ? 150 : 176);
		// Everything fits: nothing scrolls sideways to reach Priority, On or Remove.
		expect(box.sw).toBeLessThanOrEqual(box.cw);
		await expect(page.getByRole('button', { name: /^Remove transfer 1 / })).toBeInViewport();
		// Five rules are off, each saying so in its heading.
		await expect(page.getByRole('heading', { level: 3, name: /^Transfer \d+ off$/ })).toHaveCount(5);
		// The last rule is reached by scrolling the page.
		const last = page.getByRole('button', { name: /^Remove transfer 30 / });
		await last.scrollIntoViewIfNeeded();
		await expect(last).toBeInViewport();
		await expectNoSidewaysScroll(page);
	});
}

// The scan needs every kind of row, not thirty of them: twelve hold every kind the thirty do (each month pattern, a
// daily cap or none, two rules off) in 2,000 elements, and scan in about half the time (0.98 s idle). Each row's own markup, a river off-take's fields and the phone's cards
// are scanned in "no accessibility violations" below.
test('a dozen rules at 1280 × 800, the page scrolling: no accessibility violations', async ({ page, owner }) => {
	void owner;
	const project = await seedManyTransfers(page.request, 'Transfers a11y many', 14, 12);
	await page.setViewportSize({ width: 1280, height: 800 });
	await openTransfers(page, project.id);
	await expect(header(page).getByTestId('section-context')).toHaveText('12 transfer rules · 10 active');
	await expect(page.getByRole('heading', { level: 3, name: /^Transfer \d+ off$/ })).toHaveCount(2);
	// The state the scan is for: longer than the window, the page scrolling rather than the card.
	expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(800);
	await expectNoViolations(page);
});

test('a viewer sees every rule, with nothing to change', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Transfers viewer');
	await putModel(page.request, project.id, sampleModel());
	const viewer = await signIn('Transfers viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.setViewportSize({ width: 1440, height: 960 });
	await v.goto(`/projects/${project.id}?tab=transfers`);
	await expect(v.getByRole('heading', { level: 1, name: 'Transfers' })).toBeVisible();
	await expect(v.getByLabel('Source of transfer 1', { exact: true })).toBeDisabled();
	await expect(v.getByLabel('transfer 1 enabled', { exact: true })).toBeDisabled();
	await expect(v.getByRole('button', { name: /Add transfer/ })).toHaveCount(0);
	await expect(v.getByRole('button', { name: /^Remove transfer/ })).toHaveCount(0);
	await expect(v.getByRole('button', { name: 'All', exact: true })).toHaveCount(0);
	await expect(header(v).getByRole('link', { name: 'Show on the map', exact: true })).toBeVisible();
	await expect(v.getByLabel('Max rate of transfer 1 in Nov, m³/s', { exact: true })).toHaveValue('0.01');
	// Read-only rather than disabled, as MonthRates draws them for a viewer: still readable and focusable.
	await expect(v.getByLabel('Max rate of transfer 1 in Nov, m³/s', { exact: true })).toHaveAttribute('readonly', '');
});

test('empty states: no rules yet offers Add transfer; fewer than two hydrological units points to the Network', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Transfers empty');
	const model = sampleModel();
	model.transfers = [];
	await putModel(page.request, project.id, model);
	await openTransfers(page, project.id);
	await expect(header(page).getByTestId('section-context')).toHaveText('No transfer rules yet');
	await expect(page.getByText('No transfer rules.', { exact: true })).toBeVisible();
	await expect(header(page).getByRole('link', { name: 'Show on the map' })).toHaveCount(0);
	// The empty card's button adds the first rule, as the header's does.
	await rulesCard(page).getByRole('button', { name: 'Add transfer', exact: true }).click();
	await expect(page.getByLabel('Source of transfer 1', { exact: true })).toBeFocused();

	const lone = await createProject(page.request, 'Transfers one unit');
	await putModel(page.request, lone.id, { ...sampleModel(), nodes: sampleModel().nodes.slice(0, 1), cropAreas: [], transfers: [] });
	await openTransfers(page, lone.id);
	await expect(rulesCard(page).getByRole('link', { name: 'Network tab' })).toHaveAttribute('href', '?tab=network');
	await expect(page.getByRole('button', { name: /Add transfer/ })).toHaveCount(0);
});

test('the Transfers grid on the Network keeps its own Add transfer', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Transfers grid');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=network&grid=transfers`);
	const grid = page.getByRole('dialog', { name: 'Transfers' });
	await expect(grid.getByLabel('transfer 1 enabled', { exact: true })).toBeChecked();
	await expect(grid.getByRole('button', { name: '+ Add transfer', exact: true })).toBeVisible();
	await grid.getByRole('button', { name: '+ Add transfer', exact: true }).click();
	await expect(grid.getByLabel('Source of transfer 2', { exact: true })).toBeFocused();
});

test.describe('no accessibility violations', () => {
	for (const [label, viewport] of [
		['desktop', { width: 1440, height: 960 }],
		['phone', { width: 390, height: 844 }]
	] as const) {
		test(label, async ({ page, owner }) => {
			void owner;
			await page.setViewportSize(viewport);
			const project = await createProject(page.request, `Transfers a11y ${label}`);
			const model = sampleModel();
			model.transfers.push({ ...model.transfers[0]!, id: crypto.randomUUID(), months: [6, 7, 8], dailyCapM3: 500, enabled: false, priority: 1 });
			// A river off-take too (engine 1.14.0), so its fields are scanned.
			model.transfers.push({ ...model.transfers[0]!, id: crypto.randomUUID(), priority: 2, source: 'river', handsOffM3Day: 100, lossPct: 0.1, sizing: 'capacity' });
			await putModel(page.request, project.id, model);
			await openTransfers(page, project.id);
			await expect(page.getByLabel('Source of transfer 2', { exact: true })).toBeVisible();
			if (label === 'phone') {
				// Each rule a card; the page scrolls, not a box inside it, and nothing is wider than the screen.
				await expect(page.getByRole('heading', { level: 3, name: 'Transfer 1', exact: true })).toBeVisible();
				await expect(page.getByRole('heading', { level: 3, name: 'Transfer 2 off', exact: true })).toBeVisible();
				const wrap = await rulesListBox(page);
				expect(wrap.sh).toBeLessThanOrEqual(wrap.ch);
				await expectNoSidewaysScroll(page);
			}
			await expectNoViolations(page);
		});
	}
});

/** The sample model plus a river off-take with rates of two sizes and a dam rule switched off. */
function mixedModel() {
	const model = sampleModel();
	const base = model.transfers[0]!;
	base.maxRateM3s = 0.0129;
	model.transfers.push({
		...base,
		id: crypto.randomUUID(),
		months: [10, 11, 12],
		maxRateM3s: 12.345,
		monthlyRateM3s: [0.0129, 12.345, 1.5, 0, 0, 0, 0, 0, 0, 0, 0, 0],
		priority: 1,
		source: 'river',
		handsOffM3Day: 250,
		lossPct: 0.1
	});
	model.transfers.push({ ...base, id: crypto.randomUUID(), months: [6, 7, 8], maxRateM3s: 0.005, dailyCapM3: 500, enabled: false, priority: 2 });
	return model;
}

test('each rule is a card: its groups side by side and top-aligned, its rates whole, an off rule tinted and saying so', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Transfers cards');
	await putModel(page.request, project.id, mixedModel());
	await openTransfers(page, project.id);
	await expect(page.getByTestId('transfer-rule')).toHaveCount(3);

	// Wide, the head is a column on the card's left, level with the rates: the number, From over To, then the
	// switch and Remove, all left of the month fields (a head line across the top made each card ~50 px taller).
	const card = ruleCard(page, 2);
	const title = (await card.getByRole('heading', { level: 3 }).boundingBox())!;
	const from = (await card.getByLabel('Source of transfer 2', { exact: true }).boundingBox())!;
	const to = (await card.getByLabel('Destination of transfer 2', { exact: true }).boundingBox())!;
	const on = (await card.getByLabel('transfer 2 enabled', { exact: true }).boundingBox())!;
	const rm = (await card.getByRole('button', { name: /^Remove transfer 2 / }).boundingBox())!;
	const oct0 = (await card.getByLabel('Max rate of transfer 2 in Oct, m³/s', { exact: true }).boundingBox())!;
	expect(from.y).toBeGreaterThan(title.y + title.height - 1);
	expect(to.y).toBeGreaterThan(from.y + from.height - 1);
	expect(on.y).toBeGreaterThan(to.y + to.height - 1);
	expect(Math.abs(rm.y + rm.height / 2 - (on.y + on.height / 2))).toBeLessThan(8);
	for (const b of [title, from, to, on, rm]) expect(b.x + b.width).toBeLessThan(oct0.x);
	// Rates, limits and source side by side, each group starting on the same line (nothing floats mid-card).
	const tops = await card.locator('.grp').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
	expect(tops).toHaveLength(3);
	expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1);
	const cap = (await card.getByLabel('Daily cap of transfer 2, m³', { exact: true }).boundingBox())!;
	const takes = (await card.getByLabel('Where transfer 2 takes its water', { exact: true }).boundingBox())!;
	const oct = (await card.getByLabel('Max rate of transfer 2 in Oct, m³/s', { exact: true }).boundingBox())!;
	expect(cap.x).toBeGreaterThan(oct.x);
	expect(takes.x).toBeGreaterThan(cap.x);
	// The off-take's fields are a grid of two, not one tall column: Hands-off flow beside Losses.
	const handsOff = (await card.getByLabel('Hands-off flow for transfer 2, m³/day', { exact: true }).boundingBox())!;
	const losses = (await card.getByLabel('Conveyance losses of transfer 2, %', { exact: true }).boundingBox())!;
	expect(Math.abs(handsOff.y - losses.y)).toBeLessThan(1);
	// Every month's field shows its rate whole (0.0129 and 12.345 were clipped in the old table).
	for (const m of ['Oct', 'Nov', 'Dec']) {
		const f = card.getByLabel(`Max rate of transfer 2 in ${m}, m³/s`, { exact: true });
		expect(await f.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
	}
	await expect(card.getByLabel('Max rate of transfer 2 in Nov, m³/s', { exact: true })).toHaveValue('12.345');
	// The off rule: "off" in its heading, "Off" beside its switch, and a tinted card.
	await expect(ruleCard(page, 3).getByRole('heading', { level: 3 })).toHaveText('Transfer 3 off');
	await expect(ruleCard(page, 3).locator('.switch')).toHaveText('Off');
	const bg = (n: number) => ruleCard(page, n).evaluate((el) => getComputedStyle(el).backgroundColor);
	expect(await bg(3)).not.toBe(await bg(1));
	// The shortcut says the rate it copies (0.0129, not a rounded 0.013).
	await expect(ruleCard(page, 1).getByRole('button', { name: '0.0129 in every month', exact: true })).toBeVisible();
	// So does the summary under the months: the top rate to four decimals, not rounded to 0.013.
	await expect(ruleCard(page, 1)).toContainText('up to 0.0129 m³/s');
	await expect(card).toContainText('up to 12.345 m³/s');
	await expectNoSidewaysScroll(page);
});

test('Remove asks first for a rule with rates, not for a blank one, and focus moves on to the next rule', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Transfers remove');
	await putModel(page.request, project.id, mixedModel());
	await openTransfers(page, project.id);
	const remove = (n: number) => page.getByRole('button', { name: new RegExp(`^Remove transfer ${n} \\(`) });
	// Cancel keeps it.
	await remove(1).click();
	await answerConfirm(page, false, 'Remove transfer 1?');
	await expect(page.getByTestId('transfer-rule')).toHaveCount(3);
	// Confirmed, it goes, the rules renumber and the next rule's heading takes the focus.
	await remove(1).click();
	await answerConfirm(page, true, 'Discard on the save bar');
	await expect(page.getByTestId('transfer-rule')).toHaveCount(2);
	await expect(header(page).getByTestId('section-context')).toHaveText('2 transfer rules · 1 active');
	await expect(page.getByRole('heading', { level: 3, name: 'Transfer 1', exact: true })).toBeFocused();
	await expect(page.getByLabel('Where transfer 1 takes its water', { exact: true })).toHaveValue('river');
	await expect(saveBar(page)).toBeVisible();
	// A rule with no rate yet goes at once.
	await header(page).getByRole('button', { name: '+ Add transfer', exact: true }).click();
	await remove(3).click();
	await expect(page.getByRole('alertdialog')).toHaveCount(0);
	await expect(page.getByTestId('transfer-rule')).toHaveCount(2);
	// The last rule gone, focus goes to the one before it.
	await expect(page.getByRole('heading', { level: 3, name: 'Transfer 2 off', exact: true })).toBeFocused();
});

test('on a phone each card stacks: From and To full width, month rates four to a row and whole, fields tap-sized', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 390, height: 844 });
	const project = await createProject(page.request, 'Transfers phone cards');
	await putModel(page.request, project.id, mixedModel());
	await openTransfers(page, project.id);
	const card = ruleCard(page, 2);
	const from = (await card.getByLabel('Source of transfer 2', { exact: true }).boundingBox())!;
	const to = (await card.getByLabel('Destination of transfer 2', { exact: true }).boundingBox())!;
	expect(to.y).toBeGreaterThan(from.y + from.height - 1);
	// Four months to a row: Feb starts the second row, under Oct.
	const oct = (await card.getByLabel('Max rate of transfer 2 in Oct, m³/s', { exact: true }).boundingBox())!;
	const feb = (await card.getByLabel('Max rate of transfer 2 in Feb, m³/s', { exact: true }).boundingBox())!;
	expect(Math.abs(feb.x - oct.x)).toBeLessThan(1);
	expect(feb.y).toBeGreaterThan(oct.y + oct.height - 1);
	for (const m of ['Oct', 'Nov']) {
		const f = card.getByLabel(`Max rate of transfer 2 in ${m}, m³/s`, { exact: true });
		expect(await f.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
		expect((await f.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	}
	for (const el of [card.getByLabel('transfer 2 enabled', { exact: true }), card.getByRole('button', { name: /^Remove transfer 2 / }), card.getByLabel('Where transfer 2 takes its water', { exact: true })])
		expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	// The source's selects take the card's width, so "The river (an off-take)" shows whole.
	expect(await card.getByLabel('Where transfer 2 takes its water', { exact: true }).evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(250);
	await expectNoSidewaysScroll(page);
});
