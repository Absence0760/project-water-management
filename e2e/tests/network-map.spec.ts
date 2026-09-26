// The Network's Map layout and the grid modal (issue #17, option A's
// simplicity with nothing lost): the schematic beside the picked node and a
// list of every node, the existing grids one click away in a full-screen
// modal, and the Table and One node layouts kept.
import type { Page } from '@playwright/test';
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const layout = (page: Page, name: 'Map' | 'Table' | 'One node') =>
	page.getByRole('group', { name: 'Layout' }).getByRole('button', { name, exact: true });
const nodeList = (page: Page) => page.getByRole('list', { name: 'All nodes' });
const card = (page: Page) => page.getByTestId('node-card');
/** Opens the header's Grids menu (a disclosure) and returns one of its links. */
async function gridLink(page: Page, name: string) {
	const menu = page.locator('details.grids-menu');
	if (!(await menu.evaluate((d: HTMLDetailsElement) => d.open))) await menu.locator('summary').click();
	return page.getByRole('group', { name: 'Open as a grid' }).getByRole('link', { name, exact: true });
}

async function savedCropArea(page: Page, projectId: string, farm: string): Promise<number> {
	const res = await page.request.get(`${API_URL}/projects/${projectId}/model`);
	const m = (await res.json()) as { nodes: { id: string; name: string }[]; cropAreas: { nodeId: string; areaM2: number }[] };
	const id = m.nodes.find((n) => n.name === farm)!.id;
	return m.cropAreas.filter((a) => a.nodeId === id).reduce((s, a) => s + a.areaM2, 0);
}

test('the map is the default: pick a node in the list, read its card, Edit opens its form', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Network map');
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}?tab=network`);

	await expect(layout(page, 'Map')).toHaveAttribute('aria-pressed', 'true');
	// A page of its own: a title, one line on what the network is, and its actions.
	await expect(page.getByRole('heading', { level: 2, name: 'Network' })).toBeVisible();
	await expect(page.getByTestId('network-summary')).toHaveText('2 farms · 2 dams · 1 gauge · draining to Outflow gauge · 32.0 km²');
	// With a run, farms are coloured by supply from the start, and a farm's label says its share (nothing else, so labels don't collide).
	await expect(page.getByLabel('Colour farms by').locator('option:checked')).toHaveText('Supply, latest run');
	const upperNode = page.locator('svg.schematic g.node').filter({ hasText: 'Upper farm' });
	await expect(upperNode).toHaveAttribute('data-supply', /^(met|short|low|none)$/);
	await expect(upperNode.locator('text.meta')).toHaveText(/^(\d+% supplied|no demand)$/);
	// The layout uses the screen: it reaches the bottom of the window, and a small catchment's drawing
	// fits its card without scrolling sideways (its columns spread to the card, text at its usual size).
	const viewport = page.viewportSize()!;
	const layoutBox = (await page.locator('.map-layout').boundingBox())!;
	expect(layoutBox.y + layoutBox.height).toBeGreaterThan(viewport.height - 40);
	expect(layoutBox.y + layoutBox.height).toBeLessThanOrEqual(viewport.height);
	// …and the page itself doesn't scroll: nothing but blank padding would be below.
	await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(0);
	const box = page.locator('.map-card .scroller');
	expect(await box.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
	const drawn = (await page.locator('.map-card svg.schematic').boundingBox())!;
	expect(drawn.width).toBeGreaterThan((await box.boundingBox())!.width * 0.6);
	await expect(page.getByText('Select a node on the map or in the list to see it here.')).toBeVisible();
	// The table isn't on the page in this layout.
	await expect(page.locator('table.net')).toHaveCount(0);
	await expect(nodeList(page).getByRole('button')).toHaveCount(3);
	await expect(nodeList(page).getByRole('button').first()).toContainText('Outflow gauge');
	await expect(nodeList(page).getByRole('button').first()).toContainText('outlet');

	await nodeList(page).getByRole('button', { name: /^Upper farm/ }).click();
	await expect(nodeList(page).getByRole('button', { name: /^Upper farm/ })).toHaveAttribute('aria-pressed', 'true');
	const c = card(page);
	await expect(c).toContainText('Selected · farm');
	await expect(c.getByRole('heading', { name: 'Upper farm' })).toBeVisible();
	await expect(c).toContainText(/Supplied, Baseline\s*\d+%/);
	// The dam at the end of the run (its storage series, fetched for the picked farm).
	await expect(c).toContainText(/Dam now\s*\d+%/);
	await expect(c).toContainText(/Flow share\s*\d+(\.\d)?%/);
	await expect(c).toContainText('Drains intoOutflow gauge');
	await expect(c).toContainText('Dam150,000 m³');
	await expect(c.getByRole('link', { name: '20.00 ha, 1 crop' })).toHaveAttribute('href', /[?&]farm=/);
	await expectNoViolations(page);

	// A gauge's card has no farm figures.
	await nodeList(page).getByRole('button', { name: /^Outflow gauge/ }).click();
	await expect(c).toContainText('Selected · outflow gauge');
	await expect(c).not.toContainText('Supplied');

	// Edit opens the full form on the One node layout, for that node.
	await nodeList(page).getByRole('button', { name: /^Lower farm/ }).click();
	await c.getByRole('button', { name: 'Edit Lower farm' }).click();
	await expect(page).toHaveURL(/[?&]view=node/);
	await expect(layout(page, 'One node')).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByLabel('Node to edit')).toHaveValue(String(project.model.nodes[2]!.id));

	// The other layouts are kept, and linkable.
	await layout(page, 'Table').click();
	await expect(page).toHaveURL(/[?&]view=table/);
	await expect(page.locator('table.net').getByRole('textbox', { name: 'Name' })).toHaveCount(3);
	await layout(page, 'Map').click();
	await expect(page).not.toHaveURL(/view=/);
});

test('a note’s link opens the map with its node picked', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Network map node link');
	await page.goto(`/projects/${project.id}?tab=network&node=${project.model.nodes[1]!.id}`);
	await expect(card(page).getByRole('heading', { name: 'Upper farm' })).toBeVisible();
	// Its notes are on the card, as on the table row.
	await expect(card(page).getByRole('button', { name: /note on Upper farm/ })).toBeVisible();
});

test('the grids open in a modal from the map, edit the same model, save, and close back to the map', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Grid modal');
	await page.goto(`/projects/${project.id}?tab=network`);

	await (await gridLink(page, 'Planted areas')).click();
	await expect(page).toHaveURL(/\?tab=network&grid=planted-areas$/);
	const grid = page.getByRole('dialog', { name: 'Planted areas' });
	// The Crops tab's own grid, unchanged: same labels, same total row.
	const area = grid.getByLabel('Orchard on Upper farm, ha');
	await expect(area).toHaveValue('20');
	await expect(grid.getByRole('heading', { name: 'Crop factors' })).toHaveCount(0);
	await expect(grid).toContainText('No unsaved changes');
	await expectNoViolations(page);

	await area.fill('30');
	await area.press('Tab');
	await expect(grid).toContainText('Unsaved changes to the model');
	// Done leaves the edit for the page's save bar and drops the grid from the URL.
	await grid.getByRole('button', { name: 'Done' }).click();
	await expect(grid).toHaveCount(0);
	await expect(page).toHaveURL(/\?tab=network$/);
	await expect(page.getByRole('region', { name: 'Unsaved model changes' })).toBeVisible();

	// Another grid shows the same unsaved model, and saves it with a reason.
	await (await gridLink(page, 'Crop factors')).click();
	const factors = page.getByRole('dialog', { name: 'Crop factors' });
	await expect(factors.getByLabel('Orchard crop factor, Oct')).toHaveValue('0.6');
	await factors.getByRole('textbox', { name: 'Reason for this change (optional)' }).fill('Block replanted');
	await factors.getByRole('button', { name: 'Save changes' }).click();
	await expect(factors).toContainText('No unsaved changes');
	expect(await savedCropArea(page, project.id, 'Upper farm')).toBe(300_000);
	await page.keyboard.press('Escape');
	await expect(factors).toHaveCount(0);
	await expect(page).toHaveURL(/\?tab=network$/);

	// The menu closes on Escape.
	const menu = page.locator('details.grids-menu');
	await menu.locator('summary').click();
	await expect(page.getByRole('group', { name: 'Open as a grid' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('group', { name: 'Open as a grid' })).toBeHidden();
	await expect(menu.locator('summary')).toBeFocused();

	// Transfers too; Back closes a grid as well.
	await (await gridLink(page, 'Transfers')).click();
	await expect(page.getByRole('dialog', { name: 'Transfers' }).getByLabel('transfer 1 enabled')).toBeChecked();
	await page.goBack();
	await expect(page.getByRole('dialog', { name: 'Transfers' })).toHaveCount(0);

	// Over the grid's own tab it isn't opened: the grid is already on the page.
	await page.goto(`/projects/${project.id}?tab=crops&grid=planted-areas`);
	await expect(page.getByLabel('Orchard on Upper farm, ha')).toHaveValue('30');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page).toHaveURL(/\?tab=crops$/);
});

test('a viewer reads a grid in the modal, and can only close it', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Grid modal viewer');
	const viewer = await signIn('Grid modal viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.goto(`/projects/${project.id}?tab=network&grid=planted-areas`);
	const grid = v.getByRole('dialog', { name: 'Planted areas' });
	await expect(grid.getByLabel('Orchard on Upper farm, ha')).not.toBeEditable();
	await expect(grid.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
	await grid.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(v).not.toHaveURL(/grid=/);
});

test.describe('phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('the map stacks: schematic, then the card and the list; a grid fills the screen', async ({ page, owner }) => {
		void owner;
		const project = await seedRunnableProject(page.request, 'Network map phone');
		await page.goto(`/projects/${project.id}?tab=network`);
		await nodeList(page).getByRole('button', { name: /^Upper farm/ }).click();
		await expect(card(page).getByRole('heading', { name: 'Upper farm' })).toBeVisible();
		const drawing = (await page.locator('svg.schematic').boundingBox())!;
		const cardBox = (await card(page).boundingBox())!;
		expect(cardBox.y).toBeGreaterThan(drawing.y);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
		await expectNoViolations(page);

		await (await gridLink(page, 'Planted areas')).click();
		const grid = page.getByRole('dialog', { name: 'Planted areas' });
		await expect(grid.getByLabel('Orchard on Upper farm, ha')).toBeVisible();
		// Edge to edge (the page's scrollbar gutter aside).
		const box = (await grid.boundingBox())!;
		expect(box.x).toBe(0);
		expect(box.width).toBeGreaterThan(370);
		await expectNoViolations(page);
	});
});
