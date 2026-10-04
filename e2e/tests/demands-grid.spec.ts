// The Demands grid (Network → Tables → Demands, the grid modal's
// `grid=demands`, docs/ui.md § Demands grid): every demand in the catchment
// in one table, a unit's crops and demand objects in its supply order, then
// each other water user; an editor types a monthly demand in place, and a
// row's Edit opens the rest in its node's form. Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createProject, putModel, sampleModel } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { saveModelChanges } from '../support/network.ts';

const grid = (page: Page) => page.getByTestId('demands-grid');

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
	await expect(grid(page).locator('tr', { has: page.getByRole('rowheader', { name: /^Quarry/ }) })).toContainText('junior');
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
