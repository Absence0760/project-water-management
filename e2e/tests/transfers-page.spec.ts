// The Transfers page (?tab=transfers, issue #17 option A): the section header carries the count, Show on the map
// and + Add transfer; the rules table, then "When water moves" (each month's enabled rules and the most they can
// move in a day). From 1100 × 620 the two cards fill the window and the rules scroll inside theirs; on a phone
// each rule is a card and the page scrolls. Synthetic data only.
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, putModel, sampleModel } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { saveModelChanges } from '../support/network.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { monthsCard, monthSentences, openTransfers, rulesCard, seedManyTransfers } from '../support/transfers.ts';

const header = (page: import('@playwright/test').Page) => page.getByTestId('section-header');
const saveBar = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Unsaved model changes' });

test('the header carries the count and the actions; When water moves adds up the enabled rules by month', async ({ page, owner }) => {
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

	// The sample rule runs Nov–Feb at 0.01 m³/s: 864 m³ a day in each of those months, nothing in the others.
	const sentences = await monthSentences(page);
	expect(sentences).toHaveLength(12);
	expect(sentences[0]).toBe('Oct: no rule runs');
	expect(sentences.slice(1, 5)).toEqual(['Nov', 'Dec', 'Jan', 'Feb'].map((m) => `${m}: 1 rule, up to 864 m³ a day`));

	// The two cards reach the window's bottom and the page doesn't scroll; the rules come first.
	const rules = (await rulesCard(page).boundingBox())!;
	const months = (await monthsCard(page).boundingBox())!;
	expect(months.y).toBeGreaterThan(rules.y + rules.height - 1);
	expect(months.y + months.height).toBeLessThanOrEqual(960);
	expect(months.y + months.height).toBeGreaterThan(960 - 40);
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
	await expect.poll(async () => (await monthSentences(page))[0]).toBe('Oct: 1 rule, up to 1\u202f728 m³ a day');
	await expect(page.getByRole('group', { name: /^Max rate of transfer 2 by month/ })).toContainText('Oct, up to 0.02 m³/s');
	// Switching the first rule off takes it out of the months.
	await page.getByLabel('transfer 1 enabled', { exact: true }).uncheck();
	await expect(header(page).getByTestId('section-context')).toHaveText('2 transfer rules · 1 active');
	await expect.poll(async () => (await monthSentences(page))[1]).toBe('Nov: no rule runs');

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
	const sentences = await monthSentences(page);
	expect(sentences.slice(1, 7)).toEqual(['Nov: 1 rule, up to 864 m³ a day', 'Dec: 1 rule, up to 864 m³ a day', 'Jan: 1 rule, up to 864 m³ a day', 'Feb: 1 rule, up to 432 m³ a day', 'Mar: 1 rule, up to 432 m³ a day', 'Apr: no rule runs']);
	// Clearing a month turns it off.
	await rate('Nov').fill('');
	await rate('Nov').press('Tab');
	await expect.poll(async () => (await monthSentences(page))[1]).toBe('Nov: no rule runs');
	// The button puts the largest rate in every month.
	await page.getByRole('button', { name: '0.01 in every month', exact: true }).click();
	for (const m of ['Oct', 'Nov', 'Apr', 'Sep']) await expect(rate(m)).toHaveValue('0.01');
	// The page has taken the save in (the bar goes once the editor holds what the server returned), so the
	// reload leaves a saved page, not one still mid-save behind its unsaved-changes guard.
	await saveModelChanges(page);
	await expect(saveBar(page)).toBeHidden();
	await page.reload();
	await expect(rate('Sep')).toHaveValue('0.01');
	await expect.poll(async () => (await monthSentences(page))[11]).toBe('Sep: 1 rule, up to 864 m³ a day');
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
	await expect(page.getByLabel('How much transfer 1 takes', { exact: true })).toHaveValue('capacity');
	await expect(page.getByLabel('transfer 1 leaves the EWR in the river', { exact: true })).toBeChecked();
	await expect(page.getByLabel('transfer 1 tops up the destination’s dam', { exact: true })).not.toBeChecked();
	await expectNoSidewaysScroll(page);
});

test('thirty rules scroll inside their card at 1440 and 1280; the page does not scroll either way', async ({ page, owner }) => {
	void owner;
	const project = await seedManyTransfers(page.request, 'Transfers big');
	for (const [width, height] of [
		[1440, 960],
		[1280, 800]
	] as const) {
		await page.setViewportSize({ width, height });
		await openTransfers(page, project.id);
		await expect(page.getByLabel('Source of transfer 30', { exact: true })).toBeAttached();
		await expect(header(page).getByTestId('section-context')).toHaveText('30 transfer rules · 25 active');
		const wrap = rulesCard(page).locator('.table-wrap');
		const box = await wrap.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, sw: el.scrollWidth, cw: el.clientWidth }));
		expect(box.sh).toBeGreaterThan(box.ch);
		// Every column fits: no scrolling the table sideways to reach Priority, On or Remove.
		expect(box.sw).toBeLessThanOrEqual(box.cw);
		await expect(page.getByRole('button', { name: /^Remove transfer 1 / })).toBeInViewport();
		// Five rules are off, each saying so by its number.
		await expect(page.getByRole('rowheader', { name: /^\d+ off$/ })).toHaveCount(5);
		// When water moves stays on the first screen.
		const months = (await monthsCard(page).boundingBox())!;
		expect(months.y + months.height).toBeLessThanOrEqual(height);
		expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(height);
		await expectNoSidewaysScroll(page);
	}
	await expectNoViolations(page);
});

test('a viewer sees every rule and the months, with nothing to change', async ({ page, owner, signIn }) => {
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
	await expect(monthsCard(v).getByRole('listitem')).toHaveCount(12);
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
	await expect(monthsCard(page)).toHaveCount(0);
	await expect(header(page).getByRole('link', { name: 'Show on the map' })).toHaveCount(0);
	// The empty card's button adds the first rule, as the header's does.
	await rulesCard(page).getByRole('button', { name: 'Add transfer', exact: true }).click();
	await expect(page.getByLabel('Source of transfer 1', { exact: true })).toBeFocused();
	await expect(monthsCard(page)).toBeVisible();

	const lone = await createProject(page.request, 'Transfers one unit');
	await putModel(page.request, lone.id, { ...sampleModel(), nodes: sampleModel().nodes.slice(0, 1), cropAreas: [], transfers: [] });
	await openTransfers(page, lone.id);
	await expect(rulesCard(page).getByRole('link', { name: 'Network tab' })).toHaveAttribute('href', '?tab=network');
	await expect(page.getByRole('button', { name: /Add transfer/ })).toHaveCount(0);
});

test('the Transfers grid on the Network keeps its own Add transfer and no months card', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Transfers grid');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=network&grid=transfers`);
	const grid = page.getByRole('dialog', { name: 'Transfers' });
	await expect(grid.getByLabel('transfer 1 enabled', { exact: true })).toBeChecked();
	await expect(grid.getByRole('button', { name: '+ Add transfer', exact: true })).toBeVisible();
	await expect(grid.getByRole('region', { name: 'When water moves' })).toHaveCount(0);
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
				await expect(page.getByRole('rowheader', { name: 'Transfer 1', exact: true })).toBeVisible();
				await expect(page.getByRole('rowheader', { name: 'Transfer 2 off', exact: true })).toBeVisible();
				const wrap = await rulesCard(page).locator('.table-wrap').evaluate((el) => el.scrollHeight - el.clientHeight);
				expect(wrap).toBeLessThanOrEqual(1);
				expect((await monthsCard(page).boundingBox())!.y).toBeGreaterThan((await rulesCard(page).boundingBox())!.y);
				await expectNoSidewaysScroll(page);
			}
			await expectNoViolations(page);
		});
	}
});
