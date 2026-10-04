// A flow rate's unit (docs/ui.md § Flow units): River to dam, the pumps and
// boreholes, and a transfer's max rate each have a unit picker beside them,
// m³/s, l/s or m³/day. Only the display changes: the model keeps its stored
// unit (River to dam and pumps m³/day, a transfer m³/s), and the pick lasts in
// this browser across a reload. Synthetic data only.
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { createProject, putModel, sampleModel } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openNodeForm, saveModelChanges } from '../support/network.ts';
import { openTransfers } from '../support/transfers.ts';

type Model = { nodes: { name: string; divertCapacityM3Day: number; pumpCapacityM3Day: number | null }[]; transfers: { maxRateM3s: number; monthlyRateM3s?: number[] | null }[] };
const model = async (page: import('@playwright/test').Page, id: string) => (await (await page.request.get(`${API_URL}/projects/${id}/model`)).json()) as Model;

test('River to dam, a river pump and a transfer entered in l/s are stored in their own units, and the picks last', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Flow units');
	await putModel(page.request, project.id, sampleModel());

	// River to dam in l/s, in the unit form: 200 l/s is 17 280 m³/day.
	await page.goto(`/projects/${project.id}?tab=network`);
	const sheet = await openNodeForm(page, 'Upper farm');
	await expect(sheet.getByLabel('River to dam (m³/s)')).toBeVisible();
	// The unit shows once, in the select (the label keeps it for a screen reader), and the select is a 24 px target.
	await expect(sheet.locator('label[for^="nd-divertCapacityM3Day-"]')).toHaveText('River to dam (m³/s)');
	await expect(sheet.locator('label[for^="nd-divertCapacityM3Day-"] .u')).toHaveCount(0);
	expect((await sheet.getByLabel('Unit of river to dam').boundingBox())!.height).toBeGreaterThanOrEqual(24);
	await sheet.getByLabel('Unit of river to dam').selectOption('ls');
	await sheet.getByLabel('River to dam (l/s)').fill('200');
	await sheet.getByLabel('River to dam (l/s)').press('Tab');
	// A river pump, in l/s too: 5 l/s is 432 m³/day; the calculator's line follows the unit.
	const supply = sheet.getByRole('group', { name: 'Supply', exact: true });
	await supply.getByLabel('Supply rule', { exact: true }).selectOption({ label: 'River first' });
	await supply.getByLabel('Unit of river pump capacity').selectOption('ls');
	await supply.getByLabel('Number of pumps').fill('2');
	await supply.getByLabel('m³/h per pump').fill('9');
	await expect(supply.getByTestId('pump-note')).toHaveText('2 × 9 m³/h × 24 h = 432 m³/day (5 l/s).');
	await expect(supply.getByLabel('River pump capacity (l/s)')).toHaveValue('5');
	await expectNoViolations(page, { include: '.detail' });
	await saveModelChanges(page);
	const upper = (await model(page, project.id)).nodes.find((n) => n.name === 'Upper farm')!;
	expect(upper.divertCapacityM3Day).toBeCloseTo(17_280, 6);
	expect(upper.pumpCapacityM3Day).toBeCloseTo(432, 6);

	// The node table's River to dam heading has the same picker, already on l/s.
	await page.goto(`/projects/${project.id}?tab=network&grid=nodes`);
	await expect(page.getByRole('columnheader', { name: /River to dam/ }).getByLabel('Unit of river to dam')).toHaveValue('ls');
	await expect(page.getByLabel('River to dam at Upper farm, l/s')).toHaveValue('200');

	// A transfer's rate: the sample's 0.01 m³/s reads 10 l/s; Oct at 20 l/s is 0.02 m³/s.
	await openTransfers(page, project.id);
	// One picker for every rule, in the Transfer rules heading; each rule's title names the unit.
	await expect(page.getByLabel('Unit of transfer rates')).toHaveCount(1);
	await page.getByLabel('Unit of transfer rates').selectOption('ls');
	await expect(page.getByTestId('transfer-rule').first().locator('.g-rates .grp-t')).toContainText('l/s');
	await expect(page.getByLabel('Max rate of transfer 1 in Nov, l/s', { exact: true })).toHaveValue('10');
	await expect(page.getByRole('group', { name: /^Max rate of transfer 1 by month/ })).toContainText('up to 10 l/s');
	await page.getByLabel('Max rate of transfer 1 in Oct, l/s', { exact: true }).fill('20');
	await page.getByLabel('Max rate of transfer 1 in Oct, l/s', { exact: true }).press('Tab');
	await saveModelChanges(page);
	const t = (await model(page, project.id)).transfers[0]!;
	expect(t.monthlyRateM3s![0]).toBeCloseTo(0.02, 9);

	// The picks last across a reload, in this browser.
	await page.reload();
	await expect(page.getByLabel('Max rate of transfer 1 in Oct, l/s', { exact: true })).toHaveValue('20');
	await page.goto(`/projects/${project.id}?tab=network`);
	const again = await openNodeForm(page, 'Upper farm');
	await expect(again.getByLabel('River to dam (l/s)')).toHaveValue('200');
	await expect(again.getByLabel('River pump capacity (l/s)')).toHaveValue('5');
});
