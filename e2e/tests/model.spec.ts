import type { Page } from '@playwright/test';
import { addMember, createProject, createRun, putModel, sampleModel, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { addCrop, openCropGrid, openCropSheet } from '../support/crops.ts';
import { closeModal, openNodeForm, openNodeTable, saveModelChanges } from '../support/network.ts';
import { answerConfirm } from '../support/confirm.ts';
import { ruleCard } from '../support/transfers.ts';

const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name });
const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });

test('build a network with farms, crops and a transfer, save, reload', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Model build');
	// The node table, as a grid over the (empty) map.
	await page.goto(`/projects/${project.id}?tab=network&grid=nodes`);
	const grid = page.getByRole('dialog', { name: 'Node table' });

	// --- network: outflow gauge + two farms ---------------------------------
	await grid.getByRole('button', { name: 'Add outflow gauge' }).click();
	await grid.getByRole('button', { name: '+ Add node' }).click();
	await grid.getByRole('button', { name: '+ Add node' }).click();
	const names = grid.getByRole('textbox', { name: 'Name' });
	await expect(names).toHaveCount(3);
	await expect(names.nth(0)).toHaveValue('Outflow gauge');
	// A new node is a "Unit N", as the workspace calls it (operator decision, 2026-10-01).
	await expect(names.nth(1)).toHaveValue('Unit 1');
	await expect(names.nth(2)).toHaveValue('Unit 2');
	await names.nth(1).fill('Hilltop farm');
	await names.nth(2).fill('Valley farm');

	await expect(grid.getByLabel('Kind of Outflow gauge')).toHaveValue('gauge');
	await expect(grid.getByLabel('Kind of Hilltop farm')).toHaveValue('farm');
	await expect(grid.getByLabel('Hilltop farm drains into').locator('option:checked')).toHaveText('Outflow gauge');

	await grid.getByLabel('Area of Outflow gauge, km²', { exact: true }).fill('40');
	await grid.getByLabel('Area of Hilltop farm, km²', { exact: true }).fill('14.5');
	await grid.getByLabel('Dam capacity of Hilltop farm, m³').fill('120000');
	await grid.getByLabel('Dam initial storage of Hilltop farm, %').fill('60');
	await grid.getByLabel('Area of Valley farm, km²', { exact: true }).fill('9');

	// The drainage tree follows the table.
	const tree = page.getByRole('list', { name: 'Drainage tree' });
	await expect(tree.getByRole('listitem')).toHaveCount(3);
	await expect(tree.getByRole('listitem').first()).toContainText('Outflow gauge');
	await expect(tree.getByRole('listitem').first()).toContainText('outlet');
	await expect(saveBar(page)).toContainText('Unsaved changes to the model');
	// Done leaves the edits for the save bar.
	await closeModal(page);

	// --- crops, factors and planted areas ------------------------------------
	await tab(page, 'Crops').click();
	// + Add crop opens the new crop's sheet: its name and 12 factors.
	const sheet = await addCrop(page);
	await sheet.getByRole('textbox', { name: 'Crop name' }).fill('Vines');
	await sheet.getByLabel('Vines crop factor, Jan').fill('0.8');
	await sheet.getByLabel('Vines crop factor, Feb').fill('0.75');
	await closeModal(page);
	const unplanted = /(has|have) no planted area, so (its|their) irrigation demand counts as zero\.$/;
	await expect(page.getByText(unplanted)).toHaveText('Hilltop farm and Valley farm have no planted area, so their irrigation demand counts as zero.');
	// Planted areas: the full grid, from the page's Edit areas.
	await page.getByRole('link', { name: 'Edit areas' }).click();
	const areas = page.getByRole('dialog', { name: 'Planted areas' });
	await areas.getByLabel('Vines on Hilltop farm, ha').fill('25');
	// The note follows the unsaved edit.
	await expect(areas.getByText(unplanted)).toHaveText('Valley farm has no planted area, so its irrigation demand counts as zero.');
	await areas.getByLabel('Vines on Valley farm, ha').fill('8');
	await expect(areas.getByText(unplanted)).toBeHidden();
	await expect(areas.getByRole('row', { name: /^Total/ })).toContainText('33.00 ha');
	await closeModal(page);
	// The page's bars and header follow.
	await expect(page.getByTestId('crops-summary')).toHaveText('1 crop · 33 ha irrigated on 2 farms · water year October to September');
	await expect(page.getByRole('img', { name: 'Hilltop farm: 25 ha, Vines 25 ha' })).toBeVisible();

	// --- a transfer from Hilltop to Valley in Dec + Jan ----------------------
	await tab(page, 'Transfers').click();
	// The section header's main action (issue #17).
	await page.getByTestId('section-header').getByRole('button', { name: '+ Add transfer', exact: true }).click();
	await page.getByLabel('Source of transfer 1').selectOption({ label: 'Hilltop farm' });
	await page.getByLabel('Destination of transfer 1').selectOption({ label: 'Valley farm' });
	// A rate for each month it runs (engine 1.14.0).
	await page.getByLabel('Max rate of transfer 1 in Dec, m³/s').fill('0.02');
	await page.getByLabel('Max rate of transfer 1 in Jan, m³/s').fill('0.02');
	await page.getByLabel('Max rate of transfer 1 in Jan, m³/s').press('Tab');
	await expect(ruleCard(page, 1)).toContainText('Dec, Jan, up to 0.02 m³/s');

	// --- save -----------------------------------------------------------------
	const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/projects/${project.id}/model`));
	await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
	expect((await saved).status()).toBe(200);
	await expect(saveBar(page)).toBeHidden();
	await expect(page.getByText('Unsaved changes', { exact: true })).toBeHidden();

	// --- reload: everything came back from the server ------------------------
	await page.reload();
	await expect(page.getByLabel('Source of transfer 1').locator('option:checked')).toHaveText('Hilltop farm');
	await expect(page.getByLabel('Destination of transfer 1').locator('option:checked')).toHaveText('Valley farm');
	await expect(page.getByLabel('Max rate of transfer 1 in Dec, m³/s')).toHaveValue('0.02');
	await expect(page.getByLabel('Max rate of transfer 1 in Jan, m³/s')).toHaveValue('0.02');
	await expect(page.getByLabel('Max rate of transfer 1 in Feb, m³/s')).toHaveValue('');
	await expect(page.getByLabel('transfer 1 enabled')).toBeChecked();

	await tab(page, 'Crops').click();
	const factors = await openCropGrid(page, 'crop-factors');
	await expect(factors.getByRole('textbox', { name: 'Crop name' })).toHaveValue('Vines');
	await expect(factors.getByLabel('Vines crop factor, Jan')).toHaveValue('0.8');
	await expect(factors.getByLabel('Vines crop factor, Feb')).toHaveValue('0.75');
	await expect(factors.getByLabel('Vines crop factor, Mar')).toHaveValue('0');
	await closeModal(page);
	const areasAfter = await openCropGrid(page, 'planted-areas');
	await expect(areasAfter.getByLabel('Vines on Hilltop farm, ha')).toHaveValue('25');
	await expect(areasAfter.getByLabel('Vines on Valley farm, ha')).toHaveValue('8');
	await closeModal(page);
	// The sheet shows the same saved factors.
	const vines = await openCropSheet(page, 'Vines');
	await expect(vines.getByLabel('Vines crop factor, Jan')).toHaveValue('0.8');
	await closeModal(page);

	await tab(page, 'Network').click();
	const table = await openNodeTable(page);
	await expect(table.getByRole('textbox', { name: 'Name' })).toHaveCount(3);
	await expect(table.getByLabel('Area of Hilltop farm, km²', { exact: true })).toHaveValue('14.5');
	await expect(table.getByLabel('Dam capacity of Hilltop farm, m³')).toHaveValue('120000');
	await expect(table.getByLabel('Dam initial storage of Hilltop farm, %')).toHaveValue('60');
	await expect(table.getByLabel('Valley farm drains into').locator('option:checked')).toHaveText('Outflow gauge');
	await expect(saveBar(page)).toBeHidden();
});

test('a second outlet or a loop blocks saving with a message', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Model validation');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=network&grid=nodes`);
	const grid = page.getByRole('dialog', { name: 'Node table' });
	const problems = grid.getByRole('status').filter({ hasText: 'Fix before saving:' });
	const save = grid.getByRole('button', { name: 'Save changes' });

	// Second outlet.
	await page.getByLabel('Lower farm drains into').selectOption({ label: '— Outlet (none) —' });
	await expect(problems).toContainText(
		'The network has 2 outlets ("Outflow gauge", "Lower farm"); exactly one node may drain nowhere.'
	);
	await expect(saveBar(page)).toContainText('1 problem to fix before saving');
	await expect(save).toBeDisabled();
	await expect(tab(page, 'Network')).toContainText('(has problems)');

	// Back to one outlet: the edit is undone, so there is nothing left to save.
	await page.getByLabel('Lower farm drains into').selectOption({ label: 'Outflow gauge' });
	await expect(problems).toBeHidden();
	await expect(saveBar(page)).toBeHidden();

	// A loop: Upper → Lower → Upper.
	await page.getByLabel('Upper farm drains into').selectOption({ label: 'Lower farm' });
	await page.getByLabel('Lower farm drains into').selectOption({ label: 'Upper farm' });
	await expect(problems).toContainText('Cycle in the network:');
	await expect(page.getByText('Not connected to an outlet (loop):')).toBeVisible();
	await expect(save).toBeDisabled();

	// Discard (the grid's, as the save bar's) puts the saved network back.
	await grid.getByRole('button', { name: 'Discard' }).click();
	await expect(saveBar(page)).toBeHidden();
	await expect(problems).toBeHidden();
	await expect(page.getByLabel('Upper farm drains into').locator('option:checked')).toHaveText('Outflow gauge');

	// Nothing invalid reached the server.
	await page.reload();
	await expect(page.getByLabel('Lower farm drains into').locator('option:checked')).toHaveText('Outflow gauge');
	await expect(page.getByLabel('Upper farm drains into').locator('option:checked')).toHaveText('Outflow gauge');
});

test('leaving with unsaved model changes asks first, in the app’s dialog', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Unsaved guard');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=network&grid=nodes`);
	await page.getByLabel('Area of Upper farm, km²', { exact: true }).fill('99');
	await closeModal(page);

	// Stay: the question names where the link goes, and the edit is still there.
	const projectsLink = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Projects' });
	await projectsLink.click();
	await answerConfirm(page, false, 'You have unsaved changes (model edits). Leave and go to All projects? They will be lost.');
	await expect(page.getByTestId('project-name').filter({ hasText: 'Unsaved guard' })).toBeVisible();
	await expect(saveBar(page)).toContainText('Unsaved changes to the model');

	await projectsLink.click();
	await answerConfirm(page, true, 'Leave without saving?');
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
});

test('the one-node sheet is wide enough for three fields a row, each section in its own card', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Roomy sheet');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=network`);
	const sheet = await openNodeForm(page, 'Upper farm');
	expect((await sheet.boundingBox())!.width).toBeGreaterThan(900);

	// Three dam fields share a row.
	const ys = await Promise.all(['Capacity (m³)', 'Initial (%)', 'Minimum level (%)'].map(async (l) => (await sheet.getByLabel(l).boundingBox())!.y));
	expect(new Set(ys.map(Math.round)).size).toBe(1);

	// Sections are boxed apart: Dam's card ends before Routing's starts, with a gap between.
	const dam = (await sheet.getByRole('group', { name: 'Dam', exact: true }).boundingBox())!;
	const routing = (await sheet.getByRole('group', { name: 'Routing', exact: true }).boundingBox())!;
	expect(routing.y - (dam.y + dam.height)).toBeGreaterThanOrEqual(12);
	await expect(sheet.getByRole('group', { name: 'Dam', exact: true })).toHaveCSS('border-top-style', 'solid');
});

test('large values show thousands separators in the one-node form and the view-only table', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Separators');
	await putModel(page.request, project.id, sampleModel()); // Upper farm: 150 000 m³ dam
	await page.goto(`/projects/${project.id}?tab=network`);
	await openNodeForm(page);
	await page.getByRole('dialog').getByLabel('Node to edit').selectOption({ label: '2. Upper farm · hydrological unit' });

	const capacity = page.getByLabel('Capacity (m³)');
	await expect(capacity).toHaveValue('150\u202f000');
	// Editing starts from the plain number; typed separators are accepted.
	await capacity.focus();
	await expect(capacity).toHaveValue('150000');
	await capacity.fill('300 000');
	await capacity.blur();
	await expect(capacity).toHaveValue('300\u202f000');
	// The editable table keeps plain numbers.
	await closeModal(page);
	await openNodeTable(page);
	await expect(page.getByLabel('Dam capacity of Upper farm, m³')).toHaveValue('300000');
	await saveModelChanges(page);
	await expect(saveBar(page)).toBeHidden();

	const viewer = await signIn('Separators viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=network&grid=nodes`);
	await expect(viewer.page.getByLabel('Dam capacity of Upper farm, m³')).toHaveValue('300\u202f000');
	await expect(viewer.page.getByLabel('Dam capacity of Lower farm, m³')).toHaveValue('90\u202f000');
});

test.describe('network layout', () => {
	// Beside the workspace sidebar (issue #17) the table fits from about 1700 px; narrower, it scrolls (next test).
	test('the node table fits a 1920px screen beside the sidebar, flow share and remove included', async ({ page, owner }) => {
		void owner;
		await page.setViewportSize({ width: 1920, height: 1000 });
		const project = await createProject(page.request, 'Network fit');
		await putModel(page.request, project.id, sampleModel());
		await page.goto(`/projects/${project.id}?tab=network&grid=nodes`);

		const table = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: /In use/ }) });
		await expect(table.getByRole('textbox', { name: 'Name' })).toHaveCount(3);
		// Field headers wrap rather than widen their columns, so nothing is hidden off to the right.
		const overflow = await table.evaluate((t) => t.parentElement!.scrollWidth - t.parentElement!.clientWidth);
		expect(overflow).toBeLessThanOrEqual(0);
		await expect(table.getByRole('columnheader', { name: /In use/ })).toBeInViewport();
		await expect(table.getByRole('button', { name: 'Remove Lower farm' })).toBeInViewport();
		// The header row reads as one even band: every field's ⓘ sits on the same line (with its unit).
		const tipTops = await table.locator('thead th.fh button').evaluateAll((bs) => bs.map((b) => Math.round(b.getBoundingClientRect().top)));
		expect(tipTops.length).toBeGreaterThan(10);
		expect(new Set(tipTops).size).toBe(1);
		// Numbers are right-aligned, and each total's digits line up with the digits above it.
		const aligned = await table.evaluate((t) => {
			const foot = t.querySelector('tfoot tr')!;
			const row = [...t.querySelectorAll('tbody tr')].find((r) => r.querySelectorAll('td input').length > 5)!;
			return [...foot.children].flatMap((cell, i) => {
				const input = row.children[i]?.querySelector('input');
				if (!input || !cell.matches('td.num') || !cell.textContent!.trim()) return [];
				const range = document.createRange();
				range.selectNodeContents(cell);
				const cs = getComputedStyle(input);
				const digits = input.getBoundingClientRect().right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
				return [{ align: cs.textAlign, gap: Math.abs(range.getBoundingClientRect().right - digits) }];
			});
		});
		// Area and dam capacity carry totals.
		expect(aligned.length).toBe(2);
		for (const a of aligned) {
			expect(a.align).toBe('right');
			expect(a.gap).toBeLessThanOrEqual(1);
		}
		// A seven-digit dam capacity shows in full, not clipped by its box.
		const capacity = table.getByLabel('Dam capacity of Upper farm, m³');
		await capacity.fill('1340000');
		expect(await capacity.evaluate((i: HTMLInputElement) => i.scrollWidth - i.clientWidth)).toBeLessThanOrEqual(0);
		expect(await table.evaluate((t) => t.parentElement!.scrollWidth - t.parentElement!.clientWidth)).toBeLessThanOrEqual(0);
	});

	test('narrower, the node table scrolls in its box with each row named and removable at either end', async ({ page, owner }) => {
		void owner;
		await page.setViewportSize({ width: 1100, height: 900 });
		const project = await createProject(page.request, 'Network narrow');
		await putModel(page.request, project.id, sampleModel());
		await page.goto(`/projects/${project.id}?tab=network&grid=nodes`);

		const table = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: /In use/ }) });
		await expect(table.getByRole('textbox', { name: 'Name' })).toHaveCount(3);
		const box = table.locator('xpath=..');
		expect(await box.evaluate((b) => b.scrollWidth > b.clientWidth)).toBe(true);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1100);
		const name = table.getByRole('textbox', { name: 'Name' }).last();
		const remove = table.getByRole('button', { name: 'Remove Lower farm' });
		for (const end of ['right', 'left'] as const) {
			await box.evaluate((b, e) => (b.scrollLeft = e === 'right' ? b.scrollWidth : 0), end);
			await expect(name).toBeInViewport({ ratio: 1 });
			await expect(remove).toBeInViewport({ ratio: 1 });
		}
	});

	test.describe('phone', () => {
		test.use({ viewport: { width: 390, height: 844 } });

		test('a schematic tap picks a node; Edit opens its form full screen, the picker staying at the top as it scrolls', async ({ page, owner }) => {
			void owner;
			const project = await createProject(page.request, 'Network phone');
			await putModel(page.request, project.id, sampleModel());
			await page.goto(`/projects/${project.id}?tab=network`);

			// Tapping a node on the drawing picks it: its card below the map names it.
			await page.locator('svg.schematic g.node').filter({ hasText: 'Upper farm' }).click();
			const card = page.getByTestId('node-card');
			await expect(card.getByRole('heading', { name: 'Upper farm' })).toBeVisible();

			// Edit opens the full form in a sheet the width of the screen.
			await card.getByRole('button', { name: 'Edit Upper farm' }).click();
			const sheet = page.getByRole('dialog', { name: 'Edit Upper farm' });
			const picker = sheet.getByLabel('Node to edit');
			await expect(picker.locator('option:checked')).toHaveText('2. Upper farm · hydrological unit');
			await expect(sheet.getByLabel('Name', { exact: true })).toHaveValue('Upper farm');
			expect((await sheet.boundingBox())!.width).toBeGreaterThan(370);
			// The sheet's actions: no Move up / Move down (row order is the node table's, issue #174), and Remove.
			await expect(sheet.getByRole('button', { name: 'Remove Upper farm' })).toBeVisible();
			await expect(sheet.getByRole('button', { name: /^Move (up|down) the list$/ })).toHaveCount(0);

			// Deep in the farm form, the picker and ‹ › are still on screen, at the top of the sheet.
			await sheet.getByLabel('Losses returning (%)').scrollIntoViewIfNeeded();
			await expect(picker).toBeInViewport();
			await expect(sheet.getByRole('button', { name: 'Next node' })).toBeInViewport();
			await sheet.getByRole('button', { name: 'Next node' }).click();
			await expect(page.getByRole('dialog', { name: 'Edit Lower farm' }).getByLabel('Node to edit').locator('option:checked')).toHaveText('3. Lower farm · hydrological unit');
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
		});
	});
});

test('the schematic can colour farms by the latest run’s supply, and says which run', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Supply colours');
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}?tab=network`);

	const colourBy = page.getByLabel('Colour hydrological units by');
	// On by default once there is a run (issue #17: the map answers "who is short?" first).
	await expect(colourBy.locator('option:checked')).toHaveText('Supply, latest run');
	const upper = page.locator('svg.schematic g.node').filter({ hasText: 'Upper farm' });
	await expect(page.getByText(/^Hydrological units coloured by share of irrigation demand supplied in run “Baseline”, ran today\./)).toBeVisible();
	await expect(upper).toHaveAttribute('data-supply', /^(met|short|low|none)$/);
	// Not colour-only: the share (or "no demand") is on the node's label and in the drainage tree.
	await expect(upper).toContainText(/(\d+% supplied|no demand)/);
	await expect(page.getByRole('list', { name: 'Drainage tree' }).getByRole('listitem').filter({ hasText: 'Upper farm' })).toContainText(/(\d+% supplied|no demand)/);
	// Gauges are never coloured.
	await expect(page.locator('svg.schematic g.node').filter({ hasText: 'Outflow gauge' })).not.toHaveAttribute('data-supply');

	// A farm added since the run shows as "not in this run", and the colours are said to be the run's, not the edit's.
	await page.getByRole('button', { name: '+ Add node' }).click();
	const added = page.locator('svg.schematic g.node[data-supply="absent"]');
	await expect(added).toHaveCount(1);
	await expect(added).toContainText('not in this run');
	await expect(page.getByText('The colours show that run, not your unsaved changes.')).toBeVisible();

	// Back to Nothing: today's plain drawing.
	await colourBy.selectOption({ label: 'Nothing' });
	await expect(page.locator('svg.schematic g.node[data-supply]')).toHaveCount(0);
	await expect(page.getByText(/^Hydrological units coloured by/)).toHaveCount(0);
});
