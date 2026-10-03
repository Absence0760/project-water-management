// The node table (Network › Tables › Node table, issue #17). On a desktop it
// is a table with a column per field; on a phone each row is a card with
// visible field labels, the same inputs, validation and save row, so nothing
// scrolls sideways. The desktop test pins the table's editing as it was
// before the phone cards came in.
import type { Locator, Page } from '@playwright/test';
import { addMember, createProject, putModel, sampleModel } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { answerConfirm } from '../support/confirm.ts';

const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });

type Model = ReturnType<typeof sampleModel>;

/** A node's row (a card on a phone). */
function nodeRow(grid: Locator, model: Model, name: string) {
	return grid.locator(`#node-row-${model.nodes.find((n) => n.name === name)!.id}`);
}

/** Edits every kind of cell in the table, checks validation, saves and reloads. Same labels at every width. */
async function editAndSave(page: Page, projectId: string, model: Model) {
	await page.goto(`/projects/${projectId}?tab=network&grid=nodes`);
	const grid = page.getByRole('dialog', { name: 'Node table' });
	const names = grid.getByRole('textbox', { name: 'Name' });
	await expect(names).toHaveCount(3);
	const problems = grid.getByRole('status').filter({ hasText: 'Fix before saving:' });
	const save = grid.getByRole('button', { name: 'Save changes' });
	const totals = grid.locator('tfoot tr');

	// Rename: every label in the row follows the name.
	await names.nth(2).fill('Lower block');
	await grid.getByLabel('Area of Lower block, km²', { exact: true }).fill('9.5');
	await grid.getByLabel('Dam capacity of Lower block, m³').fill('95000');
	await grid.getByLabel('Upstream inflow entering the dam at Upper farm, %').fill('40');
	await grid.getByLabel('Manual flow share of Upper farm, %').fill('60');
	await expect(totals).toContainText('33.50');
	await expect(totals).toContainText('245\u202f000');
	await expect(totals).toContainText('100.00%');
	// Upper 12 km² of 21.5 km² of units, by area.
	await expect(nodeRow(grid, model, 'Upper farm')).toContainText('55.81%');

	// Out of range: shown, marked invalid, not taken, and the field says the range it takes.
	// The text and the message stay after the field loses focus (not put back to the old value).
	const initial = grid.getByLabel('Dam initial storage of Upper farm, %');
	await initial.fill('150');
	await expect(initial).toHaveAttribute('aria-invalid', 'true');
	await expect(initial).toHaveAccessibleDescription('Enter a number from 0 to 100');
	await initial.blur();
	await expect(initial).toHaveValue('150');
	await expect(grid.getByText('Enter a number from 0 to 100', { exact: true })).toBeVisible();
	// A decimal comma reads the same in a % cell as in a volume.
	await initial.fill('70,5');
	await expect(initial).not.toHaveAttribute('aria-invalid', 'true');
	await expect(grid.getByText('Enter a number from 0 to 100', { exact: true })).toHaveCount(0);
	await initial.blur();
	await expect(initial).toHaveValue('70.5');
	await initial.fill('70');

	// A gauge has no dam: its fields are not used.
	await grid.getByLabel('Kind of Lower block').selectOption('gauge');
	await expect(grid.getByLabel('Dam capacity of Lower block, m³')).toHaveCount(0);
	await grid.getByLabel('Kind of Lower block').selectOption('farm');
	await expect(grid.getByLabel('Dam capacity of Lower block, m³')).toHaveValue('95000');

	// A second outlet blocks saving, in the grid's own save row.
	await grid.getByLabel('Lower block drains into').selectOption({ label: '— Outlet (none) —' });
	await expect(problems).toContainText('The network has 2 outlets');
	await expect(save).toBeDisabled();
	await grid.getByLabel('Lower block drains into').selectOption({ label: 'Outflow gauge' });
	await expect(problems).toBeHidden();

	// Reorder with the keyboard path.
	await grid.getByRole('button', { name: 'Move Lower block up' }).click();
	await expect(names.nth(1)).toHaveValue('Lower block');

	const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/projects/${projectId}/model`));
	await save.click();
	expect((await saved).status()).toBe(200);
	await expect(saveBar(page)).toBeHidden();

	await page.reload();
	const again = page.getByRole('dialog', { name: 'Node table' });
	await expect(again.getByRole('textbox', { name: 'Name' }).nth(1)).toHaveValue('Lower block');
	await expect(again.getByLabel('Area of Lower block, km²', { exact: true })).toHaveValue('9.5');
	await expect(again.getByLabel('Dam capacity of Lower block, m³')).toHaveValue('95000');
	await expect(again.getByLabel('Dam initial storage of Upper farm, %')).toHaveValue('70');
	await expect(again.getByLabel('Upstream inflow entering the dam at Upper farm, %')).toHaveValue('40');
	await expect(again.getByLabel('Manual flow share of Upper farm, %')).toHaveValue('60');
	return again;
}

test('desktop: the node table edits, validates and saves every kind of cell', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Node table desktop');
	const model = sampleModel();
	await putModel(page.request, project.id, model);
	const grid = await editAndSave(page, project.id, model);

	// Still a table: the column headers show, the fields sit side by side in one row.
	await expect(grid.getByRole('columnheader', { name: /In use/ })).toBeVisible();
	await expect(grid.getByRole('columnheader', { name: /^Kind/ })).toBeVisible();
	const row = nodeRow(grid, model, 'Upper farm');
	const [a, b] = await Promise.all([
		row.getByLabel('Area of Upper farm, km²', { exact: true }).boundingBox(),
		row.getByLabel('Dam capacity of Upper farm, m³').boundingBox()
	]);
	expect(Math.abs(a!.y - b!.y)).toBeLessThanOrEqual(1);
	// A gauge's unused cells say so.
	await expect(nodeRow(grid, model, 'Outflow gauge').getByRole('cell', { name: 'not used for a gauge' }).first()).toBeAttached();
	await expectNoViolations(page);
});

test.describe('phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	/** Every control in the element lies inside the 390 px screen's width. */
	async function expectControlsOnScreen(el: Locator) {
		const boxes = await el.locator('input, select, button').evaluateAll((els) =>
			els.map((e) => {
				const r = e.getBoundingClientRect();
				return { name: e.getAttribute('aria-label'), left: r.left, right: r.right, width: r.width };
			})
		);
		expect(boxes.length).toBeGreaterThan(0);
		for (const b of boxes.filter((x) => x.width > 0)) {
			expect(b.left, b.name ?? '').toBeGreaterThanOrEqual(0);
			expect(b.right, b.name ?? '').toBeLessThanOrEqual(390);
		}
	}

	async function expectNoTableScroll(grid: Locator) {
		const [sw, cw] = await grid.locator('.table-wrap').evaluate((el) => [el.scrollWidth, el.clientWidth]);
		expect(sw).toBeLessThanOrEqual(cw!);
	}

	test('each node is a card with labelled fields: the same editing, validation and save, nothing sideways', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Node table phone');
		const model = sampleModel();
		await putModel(page.request, project.id, model);
		const grid = await editAndSave(page, project.id, model);

		// No column headers: each card labels its own fields, two to a row.
		await expect(grid.getByRole('columnheader', { name: /In use/ })).toBeHidden();
		// The ⓘ buttons were in the headers; the intro sends a phone to the field guide.
		await expect(grid.getByText('The field guide below explains', { exact: true })).toBeVisible();
		await expect(grid.getByText('The ⓘ buttons and the field guide below explain', { exact: true })).toBeHidden();
		const upper = nodeRow(grid, model, 'Upper farm');
		for (const label of ['Kind', 'Drains into', 'Area km²', 'Dam capacity m³', 'Dam initial storage %', 'Upstream inflow to dam %', 'Manual flow share %'])
			await expect(upper.getByText(label, { exact: true })).toBeVisible();
		await expect(upper.getByText('Flow share in use 55.81%')).toBeVisible();
		const [area, hi] = await Promise.all([
			upper.getByLabel('Area of Upper farm, km²', { exact: true }).boundingBox(),
			upper.getByLabel('High-MAP area of Upper farm, km²').boundingBox()
		]);
		expect(Math.abs(area!.y - hi!.y)).toBeLessThanOrEqual(1);
		expect(hi!.x).toBeGreaterThan(area!.x + area!.width);
		// The name takes the card's width, under its controls, Remove at the top right.
		const name = (await upper.getByRole('textbox', { name: 'Name' }).boundingBox())!;
		expect(name.width).toBeGreaterThan(280);
		const remove = (await upper.getByRole('button', { name: 'Remove Upper farm' }).boundingBox())!;
		const moveUp = (await upper.getByRole('button', { name: 'Move Upper farm up' }).boundingBox())!;
		expect(remove.y + remove.height).toBeLessThanOrEqual(name.y);
		expect(moveUp.y + moveUp.height).toBeLessThanOrEqual(name.y);
		expect(remove.x + remove.width).toBeGreaterThanOrEqual(name.x + name.width - 2);
		for (const card of await grid.locator('tbody tr').all()) await expectControlsOnScreen(card);

		// A gauge's card leaves out the fields it doesn't use.
		const gauge = nodeRow(grid, model, 'Outflow gauge');
		await expect(gauge.getByText('Area km²', { exact: true })).toBeVisible();
		await expect(gauge.getByText(/^Dam /)).toHaveCount(0);
		await expect(gauge.getByRole('cell', { name: 'not used for a gauge' }).first()).toBeHidden();

		// The totals read as lines of their own.
		const totals = grid.locator('tfoot tr');
		await expect(totals.getByText('Area 33.50 km²')).toBeVisible();
		await expect(totals.getByText('Dam capacity 245\u202f000 m³')).toBeVisible();
		await expect(totals.getByText('Flow share in use 100.00%')).toBeVisible();

		await expectNoTableScroll(grid);
		await expectNoSidewaysScroll(page);
		await expectNoViolations(page);
	});

	test('thirty nodes with long names: every card fits the screen; a viewer’s cards too', async ({ page, owner, signIn }) => {
		void owner;
		const project = await createProject(page.request, 'Node table phone big');
		const model = sampleModel();
		const [gauge, farm] = [model.nodes[0]!, model.nodes[1]!];
		model.nodes = [
			gauge,
			...Array.from({ length: 29 }, (_, i) => ({
				...farm,
				id: crypto.randomUUID(),
				name: `Tributary irrigation unit number ${i + 1} below the long weir`,
				sortOrder: i + 2,
				damCapacityM3: 1_430_000
			}))
		];
		model.cropAreas = [];
		model.transfers = [];
		await putModel(page.request, project.id, model);
		await page.goto(`/projects/${project.id}?tab=network&grid=nodes`);
		const grid = page.getByRole('dialog', { name: 'Node table' });
		await expect(grid.getByRole('textbox', { name: 'Name' })).toHaveCount(30);
		await expectNoTableScroll(grid);
		await expectNoSidewaysScroll(page);
		// The cards scroll with the modal, not in a box of their own inside it, so Add node follows the last card.
		const [sh, ch] = await grid.locator('.table-wrap').evaluate((el) => [el.scrollHeight, el.clientHeight]);
		expect(sh).toBeLessThanOrEqual(ch!);
		const last = grid.locator('tbody tr').last();
		await last.scrollIntoViewIfNeeded();
		await expectControlsOnScreen(last);
		await expect(last.getByRole('button', { name: /^Remove Tributary irrigation unit number 29 / })).toBeInViewport();
		// A seven-digit capacity shows whole in its box.
		const cap = last.getByLabel(/^Dam capacity of /);
		expect(await cap.evaluate((i: HTMLInputElement) => i.scrollWidth - i.clientWidth)).toBeLessThanOrEqual(0);

		// A viewer: no move or remove controls, values with separators, still nothing sideways.
		const viewer = await signIn('Node table phone viewer');
		await addMember(page.request, project.id, viewer.user.email, 'viewer');
		const v = viewer.page;
		await v.setViewportSize({ width: 390, height: 844 });
		await v.goto(`/projects/${project.id}?tab=network&grid=nodes`);
		const vGrid = v.getByRole('dialog', { name: 'Node table' });
		await expect(vGrid.getByRole('textbox', { name: 'Name' })).toHaveCount(30);
		await expect(vGrid.getByRole('button', { name: /^Remove / })).toHaveCount(0);
		await expect(vGrid.getByLabel(/^Dam capacity of /).first()).toHaveValue('1\u202f430\u202f000');
		await expectNoTableScroll(vGrid);
		await expectNoSidewaysScroll(v);
		await expectNoViolations(v);
	});
});

test('removing a row asks when something goes with it, then puts the focus on the next row', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Node table remove');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=network&grid=nodes`);
	const grid = page.getByRole('dialog', { name: 'Node table' });
	await grid.getByRole('button', { name: 'Remove Upper farm' }).click();
	await answerConfirm(page, true, 'Its 1 crop area and 1 transfer go with it.');
	await expect(grid.getByRole('textbox', { name: 'Name' })).toHaveCount(2);
	await expect(grid.getByRole('textbox', { name: 'Name' }).nth(1)).toHaveValue('Lower farm');
	await expect(grid.getByRole('textbox', { name: 'Name' }).nth(1)).toBeFocused();
});
