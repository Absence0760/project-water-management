// The node table (Network › Grids › Node table, issue #17). On a desktop it
// is a table with a column per field; on a phone each row is a card with
// visible field labels, the same inputs, validation and save row, so nothing
// scrolls sideways. The desktop test pins the table's editing as it was
// before the phone cards came in.
import type { Locator, Page } from '@playwright/test';
import { createProject, putModel, sampleModel } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

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
	await expect(totals).toContainText('245,000');
	await expect(totals).toContainText('100.00%');
	// Upper 12 km² of 21.5 km² of units, by area.
	await expect(nodeRow(grid, model, 'Upper farm')).toContainText('55.81%');

	// Out of range: shown, marked invalid, not taken.
	const initial = grid.getByLabel('Dam initial storage of Upper farm, %');
	await initial.fill('150');
	await expect(initial).toHaveAttribute('aria-invalid', 'true');
	await initial.fill('70');
	await expect(initial).not.toHaveAttribute('aria-invalid', 'true');

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
