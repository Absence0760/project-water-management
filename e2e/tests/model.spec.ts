import type { Page } from '@playwright/test';
import { addMember, createProject, putModel, sampleModel } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name });
const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });

test('build a network with farms, crops and a transfer, save, reload', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Model build');
	await page.goto(`/projects/${project.id}?tab=network`);

	// --- network: outflow gauge + two farms ---------------------------------
	await page.getByRole('button', { name: 'Add outflow gauge' }).click();
	await page.getByRole('button', { name: '+ Add node' }).click();
	await page.getByRole('button', { name: '+ Add node' }).click();
	const names = page.getByRole('textbox', { name: 'Name' });
	await expect(names).toHaveCount(3);
	await expect(names.nth(0)).toHaveValue('Outflow gauge');
	await names.nth(1).fill('Hilltop farm');
	await names.nth(2).fill('Valley farm');

	await expect(page.getByLabel('Kind of Outflow gauge')).toHaveValue('gauge');
	await expect(page.getByLabel('Kind of Hilltop farm')).toHaveValue('farm');
	await expect(page.getByLabel('Hilltop farm drains into').locator('option:checked')).toHaveText('Outflow gauge');

	await page.getByLabel('Area of Outflow gauge, km²', { exact: true }).fill('40');
	await page.getByLabel('Area of Hilltop farm, km²', { exact: true }).fill('14.5');
	await page.getByLabel('Dam capacity of Hilltop farm, m³').fill('120000');
	await page.getByLabel('Dam initial storage of Hilltop farm, %').fill('60');
	await page.getByLabel('Area of Valley farm, km²', { exact: true }).fill('9');

	// The drainage tree follows the table.
	const tree = page.getByRole('list', { name: 'Drainage tree' });
	await expect(tree.getByRole('listitem')).toHaveCount(3);
	await expect(tree.getByRole('listitem').first()).toContainText('Outflow gauge');
	await expect(tree.getByRole('listitem').first()).toContainText('outlet');
	await expect(saveBar(page)).toContainText('Unsaved changes to the model');

	// --- crops, factors and planted areas ------------------------------------
	await tab(page, 'Crops').click();
	await page.getByRole('button', { name: 'Add crop' }).click();
	await page.getByRole('textbox', { name: 'Crop name' }).fill('Vines');
	await page.getByLabel('Vines crop factor, Jan').fill('0.8');
	await page.getByLabel('Vines crop factor, Feb').fill('0.75');
	await page.getByLabel('Vines on Hilltop farm, ha').fill('25');
	await page.getByLabel('Vines on Valley farm, ha').fill('8');
	const totals = page.getByRole('row', { name: /^Total/ });
	await expect(totals).toContainText('33.00 ha');

	// --- a transfer from Hilltop to Valley in Dec + Jan ----------------------
	await tab(page, 'Transfers').click();
	await page.getByRole('button', { name: 'Add transfer' }).click();
	await page.getByLabel('Source of transfer 1').selectOption({ label: 'Hilltop farm' });
	await page.getByLabel('Destination of transfer 1').selectOption({ label: 'Valley farm' });
	const months = page.getByRole('group', { name: /^Months transfer 1 runs/ });
	await months.getByRole('checkbox', { name: /Dec$/ }).check();
	await months.getByRole('checkbox', { name: /Jan$/ }).check();
	await expect(page.getByRole('row', { name: /^1/ })).toContainText('Dec, Jan');
	await page.getByLabel('Max rate of transfer 1, m³/s').fill('0.02');

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
	const monthsAfter = page.getByRole('group', { name: /^Months transfer 1 runs/ });
	await expect(monthsAfter.getByRole('checkbox', { name: /Dec$/ })).toBeChecked();
	await expect(monthsAfter.getByRole('checkbox', { name: /Jan$/ })).toBeChecked();
	await expect(monthsAfter.getByRole('checkbox', { name: /Feb$/ })).not.toBeChecked();
	await expect(page.getByLabel('Max rate of transfer 1, m³/s')).toHaveValue('0.02');
	await expect(page.getByLabel('transfer 1 enabled')).toBeChecked();

	await tab(page, 'Crops').click();
	await expect(page.getByRole('textbox', { name: 'Crop name' })).toHaveValue('Vines');
	await expect(page.getByLabel('Vines crop factor, Jan')).toHaveValue('0.8');
	await expect(page.getByLabel('Vines crop factor, Feb')).toHaveValue('0.75');
	await expect(page.getByLabel('Vines crop factor, Mar')).toHaveValue('0');
	await expect(page.getByLabel('Vines on Hilltop farm, ha')).toHaveValue('25');
	await expect(page.getByLabel('Vines on Valley farm, ha')).toHaveValue('8');

	await tab(page, 'Network').click();
	await expect(page.getByRole('textbox', { name: 'Name' })).toHaveCount(3);
	await expect(page.getByLabel('Area of Hilltop farm, km²', { exact: true })).toHaveValue('14.5');
	await expect(page.getByLabel('Dam capacity of Hilltop farm, m³')).toHaveValue('120000');
	await expect(page.getByLabel('Dam initial storage of Hilltop farm, %')).toHaveValue('60');
	await expect(page.getByLabel('Valley farm drains into').locator('option:checked')).toHaveText('Outflow gauge');
	await expect(saveBar(page)).toBeHidden();
});

test('a second outlet or a loop blocks saving with a message', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Model validation');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=network`);
	const problems = page.getByRole('status').filter({ hasText: 'Fix before saving:' });
	const save = saveBar(page).getByRole('button', { name: 'Save changes' });

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

	// Discard puts the saved network back.
	await saveBar(page).getByRole('button', { name: 'Discard' }).click();
	await expect(saveBar(page)).toBeHidden();
	await expect(problems).toBeHidden();
	await expect(page.getByLabel('Upper farm drains into').locator('option:checked')).toHaveText('Outflow gauge');

	// Nothing invalid reached the server.
	await page.reload();
	await expect(page.getByLabel('Lower farm drains into').locator('option:checked')).toHaveText('Outflow gauge');
	await expect(page.getByLabel('Upper farm drains into').locator('option:checked')).toHaveText('Outflow gauge');
});

test('leaving with unsaved model changes asks first', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Unsaved guard');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=network`);
	await page.getByLabel('Area of Upper farm, km²', { exact: true }).fill('99');

	page.once('dialog', (d) => {
		expect(d.message()).toBe('You have unsaved model changes. Leave without saving?');
		void d.dismiss();
	});
	await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Projects' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Unsaved guard' })).toBeVisible();
	await expect(page.getByLabel('Area of Upper farm, km²', { exact: true })).toHaveValue('99');

	page.once('dialog', (d) => void d.accept());
	await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Projects' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
});

test('large values show thousands separators in the one-node form and the view-only table', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Separators');
	await putModel(page.request, project.id, sampleModel()); // Upper farm: 150 000 m³ dam
	await page.goto(`/projects/${project.id}?tab=network`);
	await page.getByRole('button', { name: 'One node' }).click();
	await page.getByLabel('Node to edit').selectOption({ label: '2. Upper farm · farm' });

	const capacity = page.getByLabel('Capacity (m³)');
	await expect(capacity).toHaveValue('150,000');
	// Editing starts from the plain number; typed separators are accepted.
	await capacity.focus();
	await expect(capacity).toHaveValue('150000');
	await capacity.fill('300 000');
	await capacity.blur();
	await expect(capacity).toHaveValue('300,000');
	// The editable table keeps plain numbers.
	await page.getByRole('button', { name: 'Table' }).click();
	await expect(page.getByLabel('Dam capacity of Upper farm, m³')).toHaveValue('300000');
	await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
	await expect(saveBar(page)).toBeHidden();

	const viewer = await signIn('Separators viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=network`);
	await expect(viewer.page.getByLabel('Dam capacity of Upper farm, m³')).toHaveValue('300,000');
	await expect(viewer.page.getByLabel('Dam capacity of Lower farm, m³')).toHaveValue('90,000');
});
