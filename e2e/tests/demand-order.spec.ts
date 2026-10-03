// A unit's supply order (engine 1.64.0, issue #343, docs/model.md §2.7f):
// with one demand object the node form keeps the priority dropdown, with two
// or more it shows the numbered order (the crops among them), and an order
// of two municipalities before the crops is saved and read back.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openNodeForm, saveModelChanges } from '../support/network.ts';

const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });

test('order two municipalities before the crops, one after the other, and keep it on save', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Demand order');
	await page.goto(`/projects/${project.id}?tab=network`);
	await openNodeForm(page);
	await page.getByLabel('Node to edit').selectOption({ label: '2. Upper farm · hydrological unit' });

	const group = page.getByRole('group', { name: 'Demand objects', exact: true });
	await group.getByLabel('Category of the new demand object').selectOption('municipal');
	await group.getByRole('button', { name: '+ Add demand' }).click();
	// One object: the dropdown, in words that fit the panel.
	const priority = group.getByLabel('Priority', { exact: true });
	await expect(priority).toHaveValue('first');
	await expect(priority.locator('option:checked')).toHaveText('Before the crops');
	await expect(group.getByTestId(/^supply-order-/)).toHaveCount(0);

	await group.getByRole('button', { name: '+ Add demand' }).click();
	const names = group.getByLabel('Name');
	await names.nth(0).fill('Town A');
	await names.nth(1).fill('Town B');
	// Two objects: the numbered order replaces the dropdowns. Both first, so they share.
	await expect(group.getByLabel('Priority', { exact: true })).toHaveCount(0);
	const order = group.getByRole('group', { name: /^Supply order on a short day/ });
	const text = group.getByTestId(/^supply-order-text-/);
	// The order is per water source: the dam side first, the river abstractions after it (round 4, persona-hydrologist).
	await expect(order).toContainText('The order holds among the demands on one water source');
	await expect(order.getByLabel('The crops', { exact: true })).toHaveValue('2');
	await expect(order.getByLabel('Town A', { exact: true })).toHaveValue('1');
	await expect(order.getByLabel('Town B', { exact: true })).toHaveValue('1');
	await expect(text).toHaveText('Order: Town A and Town B pro rata, then the crops.');
	// One choice puts Town B in a place of its own, after Town A and before the crops.
	await order.getByLabel('Town B', { exact: true }).selectOption({ label: 'Between 1 and 2' });
	await expect(text).toHaveText('Order: Town A, then Town B, then the crops.');
	await expect(order.getByLabel('Town B', { exact: true })).toHaveValue('2');
	await expect(order.getByLabel('The crops', { exact: true })).toHaveValue('3');
	// The rows read in supply order.
	await expect(order.getByRole('listitem')).toHaveText([/^Town A/, /^Town B/, /^The crops/]);
	await expectNoViolations(page, { include: '.detail' });
	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);

	await page.reload();
	await openNodeForm(page);
	await page.getByLabel('Node to edit').selectOption({ label: '2. Upper farm · hydrological unit' });
	const again = page.getByRole('group', { name: /^Supply order on a short day/ });
	await expect(again.getByLabel('Town A', { exact: true })).toHaveValue('1');
	await expect(again.getByLabel('Town B', { exact: true })).toHaveValue('2');
	await expect(again.getByLabel('The crops', { exact: true })).toHaveValue('3');

	// On a phone the box fits without sideways scrolling and stays accessible.
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(again).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await expectNoViolations(page, { include: '.detail' });

	// Back to one object: the dropdown returns, and the one left keeps no rank it can't show.
	await page.setViewportSize({ width: 1280, height: 900 });
	const objs = page.getByRole('group', { name: 'Demand objects', exact: true });
	// Town A holds no demand yet, so it goes without a question; the button names it.
	await objs.getByRole('button', { name: 'Remove Town A' }).click();
	await expect(objs.getByRole('group', { name: /^Supply order on a short day/ })).toHaveCount(0);
	await expect(objs.getByLabel('Priority', { exact: true })).toHaveValue('first');
});
