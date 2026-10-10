// The Demands grid (Network → Tables → Demands, the grid modal's
// `grid=demands`, docs/ui.md § Demands grid): every demand in the catchment
// in one table, a unit's crops and demand objects in its supply order, then
// each other water user; an editor types a monthly demand in place, and a
// row's Edit opens the rest in its node's form. Synthetic data only.
import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createProject, putModel, sampleModel } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { saveModelChanges } from '../support/network.ts';
import { expectAbove } from '../support/reflow.ts';

const grid = (page: Page) => page.getByTestId('demands-grid');

/** Paste `text` into a cell's input as Excel's clipboard would hand it over. */
async function pasteInto(input: Locator, text: string) {
	await input.focus();
	await input.evaluate((el, t) => {
		const data = new DataTransfer();
		data.setData('text/plain', t);
		el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
	}, text);
}

function demandsModel() {
	const m = sampleModel();
	const [gauge, upper] = m.nodes as { id: string; name: string }[];
	const object = (id: string, name: string, extra: Record<string, unknown>) => ({
		id,
		nodeId: upper!.id,
		name,
		category: 'municipal',
		sizing: 'monthly',
		monthlyM3Day: new Array(12).fill(100),
		count: null,
		litresPerUnitDay: null,
		lossPct: 0,
		monthlyFactor: null,
		returnPct: 0,
		priority: 'first',
		destination: 'internal',
		enabled: true,
		note: '',
		...extra
	});
	const user = {
		...(m.nodes[1] as object),
		id: crypto.randomUUID(),
		name: 'Quarry',
		kind: 'user',
		downstreamNodeId: gauge!.id,
		sortOrder: 4,
		damCapacityM3: 0,
		userDemandM3Day: new Array(12).fill(40),
		userReturnPct: 0,
		userPriority: 'junior'
	};
	return {
		...m,
		nodes: [...m.nodes, user],
		demandObjects: [
			object(crypto.randomUUID(), 'Town', {}),
			object(crypto.randomUUID(), 'Cattle', { category: 'livestock', sizing: 'perUnit', monthlyM3Day: null, count: 200, litresPerUnitDay: 50, priority: 'last' })
		]
	};
}

test('every demand in one table: the supply order, a monthly demand typed in place and saved, and Edit opening the node form', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Demands grid');
	const model = demandsModel();
	await putModel(page.request, project.id, model);
	const upper = model.nodes[1] as { id: string };

	// From the Network's Tables menu, in the grid modal.
	await page.goto(`/projects/${project.id}?tab=network`);
	await page.locator('details.grids-menu summary').click();
	await page.getByRole('group', { name: 'Open as a table' }).getByRole('link', { name: 'Demands', exact: true }).click();
	await expect(page).toHaveURL(/grid=demands/);
	await expect(page.getByRole('dialog', { name: 'Demands' })).toBeVisible();

	// Upper farm in its supply order (Town first, the crops, Cattle last), Lower farm's crops, then the other user.
	const rows = grid(page).locator('tbody tr');
	await expect(rows.locator('th')).toContainText([/^Town/, /^Crops/, /^Cattle/, /^Crops/, /^Quarry/]);
	const town = grid(page).locator('tr', { has: page.getByRole('rowheader', { name: /^Town/ }) });
	await expect(town).toContainText('1 of 3');
	await expect(grid(page).locator('tr', { has: page.getByRole('rowheader', { name: /^Cattle/ }) })).toContainText('200 × 50 l a day');
	await expect(grid(page).locator('tr', { has: page.getByRole('rowheader', { name: /^Quarry/ }) })).toContainText('Non-priority');
	await expectNoViolations(page, { include: '[data-testid="demands-grid"]' });

	// A monthly object's Oct, typed here, counts in the catchment row and survives a save and a reload.
	const tfootOct = grid(page).locator('tfoot td.num').first();
	const before = Number((await tfootOct.innerText()).replace(/\s/g, ''));
	await page.getByLabel('Town, Oct, m³/day').fill('250');
	await page.getByLabel('Town, Oct, m³/day').press('Tab');
	await expect(tfootOct).toHaveText(String(before + 150));
	expect((await saveModelChanges(page)).status()).toBe(200);
	await page.reload();
	await expect(page.getByRole('dialog', { name: 'Demands' })).toBeVisible();
	await expect(page.getByLabel('Town, Oct, m³/day')).toHaveValue('250');
	// A per-person object's months are made from its count, not typed here.
	await expect(page.getByLabel('Cattle, Oct, m³/day')).toHaveCount(0);

	// Edit opens the unit's form on the Network, the modal closed.
	await page.getByRole('link', { name: 'Edit Town on Upper farm' }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]edit=${upper.id}`));
	await expect(page).not.toHaveURL(/grid=/);
	await expect(page.getByRole('dialog', { name: /Upper farm/ })).toBeVisible();
});

test('the display unit: l/s in the URL, a value typed in l/s stored as m³/day, kept on reload', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Demands grid unit');
	await putModel(page.request, project.id, demandsModel());
	await page.goto(`/projects/${project.id}?tab=network&grid=demands`);
	await expect(page.getByRole('dialog', { name: 'Demands' })).toBeVisible();

	// 100 m³/day is 1.16 l/s (100 ÷ 86.4); the headers and labels name the unit.
	await page.getByLabel('Show demands in').selectOption({ label: 'l/s' });
	await expect(page).toHaveURL(/[?&]unit=ls/);
	await expect(grid(page).locator('thead')).toContainText('l/s');
	await expect(page.getByLabel('Town, Oct, l/s')).toHaveValue('1.16');
	// The user's 40 m³/day is 0.46 l/s, as text in its cell's input.
	await expect(page.getByLabel('Quarry, Oct, l/s')).toHaveValue('0.46');

	// 2 l/s typed is 172.8 m³/day in the model.
	await page.getByLabel('Town, Oct, l/s').fill('2');
	await page.getByLabel('Town, Oct, l/s').press('Tab');
	expect((await saveModelChanges(page)).status()).toBe(200);
	const res = await page.request.get(`${API_URL}/projects/${project.id}/model`);
	const saved = (await res.json()) as { demandObjects: { name: string; monthlyM3Day: number[] }[] };
	expect(saved.demandObjects.find((o) => o.name === 'Town')!.monthlyM3Day[0]).toBeCloseTo(172.8, 6);

	// A reload keeps the unit; back to m³/day reads the stored value.
	await page.reload();
	await expect(page.getByLabel('Show demands in')).toHaveValue('ls');
	await expect(page.getByLabel('Town, Oct, l/s')).toHaveValue('2');
	await page.getByLabel('Show demands in').selectOption({ label: 'm³/day' });
	await expect(page).not.toHaveURL(/unit=/);
	await expect(page.getByLabel('Town, Oct, m³/day')).toHaveValue('172.8');
	await expect(page.getByRole('dialog', { name: 'Demands' })).toBeVisible();
});

test('a phone: the table scrolls inside its region, the page itself never sideways', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 390, height: 844 });
	const project = await createProject(page.request, 'Demands grid phone');
	await putModel(page.request, project.id, demandsModel());
	await page.goto(`/projects/${project.id}?tab=network&grid=demands`);
	await expect(page.getByRole('dialog', { name: 'Demands' })).toBeVisible();
	await expect(grid(page).getByRole('region', { name: 'Demands by month' })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await expectNoViolations(page, { include: '[data-testid="demands-grid"]' });
});

test('a block pasted from a spreadsheet: previewed, computed rows left out, applied and saved; the table downloads as CSV', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Demands grid paste');
	await putModel(page.request, project.id, demandsModel());
	await page.goto(`/projects/${project.id}?tab=network&grid=demands`);
	await expect(page.getByRole('dialog', { name: 'Demands' })).toBeVisible();

	// Names and month headings, in any order; the crops and a per-head demand take no paste, and the preview says so.
	await pasteInto(page.getByLabel('Town, Oct, m³/day'), 'Demand\tNov (m³/day)\tOct\nQuarry\t45\t\nTown\t120\t130\nCattle\t9\t9\nNowhere\t1\t1\n');
	const dlg = page.getByRole('dialog', { name: 'Paste demands' });
	await expect(dlg.getByTestId('paste-summary')).toHaveText('3 values change.');
	await expect(dlg.getByRole('row', { name: /Town Oct m³\/day 100 130/ })).toBeVisible();
	await expect(dlg.getByText("Left out a row the table doesn't have: Nowhere.")).toBeVisible();
	await expect(dlg.getByText(/^Left out a row whose months are made from other values .*: Cattle\.$/)).toBeVisible();
	await expectNoViolations(page);
	await dlg.getByRole('button', { name: 'Apply 3 changes' }).click();
	await expect(dlg).toBeHidden();
	await expect(page.getByLabel('Town, Oct, m³/day')).toHaveValue('130');
	await expect(page.getByLabel('Quarry, Nov, m³/day')).toHaveValue('45');

	// One copied row of 12 months, pasted into a cell, fills that demand from there.
	await pasteInto(page.getByLabel('Quarry, Oct, m³/day'), `${new Array(12).fill('7').join('\t')}\n`);
	await expect(dlg.getByTestId('paste-where')).toContainText('Quarry, Oct');
	await dlg.getByRole('button', { name: 'Apply 12 changes' }).click();
	await expect(page.getByLabel('Quarry, Sep, m³/day')).toHaveValue('7');
	expect((await saveModelChanges(page)).status()).toBe(200);
	await page.reload();
	await expect(page.getByLabel('Town, Oct, m³/day')).toHaveValue('130');
	await expect(page.getByLabel('Quarry, Nov, m³/day')).toHaveValue('7');

	// The table as shown, as a CSV, from the actions row above the table, not under its totals and note (issue #463).
	const actions = grid(page).getByTestId('grid-actions');
	await expect(actions.getByRole('button')).toHaveText(['Paste from a spreadsheet…', 'Download the table as CSV']);
	await expectAbove(actions, grid(page).locator('table tbody tr').first());
	const [download] = await Promise.all([page.waitForEvent('download'), grid(page).getByRole('button', { name: 'Download the table as CSV' }).click()]);
	expect(download.suggestedFilename()).toBe('demands.csv');
	const csv = await readFile((await download.path())!, 'utf8');
	expect(csv).toMatch(/^\uFEFFDemand,Unit,Kind,Water from,Supply order,Oct \(m³\/day\),/);
	expect(csv).toContain('\r\nTown,Upper farm,Municipal (town),dam side,1 of 3,130,120,100,');
	expect(csv).toContain('\r\nCrops (Lower farm),Lower farm,Irrigation (crops),');
});
