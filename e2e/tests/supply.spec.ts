// A farm's supply rule and river pump in the node form (roadmap WP-3.8, issue
// #54 item 2c, docs/model.md §2.7e): set a farm to river first with 2 pumps ×
// 25 m³/h, save, reload and read back 1,200 m³/day; and see run of river on a
// farm with a dam blocked with the message the save would be refused with.
// And the hands-off flow and River to dam by month (engine 1.32.0, issue #204,
// §2.7h): set, saved, reloaded and read back; their month fields show 12 345.5
// and 0.0129 whole for an owner and a viewer, desktop and phone (ui-playbook
// § 2); and a farm turned into a gauge clears River to dam by month beside
// the alert that refuses it. The node table shows River to dam set by month
// read-only and links to the node's form.
import type { Locator, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, putModel, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openNodeForm, saveModelChanges } from '../support/network.ts';

const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });
const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];

/**
 * All twelve fields of a month group are visible with their value whole
 * (scrollWidth ≤ clientWidth), and nothing sits past the group's right edge:
 * the months wrap, they never scroll sideways.
 */
async function expectMonthsWhole(group: Locator, name: (m: string) => string) {
	for (const m of MONTHS) {
		const f = group.getByLabel(name(m), { exact: true });
		await expect(f).toBeVisible();
		expect(await f.evaluate((el) => el.scrollWidth <= el.clientWidth), `${name(m)} shows its value whole`).toBe(true);
	}
	const fits = await group.evaluate((g) => {
		const right = g.getBoundingClientRect().right;
		return g.scrollWidth <= g.clientWidth && [...g.querySelectorAll('input')].every((i) => i.getBoundingClientRect().right <= right + 0.5);
	});
	expect(fits, 'no month field past the group’s edge').toBe(true);
}

async function openUpperFarm(page: Page) {
	const sheet = await openNodeForm(page);
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '2. Upper farm · hydrological unit' });
	return { sheet, supply: sheet.getByRole('group', { name: 'Supply', exact: true }), routing: sheet.getByRole('group', { name: 'Routing', exact: true }) };
}

test('river first with 2 pumps × 25 m³/h saves 1,200 m³/day; run of river with a dam is blocked', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Supply rule');
	await page.goto(`/projects/${project.id}?tab=network`);
	const { supply } = await openUpperFarm(page);

	// The default: the dam only, no pump fields.
	await expect(supply.getByLabel('Supply rule', { exact: true })).toHaveValue('damFirst');
	await expect(supply.getByLabel('River pump capacity (m³/day)')).toHaveCount(0);

	await supply.getByLabel('Supply rule', { exact: true }).selectOption({ label: 'River first' });
	await expect(supply.getByTestId('pump-note')).toHaveText('Blank is no limit: the pump takes whatever the river offers, and the run warns.');
	await supply.getByLabel('Number of pumps').fill('2');
	await supply.getByLabel('m³/h per pump').fill('25');
	await expect(supply.getByTestId('pump-note')).toHaveText('2 × 25 m³/h × 24 h = 1\u202f200 m³/day.');
	await expect(supply.getByLabel('River pump capacity (m³/day)')).toHaveValue('1\u202f200');
	// Trigger levels belong to the trigger rule only.
	await expect(supply.getByLabel('Switch to river below (% of dam)')).toHaveCount(0);
	await expectNoViolations(page, { include: '[data-testid^="supply-"]' });
	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);

	await page.reload();
	const { sheet, supply: again } = await openUpperFarm(page);
	await expect(again.getByLabel('Supply rule', { exact: true })).toHaveValue('riverFirst');
	await expect(again.getByLabel('River pump capacity (m³/day)')).toHaveValue('1\u202f200');

	// Run of river has no dam: with Upper farm's 150 000 m³ dam the form says so and Save stays off.
	await again.getByLabel('Supply rule', { exact: true }).selectOption({ label: 'Run of river' });
	await expect(again.getByRole('alert')).toHaveText('Run of river has no dam; set the dam capacity to 0 or pick another supply rule.');
	// The field it is about is marked and points at it.
	await expect(again.getByLabel('Supply rule', { exact: true })).toHaveAttribute('aria-invalid', 'true');
	await expect(again.getByLabel('Supply rule', { exact: true })).toHaveAccessibleDescription(/Run of river has no dam/);
	await expect(sheet.getByText('1 problem to fix before saving')).toBeVisible();
	await expect(sheet.getByRole('button', { name: 'Save changes' })).toBeDisabled();

	// The trigger rule shows its two levels; a stop below the trigger is blocked too.
	await again.getByLabel('Supply rule', { exact: true }).selectOption({ label: 'Dam, river when low' });
	await expect(again.getByRole('alert')).toHaveCount(0);
	await again.getByLabel('Back to the dam at (% of dam)').fill('30');
	await expect(again.getByRole('alert')).toHaveText('The switch-back level must be at least the switch-to-river level.');
	for (const level of ['Back to the dam at (% of dam)', 'Switch to river below (% of dam)']) {
		await expect(again.getByLabel(level)).toHaveAttribute('aria-invalid', 'true');
		await expect(again.getByLabel(level)).toHaveAccessibleDescription('The switch-back level must be at least the switch-to-river level.');
	}
	await expect(sheet.getByRole('button', { name: 'Save changes' })).toBeDisabled();
});

test('a hands-off flow by month with the EWR, and River to dam by month, save and read back', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Hands-off flow');
	await page.goto(`/projects/${project.id}?tab=network`);
	const { supply, routing } = await openUpperFarm(page);

	// Off by default: no set flow, the EWR not kept, River to dam one value all year.
	const note = supply.getByTestId('hands-off-note');
	await expect(note).toHaveText('No hands-off flow: the river pump and River to dam leave in the river only what priority water users downstream need, not the EWR.');
	await expect(supply.getByLabel('Hands-off flow of Upper farm in Oct, m³/day')).toHaveCount(0);

	await supply.getByLabel('Leave a set flow in the river, by month').check();
	await supply.getByLabel('Hands-off flow of Upper farm in Oct, m³/day').fill('150');
	await supply.getByRole('button', { name: 'Use October’s flow for every month' }).click();
	await supply.getByLabel('Hands-off flow of Upper farm in Jan, m³/day').fill('250');
	// The help tips sit beside the boxes, so each box's name is its words alone (WCAG 2.5.3).
	await supply.getByRole('checkbox', { name: 'Also leave the EWR in the river', exact: true }).check();
	// On the dam only with no River to dam nothing takes from the river past the dam, so the flow changes nothing.
	await expect(note).toHaveText(
		'Would leave the larger of the set flow (between 150 and 250 m³/day by month) and the EWR required here (this unit’s share and upstream shares) in the river, but it changes nothing here: this hydrological unit takes nothing from the river past its dam (no river pump, no River to dam).'
	);

	// River to dam by month: winter only (May–Sep); the one value is then not used.
	await routing.getByRole('checkbox', { name: 'Set River to dam by month', exact: true }).check();
	await expect(routing.getByLabel('River to dam (m³/s)', { exact: true })).not.toBeEditable();
	await expect(routing.getByText('Not used: River to dam is set by month below.', { exact: true })).toBeVisible();
	for (const m of ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr']) await routing.getByLabel(`River to dam of Upper farm in ${m}, m³/s`).fill('0');
	for (const m of ['May', 'Jun', 'Jul', 'Aug', 'Sep']) await routing.getByLabel(`River to dam of Upper farm in ${m}, m³/s`).fill('0.01');
	await expect(routing.getByTestId('river-to-dam-months-note')).toHaveText('River to dam takes up to 0.01 m³/s; nothing in Oct–Apr. The one value above is not used.');
	// Now River to dam takes from the river, and the note names it alone (there is no river pump).
	await expect(note).toHaveText(
		'Leaves the larger of the set flow (between 150 and 250 m³/day by month) and the EWR required here (this unit’s share and upstream shares) in the river before River to dam takes anything. When less flows, nothing is taken.'
	);
	await expectNoViolations(page, { include: '[data-testid^="supply-"]' });
	await expectNoViolations(page, { include: '[data-testid^="river-to-dam-months-"]' });
	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);

	await page.reload();
	const { supply: s2, routing: r2 } = await openUpperFarm(page);
	await expect(s2.getByLabel('Leave a set flow in the river, by month')).toBeChecked();
	await expect(s2.getByLabel('Hands-off flow of Upper farm in Dec, m³/day')).toHaveValue('150');
	await expect(s2.getByLabel('Hands-off flow of Upper farm in Jan, m³/day')).toHaveValue('250');
	await expect(s2.getByRole('checkbox', { name: 'Also leave the EWR in the river', exact: true })).toBeChecked();
	await expect(r2.getByRole('checkbox', { name: 'Set River to dam by month', exact: true })).toBeChecked();
	await expect(r2.getByLabel('River to dam of Upper farm in Apr, m³/s')).toHaveValue('0');
	await expect(r2.getByLabel('River to dam of Upper farm in Jul, m³/s')).toHaveValue('0.01');

	// Unticked, the one value is back in use and nothing by month is left.
	await r2.getByRole('checkbox', { name: 'Set River to dam by month', exact: true }).uncheck();
	await expect(r2.getByLabel('River to dam (m³/s)', { exact: true })).toBeEditable();
	await expect(r2.getByTestId('river-to-dam-months-note')).toHaveCount(0);
});

test('the month fields show 12 345.5 and 0.0129 whole for an owner and a viewer, desktop and phone', async ({ page, owner, signIn }) => {
	void owner;
	const { id, model } = await seedRunnableProject(page.request, 'Month fields');
	const upper = model.nodes.find((n) => n.name === 'Upper farm')!;
	Object.assign(upper, {
		supplyRule: 'riverFirst',
		pumpCapacityM3Day: 1200,
		handsOffM3Day: [12_345.5, 0.0129, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150],
		handsOffEwr: true,
		// River to dam is stored in m³/day and shown in m³/s: 0.0129 and 12 345.5 m³/s.
		divertMonthlyM3Day: [0.0129 * 86_400, 12_345.5 * 86_400, 1728, 1728, 1728, 1728, 1728, 1728, 1728, 1728, 1728, 1728]
	});
	await putModel(page.request, id, model);
	const viewer = await signIn('Month fields viewer');
	await addMember(page.request, id, viewer.user.email, 'viewer');

	for (const [who, p] of [
		['owner', page],
		['viewer', viewer.page]
	] as const) {
		for (const width of [1280, 390]) {
			await p.setViewportSize({ width, height: 844 });
			await p.goto(`/projects/${id}?tab=network`);
			const { sheet, supply, routing } = await openUpperFarm(p);
			const handsOff = supply.getByRole('group', { name: 'Hands-off flow, m³/day, per month', exact: true });
			const byMonth = routing.getByRole('group', { name: 'River to dam, m³/s, per month', exact: true });
			await expectMonthsWhole(handsOff, (m) => `Hands-off flow of Upper farm in ${m}, m³/day`);
			await expectMonthsWhole(byMonth, (m) => `River to dam of Upper farm in ${m}, m³/s`);
			// An owner edits the plain number; a viewer reads it grouped.
			await expect(handsOff.getByLabel('Hands-off flow of Upper farm in Oct, m³/day')).toHaveValue(who === 'owner' ? '12345.5' : '12\u202f345.5');
			await expect(handsOff.getByLabel('Hands-off flow of Upper farm in Nov, m³/day')).toHaveValue('0.0129');
			await expect(byMonth.getByLabel('River to dam of Upper farm in Nov, m³/s')).toHaveValue(who === 'owner' ? '12345.5' : '12\u202f345.5');
			// The previews write every figure as entered.
			await expect(supply.getByTestId('hands-off-note')).toContainText('between 0.0129 and 12\u202f345.5 m³/day by month');
			await expect(routing.getByTestId('river-to-dam-months-note')).toHaveText('River to dam takes between 0.0129 and 12\u202f345.5 m³/s by month. The one value above is not used.');
			// Nothing in the sheet scrolls sideways, but its section menu, which on a phone is one strip that does (ui.md § Node sheet).
			const scrollers = await sheet.evaluate((d) =>
				[d, ...d.querySelectorAll('*')]
					.filter((el) => !el.closest('[data-testid="node-sheet-jump"]'))
					.filter((el) => ['auto', 'scroll'].includes(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1)
					.map((el) => el.className || el.tagName)
			);
			expect(scrollers).toEqual([]);
			if (who === 'viewer') {
				await expect(supply.getByRole('button', { name: 'Use October’s flow for every month' })).toHaveCount(0);
				await expect(supply.getByRole('checkbox', { name: 'Leave a set flow in the river, by month', exact: true })).toBeDisabled();
			}
			if (width === 390) {
				await expectNoViolations(p, { include: '[data-testid^="supply-"]' });
				await expectNoViolations(p, { include: '[data-testid^="river-to-dam-months-"]' });
			}
		}
	}
});

test('River to dam by month: October’s capacity in every month, and cleared beside the alert on a farm turned into a gauge', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Clear by month');
	await page.goto(`/projects/${project.id}?tab=network`);
	const { sheet, routing } = await openUpperFarm(page);

	await routing.getByRole('checkbox', { name: 'Set River to dam by month', exact: true }).check();
	await routing.getByLabel('River to dam of Upper farm in Oct, m³/s').fill('0.2');
	await routing.getByRole('button', { name: 'Use October’s capacity for every month' }).click();
	for (const m of MONTHS) await expect(routing.getByLabel(`River to dam of Upper farm in ${m}, m³/s`)).toHaveValue('0.2');
	await expect(routing.getByTestId('river-to-dam-months-note')).toHaveText('River to dam takes up to 0.2 m³/s. The one value above is not used.');

	// A gauge can't have it: the Supply section stays with the save rule's alert and, beside it, the way out.
	await sheet.getByLabel('Kind', { exact: true }).selectOption('gauge');
	const supply = sheet.getByRole('group', { name: 'Supply', exact: true });
	const alert = supply.getByRole('alert');
	await expect(alert).toHaveText('Only a hydrological unit has a hands-off flow and River to dam by month; clear them.');
	await supply.getByRole('button', { name: 'Clear River to dam by month' }).click();
	await expect(alert).toHaveCount(0);
	// Nothing left to reset, so a gauge has no Supply section.
	await expect(supply).toHaveCount(0);
});

test('the node table shows River to dam set by month read-only, and links to the node’s form', async ({ page, owner }) => {
	void owner;
	const { id, model } = await seedRunnableProject(page.request, 'Table by month');
	const upper = model.nodes.find((n) => n.name === 'Upper farm')!;
	Object.assign(upper, { divertCapacityM3Day: 400, divertMonthlyM3Day: [0, 0, 0, 0, 0, 0, 0, 864, 864, 864, 864, 864] });
	await putModel(page.request, id, model);

	for (const width of [1280, 390]) {
		await page.setViewportSize({ width, height: 844 });
		await page.goto(`/projects/${id}?tab=network&grid=nodes`);
		const grid = page.getByRole('dialog', { name: 'Hydrological unit table' });
		// The run ignores the one value, so the table has no input for it, only the months' range.
		await expect(grid.getByLabel('River to dam at Upper farm, m³/s', { exact: true })).toHaveCount(0);
		const cell = grid.getByTestId(`divert-by-month-${upper.id}`);
		const link = cell.getByRole('link', { name: 'River to dam at Upper farm is set by month, between 0 and 0.01 m³/s: edit it in the hydrological unit’s form', exact: true });
		await expect(link).toHaveText('by month: 0–0.01');
		// A farm with the one value keeps editing it in the table.
		await expect(grid.getByLabel('River to dam at Lower farm, m³/s', { exact: true })).toBeEditable();
		if (width === 390) {
			await expect(cell.getByText('River to dam m³/s')).toBeVisible(); // the phone card's label
			await expectNoViolations(page, { include: `[data-testid="divert-by-month-${upper.id}"]` });
		}
	}

	await page.getByRole('dialog', { name: 'Hydrological unit table' }).getByTestId(`divert-by-month-${upper.id}`).getByRole('link').click();
	const sheet = page.getByRole('dialog', { name: 'Edit Upper farm' });
	await expect(sheet).toBeVisible();
	await expect(page.getByRole('dialog', { name: 'Hydrological unit table' })).toHaveCount(0);
	await expect(sheet.getByRole('group', { name: 'Routing', exact: true }).getByTestId('river-to-dam-months-note')).toHaveText(
		'River to dam takes up to 0.01 m³/s; nothing in Oct–Apr. The one value above is not used.'
	);
});

test('a dam on the river (Upstream inflow to dam 100 %) has no River to dam; an off-channel one enters it in m³/s', async ({ page, owner }) => {
	void owner;
	const { id, model } = await seedRunnableProject(page.request, 'On the river');
	const upper = model.nodes.find((n) => n.name === 'Upper farm')!;
	Object.assign(upper, { pctUpstreamToDam: 1, divertCapacityM3Day: 17_280 });
	await putModel(page.request, id, model);
	await page.goto(`/projects/${id}?tab=network`);
	const { routing } = await openUpperFarm(page);
	// On the river: the stored 0.2 m³/s stays, read-only, and the run doesn't use it (engine 1.68.0).
	const divert = routing.getByLabel('River to dam (m³/s)', { exact: true });
	await expect(divert).toHaveValue('0.2');
	await expect(divert).not.toBeEditable();
	await expect(routing.getByText(/^Not available: the dam is on the river/)).toBeVisible();
	await expect(routing.getByRole('checkbox', { name: 'Set River to dam by month', exact: true })).toBeDisabled();
	// Off the river: it is available, entered in m³/s and stored in m³/day.
	await routing.getByLabel('Upstream inflow to dam (%)', { exact: true }).fill('0');
	await expect(divert).toBeEditable();
	await divert.fill('0.05');
	await saveModelChanges(page);
	await page.reload();
	const { routing: r2 } = await openUpperFarm(page);
	await expect(r2.getByLabel('River to dam (m³/s)', { exact: true })).toHaveValue('0.05');
	await expectNoViolations(page, { include: '[data-testid^="river-to-dam-months-"]' });
});
