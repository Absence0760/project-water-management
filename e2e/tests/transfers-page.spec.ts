// The Transfers page (?tab=transfers, issue #17 option A): the section header carries the count, Show on the Network
// and + Add transfer; under it one card per rule (a head line with its number, From → To, an Enabled switch and
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
	await expect(header(page).getByRole('link', { name: 'Show on the Network', exact: true })).toHaveAttribute('href', '?tab=network');
	await expect(header(page).getByRole('button', { name: '+ Add transfer', exact: true })).toBeVisible();
	// Runs start only from Runs & results, where they can be named.
	await expect(header(page).getByRole('button', { name: 'Run model', exact: true })).toHaveCount(0);
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
	await expect(page.getByLabel('From, transfer 2', { exact: true })).toBeFocused();
	await expect(header(page).getByTestId('section-context')).toHaveText('2 transfer rules · 2 active');
	// Each month has its own rate (engine 1.14.0): October at 0.02 m³/s, the rest blank (off).
	await page.getByLabel('Max rate of transfer 2 in Oct, m³/s', { exact: true }).fill('0.02');
	await page.getByLabel('Max rate of transfer 2 in Oct, m³/s', { exact: true }).press('Tab');
	// Tab moves on to the next month's field.
	await expect(page.getByLabel('Max rate of transfer 2 in Nov, m³/s', { exact: true })).toBeFocused();
	await expect(page.getByRole('group', { name: /^Max rate of transfer 2 by month/ })).toContainText('Oct, up to 0.02 m³/s');
	// Switching the first rule off says so in its heading and in the header's count; the switch's word is its label.
	await page.getByLabel('Enabled, transfer 1', { exact: true }).uncheck();
	await expect(header(page).getByTestId('section-context')).toHaveText('2 transfer rules · 1 active');
	await expect(page.getByRole('heading', { level: 3, name: 'Transfer 1 off', exact: true })).toBeVisible();
	await expect(ruleCard(page, 1).locator('.switch')).toHaveText('Enabled');
	await expect(ruleCard(page, 2).getByLabel('Enabled, transfer 2', { exact: true })).toBeChecked();

	await saveModelChanges(page);
	await expect(saveBar(page)).toBeHidden();
	await page.reload();
	await expect(page.getByLabel('Max rate of transfer 2 in Oct, m³/s', { exact: true })).toHaveValue('0.02');
	await expect(page.getByLabel('Max rate of transfer 2 in Nov, m³/s', { exact: true })).toHaveValue('');
	await expect(page.getByLabel('Enabled, transfer 1', { exact: true })).not.toBeChecked();
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
	const takes = page.getByLabel('Takes from, transfer 1', { exact: true });
	await expect(takes).toHaveValue('dam');
	await expect(page.getByLabel('Min source storage of transfer 1, %', { exact: true })).toBeVisible();
	await takes.selectOption('river');
	// The dam's minimum gives way to the off-take's own fields.
	await expect(page.getByLabel('Min source storage of transfer 1, %', { exact: true })).toHaveCount(0);
	await page.getByLabel('Hands-off flow for transfer 1, m³/day', { exact: true }).fill('250');
	await page.getByLabel('Losses on the way of transfer 1, %', { exact: true }).fill('10');
	// Canal seepage back to the river (engine 1.42.0): where it rejoins shows once a share is set, the source by default.
	const rejoins = page.getByLabel('Rejoins the river below, transfer 1', { exact: true });
	await expect(rejoins).toHaveCount(0);
	await page.getByLabel('Losses seeping back of transfer 1, %', { exact: true }).fill('40');
	await expect(rejoins).toHaveValue('');
	await page.getByLabel('Takes, transfer 1', { exact: true }).selectOption('capacity');
	await page.getByLabel('Leaves the EWR in the river, transfer 1', { exact: true }).check();
	// The page has taken the save in (the bar goes once the editor holds what the server returned), so the
	// reload leaves a saved page, not one still mid-save behind its unsaved-changes guard.
	await saveModelChanges(page);
	await expect(saveBar(page)).toBeHidden();
	await page.reload();
	await expect(page.getByLabel('Takes from, transfer 1', { exact: true })).toHaveValue('river');
	await expect(page.getByLabel('Hands-off flow for transfer 1, m³/day', { exact: true })).toHaveValue('250');
	await expect(page.getByLabel('Losses on the way of transfer 1, %', { exact: true })).toHaveValue('10');
	await expect(page.getByLabel('Losses seeping back of transfer 1, %', { exact: true })).toHaveValue('40');
	await expect(page.getByLabel('Rejoins the river below, transfer 1', { exact: true })).toHaveValue('');
	await expect(page.getByLabel('Takes, transfer 1', { exact: true })).toHaveValue('capacity');
	await expect(page.getByLabel('Leaves the EWR in the river, transfer 1', { exact: true })).toBeChecked();
	await expect(page.getByLabel('Tops up the destination’s dam, transfer 1', { exact: true })).not.toBeChecked();
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
		await expect(page.getByLabel('From, transfer 30', { exact: true })).toBeAttached();
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
	await expect(v.getByLabel('From, transfer 1', { exact: true })).toBeDisabled();
	await expect(v.getByLabel('Enabled, transfer 1', { exact: true })).toBeDisabled();
	await expect(v.getByRole('button', { name: /Add transfer/ })).toHaveCount(0);
	await expect(v.getByRole('button', { name: /^Remove transfer/ })).toHaveCount(0);
	await expect(v.getByRole('button', { name: 'All', exact: true })).toHaveCount(0);
	await expect(header(v).getByRole('link', { name: 'Show on the Network', exact: true })).toBeVisible();
	await expect(v.getByLabel('Max rate of transfer 1 in Nov, m³/s', { exact: true })).toHaveValue('0.01');
	// Read-only rather than disabled, as MonthRates draws them for a viewer: still readable and focusable.
	await expect(v.getByLabel('Max rate of transfer 1 in Nov, m³/s', { exact: true })).toHaveAttribute('readonly', '');

	// A catchment with too few units to have any: the viewer is told so, not asked to add units.
	const lone = await createProject(page.request, 'Transfers viewer one unit');
	await putModel(page.request, lone.id, { ...sampleModel(), nodes: sampleModel().nodes.slice(0, 2), cropAreas: [], transfers: [] });
	await addMember(page.request, lone.id, viewer.user.email, 'viewer');
	await v.goto(`/projects/${lone.id}?tab=transfers`);
	await expect(rulesCard(v)).toHaveText('This catchment has fewer than two hydrological units, so it has no transfers.');
	await expect(rulesCard(v).getByRole('link')).toHaveCount(0);
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
	await expect(header(page).getByRole('link', { name: 'Show on the Network' })).toHaveCount(0);
	// The empty card's button adds the first rule, as the header's does.
	await rulesCard(page).getByRole('button', { name: 'Add transfer', exact: true }).click();
	await expect(page.getByLabel('From, transfer 1', { exact: true })).toBeFocused();

	// The outflow gauge and one unit: two nodes, but a gauge can't take part, so no rule is possible.
	const lone = await createProject(page.request, 'Transfers one unit');
	await putModel(page.request, lone.id, { ...sampleModel(), nodes: sampleModel().nodes.slice(0, 2), cropAreas: [], transfers: [] });
	await openTransfers(page, lone.id);
	await expect(rulesCard(page)).toContainText('Transfers need at least two hydrological units');
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
	await expect(grid.getByLabel('Enabled, transfer 1', { exact: true })).toBeChecked();
	// One heading per modal: the title, then each rule's own; no "Transfer rules" under it.
	await expect(grid.getByRole('heading', { level: 2 })).toHaveText(['Transfers']);
	await expect(grid.getByRole('button', { name: '+ Add transfer', exact: true })).toBeVisible();
	await grid.getByRole('button', { name: '+ Add transfer', exact: true }).click();
	await expect(grid.getByLabel('From, transfer 2', { exact: true })).toBeFocused();
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
			await expect(page.getByLabel('From, transfer 2', { exact: true })).toBeVisible();
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
	const from = (await card.getByLabel('From, transfer 2', { exact: true }).boundingBox())!;
	const to = (await card.getByLabel('To, transfer 2', { exact: true }).boundingBox())!;
	const on = (await card.getByLabel('Enabled, transfer 2', { exact: true }).boundingBox())!;
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
	const takes = (await card.getByLabel('Takes from, transfer 2', { exact: true }).boundingBox())!;
	const oct = (await card.getByLabel('Max rate of transfer 2 in Oct, m³/s', { exact: true }).boundingBox())!;
	expect(cap.x).toBeGreaterThan(oct.x);
	expect(takes.x).toBeGreaterThan(cap.x);
	// The off-take's fields are a grid of two, not one tall column: Hands-off flow beside Losses.
	const handsOff = (await card.getByLabel('Hands-off flow for transfer 2, m³/day', { exact: true }).boundingBox())!;
	const losses = (await card.getByLabel('Losses on the way of transfer 2, %', { exact: true }).boundingBox())!;
	expect(Math.abs(handsOff.y - losses.y)).toBeLessThan(1);
	// Every month's field shows its rate whole (0.0129 and 12.345 were clipped in the old table).
	for (const m of ['Oct', 'Nov', 'Dec']) {
		const f = card.getByLabel(`Max rate of transfer 2 in ${m}, m³/s`, { exact: true });
		expect(await f.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
	}
	await expect(card.getByLabel('Max rate of transfer 2 in Nov, m³/s', { exact: true })).toHaveValue('12.345');
	// The off rule: "off" in its heading, its switch off, and a tinted card.
	await expect(ruleCard(page, 3).getByRole('heading', { level: 3 })).toHaveText('Transfer 3 off');
	await expect(ruleCard(page, 3).getByLabel('Enabled, transfer 3', { exact: true })).not.toBeChecked();
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
	await answerConfirm(page, true, 'its monthly rates, limits and source settings go with it');
	await expect(page.getByTestId('transfer-rule')).toHaveCount(2);
	await expect(header(page).getByTestId('section-context')).toHaveText('2 transfer rules · 1 active');
	await expect(page.getByRole('heading', { level: 3, name: 'Transfer 1', exact: true })).toBeFocused();
	await expect(page.getByLabel('Takes from, transfer 1', { exact: true })).toHaveValue('river');
	await expect(saveBar(page)).toBeVisible();
	// A rule with no rate but other settings (an off-take's hands-off flow) asks too: they would go with it.
	await header(page).getByRole('button', { name: '+ Add transfer', exact: true }).click();
	await page.getByLabel('Takes from, transfer 3', { exact: true }).selectOption('river');
	await page.getByLabel('Hands-off flow for transfer 3, m³/day', { exact: true }).fill('250');
	await remove(3).click();
	await answerConfirm(page, false, 'Remove transfer 3?');
	await expect(page.getByTestId('transfer-rule')).toHaveCount(3);
	await remove(3).click();
	await answerConfirm(page, true);
	await expect(page.getByTestId('transfer-rule')).toHaveCount(2);
	// A rule as + Add transfer made it goes at once.
	await header(page).getByRole('button', { name: '+ Add transfer', exact: true }).click();
	await remove(3).click();
	await expect(page.getByRole('alertdialog')).toHaveCount(0);
	await expect(page.getByTestId('transfer-rule')).toHaveCount(2);
	// The last rule gone, focus goes to the one before it.
	await expect(page.getByRole('heading', { level: 3, name: 'Transfer 2 off', exact: true })).toBeFocused();
});

test('From and To offer hydrological units only; a saved gauge end stays, named so, and is a problem', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Transfers units only');
	const model = sampleModel();
	await putModel(page.request, project.id, model);
	await openTransfers(page, project.id);
	const from = page.getByLabel('From, transfer 1', { exact: true });
	await expect(from.locator('option')).toHaveText(['Upper farm', 'Lower farm']);
	// + Add transfer starts between the first two units, never the outflow gauge first in the list.
	await header(page).getByRole('button', { name: '+ Add transfer', exact: true }).click();
	await expect(page.getByLabel('From, transfer 2', { exact: true }).locator('option:checked')).toHaveText('Upper farm');
	await expect(page.getByLabel('To, transfer 2', { exact: true }).locator('option:checked')).toHaveText('Lower farm');

	// A rule saved (by an older version) from the gauge: shown as it is, and refused until it is changed.
	const gaugeRule = await createProject(page.request, 'Transfers gauge end');
	const g = sampleModel();
	g.transfers[0]!.fromNodeId = g.nodes[0]!.id;
	await putModel(page.request, gaugeRule.id, g);
	await openTransfers(page, gaugeRule.id);
	await expect(page.getByLabel('From, transfer 1', { exact: true }).locator('option:checked')).toHaveText('Outflow gauge (not a hydrological unit)');
	await page.getByLabel('Daily cap of transfer 1, m³', { exact: true }).fill('500');
	await page.getByLabel('Daily cap of transfer 1, m³', { exact: true }).blur();
	await expect(ruleCard(page, 1)).toContainText('"Outflow gauge" is a gauge, which can\'t send or receive water; choose a hydrological unit.');
	await expect(page.getByRole('region', { name: 'Unsaved model changes' }).getByRole('button', { name: 'Save changes' })).toBeDisabled();
	await page.getByLabel('From, transfer 1', { exact: true }).selectOption({ label: 'Upper farm' });
	await expect(ruleCard(page, 1)).not.toContainText('is a gauge');
});

test('every field’s name starts with its visible label, has an ⓘ, and large volumes show separators', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Transfers labels');
	const model = sampleModel();
	Object.assign(model.transfers[0]!, { source: 'river', dailyCapM3: 250000, handsOffM3Day: 12000, lossPct: 0.1, lossReturnPct: 0.2 });
	await putModel(page.request, project.id, model);
	await openTransfers(page, project.id);
	const card = ruleCard(page, 1);
	// Label in name (WCAG 2.5.3): each visible label, then the rule.
	for (const [word, name] of [
		['From', 'From, transfer 1'],
		['To', 'To, transfer 1'],
		['Enabled', 'Enabled, transfer 1'],
		['Daily cap, m³', 'Daily cap of transfer 1, m³'],
		['Takes from', 'Takes from, transfer 1'],
		['Takes', 'Takes, transfer 1'],
		['Hands-off flow, m³/day', 'Hands-off flow for transfer 1, m³/day'],
		['Losses on the way, %', 'Losses on the way of transfer 1, %'],
		['Losses seeping back, %', 'Losses seeping back of transfer 1, %'],
		['Rejoins the river below', 'Rejoins the river below, transfer 1'],
		['Leaves the EWR in the river', 'Leaves the EWR in the river, transfer 1'],
		['Tops up the destination’s dam', 'Tops up the destination’s dam, transfer 1']
	] as const) {
		await expect(card.getByLabel(name, { exact: true }), name).toBeVisible();
		await expect(card.getByText(word, { exact: true }).first(), word).toBeVisible();
		// The words the label shows, minus its unit, start the name.
		expect(name.toLowerCase().startsWith(word.split(',')[0]!.toLowerCase()), name).toBe(true);
	}
	// Every field label in the river rule's groups carries its ⓘ.
	const labels = card.locator('.g-limits .fld-l, .g-source .fld-l, .g-source .check-row');
	const n = await labels.count();
	expect(n).toBeGreaterThanOrEqual(9);
	for (let i = 0; i < n; i++) await expect(labels.nth(i).locator('.helptip'), `label ${i}`).toHaveCount(1);
	// Volumes group their thousands, as the node sheet does.
	await expect(card.getByLabel('Daily cap of transfer 1, m³', { exact: true })).toHaveValue('250\u202f000');
	await expect(card.getByLabel('Hands-off flow for transfer 1, m³/day', { exact: true })).toHaveValue('12\u202f000');
});

test('on a phone each card stacks: From and To full width, month rates four to a row and whole, fields tap-sized', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 390, height: 844 });
	const project = await createProject(page.request, 'Transfers phone cards');
	await putModel(page.request, project.id, mixedModel());
	await openTransfers(page, project.id);
	const card = ruleCard(page, 2);
	const from = (await card.getByLabel('From, transfer 2', { exact: true }).boundingBox())!;
	const to = (await card.getByLabel('To, transfer 2', { exact: true }).boundingBox())!;
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
	for (const el of [card.getByLabel('Enabled, transfer 2', { exact: true }), card.getByRole('button', { name: /^Remove transfer 2 / }), card.getByLabel('Takes from, transfer 2', { exact: true })])
		expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	// The source's selects take the card's width, so "The river (an off-take)" shows whole.
	expect(await card.getByLabel('Takes from, transfer 2', { exact: true }).evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(250);
	await expectNoSidewaysScroll(page);
});
