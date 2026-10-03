// The Network's Map layout and the grid modal (issue #17, option A's
// simplicity with nothing lost): the schematic beside the picked node and a
// list of every node, the existing grids one click away in a full-screen
// modal (the node table included), and a node's full form in a sheet from its card.
import type { Page } from '@playwright/test';
import { addMember, createProject, createRun, putModel, sampleModel, seedRunnableProject } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { waitForMapFit } from '../support/diagrams.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { closeModal, openNodeForm, openNodeTable } from '../support/network.ts';
import { answerConfirm } from '../support/confirm.ts';

const nodeList = (page: Page) => page.getByRole('list', { name: 'All nodes' });
const card = (page: Page) => page.getByTestId('node-card');
/** Opens the header's Tables menu (a disclosure) and returns one of its links. */
async function gridLink(page: Page, name: string) {
	const menu = page.locator('details.grids-menu');
	if (!(await menu.evaluate((d: HTMLDetailsElement) => d.open))) await menu.locator('summary').click();
	return page.getByRole('group', { name: 'Open as a table' }).getByRole('link', { name, exact: true });
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

	// A page of its own: a title, one line on what the network is, and its actions.
	await expect(page.getByRole('heading', { level: 1, name: 'Network' })).toBeVisible();
	await expect(page.getByTestId('network-summary')).toHaveText('2 hydrological units · 2 dams · 1 gauge · into Outflow gauge · 32.0 km²');
	// With a run, farms are coloured by supply from the start, and a farm's label says its share (nothing else, so labels don't collide).
	await expect(page.getByLabel('Colour hydrological units by').locator('option:checked')).toHaveText('Supply, latest run');
	const upperNode = page.locator('svg.schematic g.node').filter({ hasText: 'Upper farm' });
	await expect(upperNode).toHaveAttribute('data-supply', /^(met|short|low|none)$/);
	await expect(upperNode.locator('text.meta')).toHaveText(/^(\d+% supplied|no demand)$/);
	// The layout uses the screen: it reaches the bottom of the window, and a small catchment's drawing
	// fits its card without scrolling sideways (its columns spread to the card, text at its usual size).
	// Measured once the drawing is laid out for its box (it first draws before the box is measured, issue #138).
	await waitForMapFit(page);
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
	await expect(c).toContainText('Selected · hydrological unit');
	await expect(c.getByRole('heading', { name: 'Upper farm' })).toBeVisible();
	await expect(c).toContainText(/Supplied, Baseline\s*\d+%/);
	// The dam at the end of the run (its storage series, fetched for the picked farm).
	await expect(c).toContainText(/Dam at end of run\s*\d+%/);
	await expect(c).toContainText(/Flow share\s*\d+(\.\d)?%/);
	await expect(c).toContainText('Drains intoOutflow gauge');
	await expect(c).toContainText('Dam150\u202f000 m³');
	await expect(c.getByRole('link', { name: '20.00 ha, 1 crop' })).toHaveAttribute('href', /[?&]farm=/);
	await expectNoViolations(page);

	// A gauge's card has no farm figures.
	await nodeList(page).getByRole('button', { name: /^Outflow gauge/ }).click();
	await expect(c).toContainText('Selected · outflow gauge');
	await expect(c).not.toContainText('Supplied');

	// Edit opens the node's full form in a sheet over the map; ‹ › and the picker move it to another node.
	await nodeList(page).getByRole('button', { name: /^Lower farm/ }).click();
	await c.getByRole('button', { name: 'Edit Lower farm' }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]edit=${project.model.nodes[2]!.id}`));
	const sheet = page.getByRole('dialog', { name: 'Edit Lower farm' });
	await expect(sheet.getByLabel('Node to edit')).toHaveValue(String(project.model.nodes[2]!.id));
	await expect(sheet.getByLabel('Name', { exact: true })).toHaveValue('Lower farm');
	await expectNoViolations(page);
	await sheet.getByRole('button', { name: 'Previous node' }).click();
	await expect(page.getByRole('dialog', { name: 'Edit Upper farm' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page).not.toHaveURL(/edit=/);

	// The node table is a grid (Tables → Node table), every column as before.
	const table = await openNodeTable(page);
	await expect(page).toHaveURL(/[?&]grid=nodes/);
	await expect(table.locator('table.net').getByRole('textbox', { name: 'Name' })).toHaveCount(3);
	await expect(table.getByRole('button', { name: 'Sort by flow path' })).toBeVisible();
	await table.getByRole('button', { name: 'Done' }).click();

	// There are no layouts to switch any more; old links still land somewhere sensible.
	await expect(page.getByRole('group', { name: 'Layout' })).toHaveCount(0);
	await page.goto(`/projects/${project.id}?tab=network&view=table`);
	await expect(page.getByRole('dialog', { name: 'Node table' })).toBeVisible();
	await expect(page).toHaveURL(/\?tab=network&grid=nodes$/);
	await page.goto(`/projects/${project.id}?tab=network&view=node`);
	await expect(page.getByRole('dialog', { name: /^Edit / })).toBeVisible();
	await expect(page).toHaveURL(/[?&]edit=/);
});

test('the map key names only what the drawing has, in groups, drawn like the map', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Map key');
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}?tab=network`);
	const key = page.getByTestId('map-key');

	// Both units have dams and the only gauge is the outlet: no plain-unit or gauge entry to hunt for.
	await expect(key.getByText('Hydrological unit with a dam', { exact: true })).toBeVisible();
	await expect(key.getByText('Hydrological unit', { exact: true })).toHaveCount(0);
	await expect(key.getByText('Gauge', { exact: true })).toHaveCount(0);
	await expect(key.getByText('Outflow gauge', { exact: true })).toBeVisible();
	// The dam swatch is the map's dam symbol, wave included.
	await expect(key.locator('li', { hasText: 'with a dam' }).locator('path.dam-water')).toHaveCount(1);

	// Shapes, lines and colours are separate, headed groups.
	await expect(key.locator('.key-h')).toHaveText(['Nodes', 'Lines', 'Colour: supply']);
	await expect(key.getByText('River, thicker with more area upstream')).toBeVisible();
	// A colour band fills both unit shapes, so it matches the squares on the map too.
	const band = key.locator('li[data-supply]').first();
	await expect(band.locator('circle.farm')).toHaveCount(1);
	await expect(band.locator('rect.farm')).toHaveCount(1);
	// Drawn in the map's own colours.
	const river = await page.locator('svg.schematic path.river').first().evaluate((e) => getComputedStyle(e).stroke);
	expect(await key.locator('path.arrow-river').evaluate((e) => getComputedStyle(e).fill)).toBe(river);

	await page.getByLabel('Colour hydrological units by').selectOption({ label: 'Dam level, end of latest run' });
	await expect(key.locator('.key-h').last()).toHaveText('Colour: dam level');
});

test('colour farms by dam level (end of the latest run), with its own words', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Network colours');
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}?tab=network`);
	const colourBy = page.getByLabel('Colour hydrological units by');
	const upper = page.locator('svg.schematic g.node').filter({ hasText: 'Upper farm' });

	// Dam level: fetched when picked; every farm here has a dam.
	await colourBy.selectOption({ label: 'Dam level, end of latest run' });
	await expect(upper.locator('text.meta')).toHaveText(/^\d+(% full|%, at its minimum)$/);
	await expect(upper).toHaveAttribute('data-supply', /^(met|short|low)$/);
	await expect(page.getByText(/^Hydrological units coloured by how full their dam was at the end of run “Baseline”, ran today\./)).toBeVisible();
	// The node list's dots follow the colours.
	await expect(nodeList(page).getByRole('button', { name: /^Upper farm/ }).locator('.dot')).toHaveAttribute('data-band', /^(met|short|low)$/);
	await expectNoViolations(page);

	// Irrigated area is no longer a mode (issue #174): the menu holds the run's two and Nothing.
	await expect(colourBy.locator('option')).toHaveText(['Nothing', 'Supply, latest run', 'Dam level, end of latest run']);
});

// The colouring's "Loading the latest run's results…" sat in the map card's header, wrapped it onto a
// second row at 1280 px and moved the map ~25 px when the load ended. It lies over the map now.
test('the map stays put while the latest run’s results load and after', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Network loading line');
	const runId = await createRun(page.request, project.id, 'Baseline');
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r));
	await page.route(
		(url) => url.pathname.endsWith(`/projects/${project.id}/runs/${runId}`),
		async (route) => {
			if (route.request().method() === 'GET') await held;
			await route.fallback();
		}
	);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto(`/projects/${project.id}?tab=network`);
	const status = page.locator('.map-card .map-body').getByRole('status');
	await expect(status).toHaveText('Loading the latest run’s results…');
	await expect(page.locator('svg.schematic g.node').first()).toBeVisible();
	const before = (await page.locator('.map-card .map-body').boundingBox())!;

	release();
	await expect(page.locator('svg.schematic g.node').filter({ hasText: 'Upper farm' })).toHaveAttribute('data-supply', /^(met|short|low)$/);
	await expect(status).toHaveText('');
	const after = (await page.locator('.map-card .map-body').boundingBox())!;
	expect(after.y).toBe(before.y);
	expect(after.height).toBe(before.height);
});

test('after a dam capacity edit the card’s Dam at end of run agrees with the map’s dam colouring: both read the run’s capacity (issue #173)', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Network dam end of run');
	await createRun(page.request, project.id, 'Baseline');
	// Upper farm's dam halved after the run (150 000 m³ in the run, 75 000 m³ now).
	const upperId = project.model.nodes[1]!.id;
	await putModel(page.request, project.id, {
		...project.model,
		nodes: project.model.nodes.map((n) => (n.id === upperId ? { ...n, damCapacityM3: 75_000 } : n))
	});
	await page.goto(`/projects/${project.id}?tab=network`);
	await page.getByLabel('Colour hydrological units by').selectOption({ label: 'Dam level, end of latest run' });
	const meta = page.locator('svg.schematic g.node').filter({ hasText: 'Upper farm' }).locator('text.meta');
	await expect(meta).toHaveText(/^\d+(% full|%, at its minimum)$/);
	const mapPct = (await meta.textContent())!.match(/^(\d+)%/)![1];

	await nodeList(page).getByRole('button', { name: /^Upper farm/ }).click();
	const tile = card(page).locator('.tile').filter({ hasText: 'Dam at end of run' });
	await expect(tile.locator('.t-v')).toHaveText(`${mapPct}%`);
	await expect(tile.locator('.t-s')).toHaveText('of 150\u202f000 m³ in the run');
	await expect(card(page)).toContainText('Dam75\u202f000 m³');
});

test('without a run there is nothing to colour by, so the menu isn’t offered', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Network colours no run');
	await page.goto(`/projects/${project.id}?tab=network`);
	await expect(page.locator('svg.schematic g.node').filter({ hasText: 'Upper farm' })).toBeVisible();
	await expect(page.getByLabel('Colour hydrological units by')).toHaveCount(0);
	await expect(page.locator('svg.schematic g.node[data-supply]')).toHaveCount(0);
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
	await expect(page.getByRole('group', { name: 'Open as a table' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('group', { name: 'Open as a table' })).toBeHidden();
	await expect(menu.locator('summary')).toBeFocused();

	// Transfers too; Back closes a grid as well.
	await (await gridLink(page, 'Transfers')).click();
	await expect(page.getByRole('dialog', { name: 'Transfers' }).getByLabel('Enabled, transfer 1')).toBeChecked();
	await page.goBack();
	await expect(page.getByRole('dialog', { name: 'Transfers' })).toHaveCount(0);

	// The crop grids live only in the modal now (Crops & demand is cards and bars), so they open over the Crops tab too.
	await page.goto(`/projects/${project.id}?tab=crops&grid=planted-areas`);
	await expect(page.getByRole('dialog', { name: 'Planted areas' }).getByLabel('Orchard on Upper farm, ha')).toHaveValue('30');
	await closeModal(page);
	await expect(page).toHaveURL(/\?tab=crops$/);

	// Over the grid's own tab it isn't opened: the Transfers table is already on the page.
	await page.goto(`/projects/${project.id}?tab=transfers&grid=transfers`);
	await expect(page.getByLabel('Enabled, transfer 1')).toBeChecked();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page).toHaveURL(/\?tab=transfers$/);
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

/** Whether `inner`'s box lies inside `outer`'s (both on screen now). */
async function inside(inner: import('@playwright/test').Locator, outer: import('@playwright/test').Locator): Promise<boolean> {
	const [a, b] = [await inner.boundingBox(), await outer.boundingBox()];
	return !!a && !!b && a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.width <= b.x + b.width + 1 && a.y + a.height <= b.y + b.height + 1;
}

test('a pick is kept in the URL: Back steps through the picks and a reload keeps the last', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Network pick URL');
	const [, upper, lower] = project.model.nodes.map((n) => n.id as string);
	await page.goto(`/projects/${project.id}?tab=network`);
	await nodeList(page).getByRole('button', { name: /^Upper farm/ }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]node=${upper}`));
	await nodeList(page).getByRole('button', { name: /^Lower farm/ }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]node=${lower}`));
	await expect(card(page).getByRole('heading', { name: 'Lower farm' })).toBeVisible();
	await page.goBack();
	await expect(page).toHaveURL(new RegExp(`[?&]node=${upper}`));
	await expect(card(page).getByRole('heading', { name: 'Upper farm' })).toBeVisible();
	await expect(nodeList(page).getByRole('button', { name: /^Upper farm/ })).toHaveAttribute('aria-pressed', 'true');
	await page.goForward();
	await expect(card(page).getByRole('heading', { name: 'Lower farm' })).toBeVisible();
	await page.reload();
	await expect(card(page).getByRole('heading', { name: 'Lower farm' })).toBeVisible();
	// Editing a node picks it too, so closing the sheet leaves the map on it.
	await nodeList(page).getByRole('button', { name: /^Upper farm/ }).click();
	await card(page).getByRole('button', { name: 'Edit Upper farm' }).click();
	await page.getByRole('dialog', { name: 'Edit Upper farm' }).getByRole('button', { name: 'Next node' }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]node=${lower}`));
	await closeModal(page);
	await expect(card(page).getByRole('heading', { name: 'Lower farm' })).toBeVisible();
});

test('on a big network a picked node is brought into view, in the drawing and in the list', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1280, height: 800 });
	const project = await createProject(page.request, 'Network big pick');
	const model = sampleModel();
	const [gauge, farm] = [model.nodes[0]!, model.nodes[1]!];
	model.nodes = [gauge, ...Array.from({ length: 30 }, (_, i) => ({ ...farm, id: crypto.randomUUID(), name: `Unit ${String(i + 1).padStart(2, '0')}`, sortOrder: i + 2 }))];
	model.cropAreas = [];
	model.transfers = [];
	await putModel(page.request, project.id, model);
	await page.goto(`/projects/${project.id}?tab=network`);
	await waitForMapFit(page);
	const scroller = page.locator('.map-card .scroller');
	const list = page.locator('.node-list');

	// The last row of the list: its node on the drawing scrolls into the drawing's box.
	await nodeList(page).getByRole('button', { name: /^Unit 30/ }).click();
	const last = page.locator('svg.schematic g.node.selected');
	await expect(last).toContainText('Unit 30');
	await expect.poll(() => inside(last, scroller)).toBe(true);

	// A node picked on the drawing: its row scrolls into the list's card.
	await nodeList(page).getByRole('button', { name: /^Unit 30/ }).scrollIntoViewIfNeeded();
	const first = page.locator('svg.schematic g.node').filter({ hasText: 'Unit 01' });
	await first.scrollIntoViewIfNeeded();
	await first.click();
	const row = nodeList(page).getByRole('button', { name: /^Unit 01/ });
	await expect(row).toHaveAttribute('aria-pressed', 'true');
	await expect.poll(() => inside(row, list)).toBe(true);

	// A link to the last node lands with both in view.
	await page.goto(`/projects/${project.id}?tab=network&node=${model.nodes.at(-1)!.id as string}`);
	await waitForMapFit(page);
	await expect.poll(() => inside(page.locator('svg.schematic g.node.selected'), scroller)).toBe(true);
	await expect.poll(() => inside(nodeList(page).getByRole('button', { name: /^Unit 30/ }), list)).toBe(true);
});

test('the node sheet runs in the order water moves, with a jump row that stays put', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Network sheet order');
	await page.goto(`/projects/${project.id}?tab=network`);
	const sheet = await openNodeForm(page, 'Upper farm');
	await expect(sheet.locator('.detail > fieldset > legend')).toHaveText([
		'Catchment area',
		'Flow share',
		'Dam',
		'Dam survey and releases',
		'Routing',
		'Supply',
		'Irrigation',
		'Demand objects',
		'Combined boreholes (one capacity)',
		'Individual boreholes',
		'Land cover'
	]);
	const jump = sheet.getByRole('navigation', { name: 'Sections of the form' });
	await jump.getByRole('button', { name: 'Individual boreholes' }).click();
	const target = sheet.getByRole('group', { name: 'Individual boreholes', exact: true });
	await expect(target).toBeFocused();
	await expect(target.locator('legend')).toBeInViewport();
	// The row sits in the sheet's fixed sub-header, so it is still on screen after the jump.
	await expect(jump).toBeInViewport();
	await expectNoViolations(page);
});

test('fields only another set-up reads show read-only, saying what would use them', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Network unused fields');
	await page.goto(`/projects/${project.id}?tab=network`);
	await page.getByTestId('section-header').getByRole('button', { name: '+ Add node' }).click();
	const sheet = page.getByRole('dialog', { name: /^Edit Unit/ });
	const minimum = sheet.getByLabel('Minimum level (%)');
	await expect(minimum).toHaveAttribute('readonly', '');
	await expect(minimum).toHaveAccessibleDescription(/Not used: no dam \(capacity 0\)/);
	// The flow-share method is by area: the manual share and the high/low split are not read.
	await expect(sheet.getByLabel('Manual (%)')).toHaveAttribute('readonly', '');
	await expect(sheet.getByLabel('High-MAP (km²)')).toHaveAccessibleDescription(/high\/low MAP split/);
	await sheet.getByLabel('Capacity (m³)').fill('5000');
	await expect(minimum).not.toHaveAttribute('readonly', '');
});

test('removing a node from its sheet asks, names what goes with it, and leaves the focus on the page', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Network sheet remove');
	await page.goto(`/projects/${project.id}?tab=network`);
	const sheet = await openNodeForm(page, 'Upper farm');
	await sheet.getByRole('button', { name: 'Remove Upper farm' }).click();
	const box = page.getByRole('alertdialog', { name: 'Remove “Upper farm”?' });
	await expect(box).toContainText('Its 1 crop area and 1 transfer go with it.');
	await expect(box).not.toContainText('(s)');
	await expect(box.getByRole('button', { name: 'Remove hydrological unit' })).toBeVisible();
	await answerConfirm(page, true);
	await expect(page.getByRole('dialog', { name: /^Edit / })).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'All nodes' })).toBeFocused();
	await expect(nodeList(page).getByRole('button')).toHaveCount(2);
});

test('a unit’s sheet points to its planted areas and transfers', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Network sheet elsewhere');
	await page.goto(`/projects/${project.id}?tab=network`);
	const sheet = await openNodeForm(page, 'Upper farm');
	const line = sheet.getByTestId('node-elsewhere');
	await expect(line).toHaveText('Set elsewhere: its crops, 20.00 ha planted, 1 crop; its transfers, 1 transfer, to Lower farm.');
	// The planted areas open in the farm drawer, in place of the sheet.
	const planted = line.getByRole('link', { name: '20.00 ha planted, 1 crop' });
	await expect(planted).toHaveAttribute('href', /[?&]farm=/);
	await expect(planted).not.toHaveAttribute('href', /[?&]edit=/);
	await expect(line.getByRole('link', { name: '1 transfer, to Lower farm' })).toHaveAttribute('href', '?tab=transfers');
});

test('the header adds an other water user, opening its form on its name', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Network add user');
	await page.goto(`/projects/${project.id}?tab=network`);
	await page.getByTestId('section-header').getByRole('button', { name: '+ Add other user' }).click();
	const sheet = page.getByRole('dialog', { name: 'Edit Other user 1' });
	await expect(sheet.getByLabel('Name', { exact: true })).toBeFocused();
	await expect(sheet.getByRole('combobox', { name: 'Kind' })).toHaveValue('user');
});

test('an empty network offers the map as a start to an editor, and tells a viewer who builds it', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Network empty');
	await page.goto(`/projects/${project.id}?tab=network`);
	const empty = page.getByTestId('network-empty');
	await expect(empty.getByRole('button', { name: 'Add outflow gauge' })).toBeVisible();
	await expect(empty.getByRole('link', { name: 'Start from the map' })).toHaveAttribute('href', '?tab=map&start=1');

	const viewer = await signIn('Network empty viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=network`);
	const vEmpty = viewer.page.getByTestId('network-empty');
	await expect(vEmpty).toHaveText('No nodes yet. An editor builds the network here or from the Map.');
	await expect(vEmpty.getByRole('button')).toHaveCount(0);
	await expect(vEmpty.getByRole('link')).toHaveCount(0);
});

test('the drawing’s text and the supply tile say it in the workspace’s words', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Network words');
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}?tab=network`);
	const tree = page.getByRole('list', { name: 'Drainage tree' });
	await expect(tree).toContainText('Upper farm, hydrological unit');
	await expect(tree).not.toContainText(', farm,');
	await nodeList(page).getByRole('button', { name: /^Upper farm/ }).click();
	// The tile's tint has its band in words under it.
	await expect(card(page).getByTestId('supply-band')).toHaveText(/supplied$/);
});
