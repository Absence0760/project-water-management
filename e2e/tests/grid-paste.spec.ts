// Pasting a block from a spreadsheet into the node table and the
// planted-areas and crop-factor grids (issue #285): a block pasted into a cell opens the
// preview with every value it would change, Apply writes them into the grid
// (unsaved, as if typed), and Save keeps them. The mapping itself is unit
// tested (frontend/src/lib/spreadsheet/paste, network/nodePaste.ts,
// crops/areaPaste.ts); this pins the paste event, the preview and the save.
import type { Locator, Page } from '@playwright/test';
import { addMember, createProject, putModel, sampleModel } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';

/** Paste `text` into a cell's input as Excel's clipboard would hand it over. */
async function pasteInto(input: Locator, text: string) {
	await input.focus();
	await input.evaluate((el, t) => {
		const data = new DataTransfer();
		data.setData('text/plain', t);
		el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
	}, text);
}

/** The CSV the preview's download link holds. */
async function templateCsv(dialog: Locator): Promise<string> {
	const href = (await dialog.getByRole('link', { name: 'Download the table as CSV' }).getAttribute('href'))!;
	return decodeURIComponent(href.slice(href.indexOf(',') + 1));
}

async function save(page: Page, projectId: string, grid: Locator) {
	const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/projects/${projectId}/model`));
	await grid.getByRole('button', { name: 'Save changes' }).click();
	expect((await saved).status()).toBe(200);
}

test('node table: a pasted block is previewed, applied and saved', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Grid paste nodes');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=network&grid=nodes`);
	const grid = page.getByRole('dialog', { name: 'Node table' });

	// Names and headings (an SA-locale copy: decimal commas), pasted into any cell, rows in any order.
	await pasteInto(grid.getByLabel('Area of Upper farm, km²', { exact: true }), 'Name\tArea (km²)\tEfficiency (%)\tTotal\nLower farm\t9,5\t75\t1\nNowhere farm\t1\t1\t1\n');
	const dlg = page.getByRole('dialog', { name: 'Paste into the node table' });
	await expect(dlg.getByTestId('paste-summary')).toHaveText('2 values change.');
	await expect(dlg.getByRole('row', { name: /Lower farm Area km² 8 9\.5/ })).toBeVisible();
	await expect(dlg.getByRole('row', { name: /Lower farm Efficiency % 80 75/ })).toBeVisible();
	await expect(dlg.getByText("Left out a row the table doesn't have: Nowhere farm.")).toBeVisible();
	await expect(dlg.getByText("Left out a column the table doesn't have: Total.")).toBeVisible();
	await expect(dlg.getByText('Decimal commas were read as decimal points (1,207 = 1.207).')).toBeVisible();
	// The table as a CSV, to fill in.
	expect(await templateCsv(dlg)).toMatch(/^﻿Name,Area \(km²\),High-MAP area \(km²\),Low-MAP area \(km²\),Dam capacity \(m³\),/);
	await expectNoViolations(page);
	await dlg.getByRole('button', { name: 'Apply 2 changes' }).click();
	await expect(dlg).toBeHidden();
	await expect(grid.getByLabel('Area of Lower farm, km²', { exact: true })).toHaveValue('9.5');
	await expect(grid.getByLabel('Irrigation efficiency of Lower farm, %')).toHaveValue('75');

	// A bare block of numbers fills from the cell it was pasted into.
	await pasteInto(grid.getByLabel('Area of Upper farm, km²', { exact: true }), '20\t2\t3\n');
	await expect(dlg.getByTestId('paste-where')).toContainText('Upper farm, Area');
	await expect(dlg.getByTestId('paste-summary')).toHaveText('3 values change.');
	await dlg.getByRole('button', { name: 'Apply 3 changes' }).click();
	await expect(grid.getByLabel('High-MAP area of Upper farm, km²')).toHaveValue('2');

	// A single value is the input's own paste: no preview.
	await pasteInto(grid.getByLabel('Area of Lower farm, km²', { exact: true }), '7\r\n');
	await expect(dlg).toBeHidden();

	await save(page, project.id, grid);
	await page.reload();
	const again = page.getByRole('dialog', { name: 'Node table' });
	await expect(again.getByLabel('Area of Lower farm, km²', { exact: true })).toHaveValue('9.5');
	await expect(again.getByLabel('Irrigation efficiency of Lower farm, %')).toHaveValue('75');
	await expect(again.getByLabel('Area of Upper farm, km²', { exact: true })).toHaveValue('20');
	await expect(again.getByLabel('Low-MAP area of Upper farm, km²')).toHaveValue('3');
});

test('planted areas: the toolbar paste reads hectares by farm and crop, refuses a bad cell, and saves', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Grid paste areas');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=crops&grid=planted-areas`);
	const grid = page.getByRole('dialog', { name: 'Planted areas' });
	await grid.getByRole('button', { name: 'Paste from a spreadsheet…' }).click();
	const dlg = page.getByRole('dialog', { name: 'Paste planted areas' });
	expect(await templateCsv(dlg)).toBe('﻿Farm,Orchard (ha)\r\nUpper farm,20\r\nLower farm,12\r\n');

	const box = dlg.getByLabel('Cells copied from a spreadsheet');
	await box.fill('Farm\tOrchard (ha)\nLower farm\tlots\n');
	await expect(dlg.getByText('Lower farm, Orchard: “lots” isn\'t a number.')).toBeVisible();
	await expect(dlg.getByRole('button', { name: 'Apply 0 changes' })).toBeDisabled();
	await box.fill('Farm\tOrchard (ha)\nLower farm\t15,5\nUpper farm\t20\n');
	await expect(dlg.getByTestId('paste-summary')).toHaveText('1 value changes; 1 already has the pasted value.');
	await dlg.getByRole('button', { name: 'Apply 1 change' }).click();
	await expect(grid.getByLabel('Orchard on Lower farm, ha')).toHaveValue('15.5');

	await save(page, project.id, grid);
	await page.reload();
	await expect(page.getByRole('dialog', { name: 'Planted areas' }).getByLabel('Orchard on Lower farm, ha')).toHaveValue('15.5');
});

test('crop factors: a pasted 12-month row is previewed, applied and saved; the sheet takes one too', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Grid paste factors');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=crops&grid=crop-factors`);
	const grid = page.getByRole('dialog', { name: 'Crop factors' });

	// One row copied from Excel, pasted into Oct: the 12 months from there.
	await pasteInto(grid.getByLabel('Orchard crop factor, Oct'), '0.4\t0.5\t0.6\t0.7\t0.8\t0.7\t0.6\t0.5\t0.4\t0.4\t0.5\t0.6\n');
	const dlg = page.getByRole('dialog', { name: 'Paste crop factors' });
	await expect(dlg.getByTestId('paste-where')).toContainText('Orchard, Oct');
	await expect(dlg.getByTestId('paste-summary')).toHaveText('4 values change; 8 already have the pasted value.');
	expect(await templateCsv(dlg)).toBe('﻿Crop,Oct,Nov,Dec,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep\r\nOrchard,0.6,0.7,0.8,0.8,0.8,0.7,0.6,0.5,0.4,0.4,0.5,0.6\r\n');
	await expectNoViolations(page);
	await dlg.getByRole('button', { name: 'Apply 4 changes' }).click();
	await expect(dlg).toBeHidden();
	await expect(grid.getByLabel('Orchard crop factor, Oct')).toHaveValue('0.4');
	await expect(grid.getByLabel('Orchard crop factor, Jan')).toHaveValue('0.7');

	// A negative factor stops the paste with where it is.
	await grid.getByRole('button', { name: 'Paste from a spreadsheet…' }).click();
	await dlg.getByLabel('Cells copied from a spreadsheet').fill('Crop\tJan\nOrchard\t-1\n');
	await expect(dlg.getByText('Orchard, Jan: a crop factor of -1 is below 0.')).toBeVisible();
	await dlg.getByRole('button', { name: 'Cancel' }).click();

	await save(page, project.id, grid);
	await page.reload();
	await expect(page.getByRole('dialog', { name: 'Crop factors' }).getByLabel('Orchard crop factor, Nov')).toHaveValue('0.5');

	// The crop's sheet: a row pasted into a month, previewed and applied the same way.
	await page.goto(`/projects/${project.id}?tab=crops`);
	await page.getByRole('button', { name: 'Edit Orchard' }).click();
	const sheet = page.getByRole('dialog', { name: 'Edit Orchard' });
	await pasteInto(sheet.getByLabel('Orchard crop factor, Jul'), '0.9\t0.9\t0.9\n');
	const sheetDlg = page.getByRole('dialog', { name: 'Paste Orchard\'s crop factors' });
	await expect(sheetDlg.getByTestId('paste-where')).toContainText('Orchard, Jul');
	await sheetDlg.getByRole('button', { name: 'Apply 3 changes' }).click();
	await expect(sheet.getByLabel('Orchard crop factor, Sep')).toHaveValue('0.9');
	await expect(sheet).toContainText('Unsaved changes to the model');
});

test('thirty nodes: the whole table pasted back changed scrolls in its own list, from the keyboard too; Escape closes it; a viewer has no paste', async ({ page, owner, signIn }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Grid paste big');
	const model = sampleModel();
	const [gauge, farm] = [model.nodes[0]!, model.nodes[1]!];
	model.nodes = [gauge, ...Array.from({ length: 29 }, (_, i) => ({ ...farm, id: crypto.randomUUID(), name: `Unit ${i + 1}`, sortOrder: i + 2 }))];
	model.cropAreas = [];
	model.transfers = [];
	await putModel(page.request, project.id, model);
	await page.goto(`/projects/${project.id}?tab=network&grid=nodes`);
	const grid = page.getByRole('dialog', { name: 'Node table' });
	const open = grid.getByRole('button', { name: 'Paste from a spreadsheet…' });
	await open.click();
	const dlg = page.getByRole('dialog', { name: 'Paste into the node table' });
	await expect(dlg.getByTestId('paste-where')).toHaveText("A block without names or headings starts at the table's first row and column.");
	// The template, every unit's area 12 → 13 km².
	const csv = (await templateCsv(dlg)).replace(/^\ufeff/, '').replace(/^(Unit \d+),12,/gm, '$1,13,');
	await dlg.getByLabel('Cells copied from a spreadsheet').fill(csv);
	await expect(dlg.getByTestId('paste-summary')).toHaveText(/^29 values change; \d+ already have the pasted value\.$/);
	const list = dlg.getByRole('region', { name: 'Changes' });
	const [sh, ch] = await list.evaluate((el) => [el.scrollHeight, el.clientHeight]);
	expect(sh).toBeGreaterThan(ch!);
	await list.focus();
	await page.keyboard.press('End');
	await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
	await expectNoViolations(page);
	await page.keyboard.press('Escape');
	await expect(dlg).toBeHidden();
	await expect(open).toBeFocused();
	await expect(grid.getByLabel('Area of Unit 1, km²', { exact: true })).toHaveValue('12');

	// A viewer: no button, and a block pasted into a (read-only) cell opens nothing.
	const viewer = await signIn('Grid paste viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.goto(`/projects/${project.id}?tab=network&grid=nodes`);
	const vGrid = v.getByRole('dialog', { name: 'Node table' });
	await expect(vGrid.getByLabel('Area of Unit 1, km²', { exact: true })).toBeVisible();
	await expect(vGrid.getByRole('button', { name: 'Paste from a spreadsheet…' })).toHaveCount(0);
	await pasteInto(vGrid.getByLabel('Area of Unit 1, km²', { exact: true }), '1\t2\n');
	await expect(v.getByRole('dialog', { name: 'Paste into the node table' })).toHaveCount(0);
});

test.describe('phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('a block pasted into a planted-area card opens the preview, which passes the a11y scan', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Grid paste phone');
		await putModel(page.request, project.id, sampleModel());
		await page.goto(`/projects/${project.id}?tab=crops&grid=planted-areas`);
		const grid = page.getByRole('dialog', { name: 'Planted areas' });
		await pasteInto(grid.getByLabel('Orchard on Upper farm, ha'), '25\n13\n');
		const dlg = page.getByRole('dialog', { name: 'Paste planted areas' });
		await expect(dlg.getByTestId('paste-where')).toContainText('Upper farm, Orchard');
		await expect(dlg.getByTestId('paste-summary')).toHaveText('2 values change.');
		await expectNoViolations(page);
		await dlg.getByRole('button', { name: 'Apply 2 changes' }).click();
		await expect(grid.getByLabel('Orchard on Lower farm, ha')).toHaveValue('13');
	});
});
