// A farm's supply rule and river pump in the node form (roadmap WP-3.8, issue
// #54 item 2c, docs/model.md §2.7e): set a farm to river first with 2 pumps ×
// 25 m³/h, save, reload and read back 1,200 m³/day; and see run of river on a
// farm with a dam blocked with the message the save would be refused with.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openNodeForm, saveModelChanges } from '../support/network.ts';

const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });

async function openUpperFarm(page: Page) {
	const sheet = await openNodeForm(page);
	await page.getByLabel('Node to edit').selectOption({ label: '2. Upper farm · hydrological unit' });
	return { sheet, supply: sheet.getByRole('group', { name: 'Supply', exact: true }) };
}

test('river first with 2 pumps × 25 m³/h saves 1,200 m³/day; run of river with a dam is blocked', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Supply rule');
	await page.goto(`/projects/${project.id}?tab=network`);
	const { supply } = await openUpperFarm(page);

	// The default: the dam only, no pump fields.
	await expect(supply.getByLabel('Supply rule', { exact: true })).toHaveValue('damFirst');
	await expect(supply.getByLabel('River pump capacity (m³/day)')).toHaveCount(0);

	await supply.getByLabel('Supply rule', { exact: true }).selectOption({ label: 'River first' });
	await expect(supply.getByTestId('pump-note')).toHaveText('Blank is no limit: the pump takes whatever the river offers, and the run warns.');
	await supply.getByLabel('Number of pumps').fill('2');
	await supply.getByLabel('m³/h per pump').fill('25');
	await expect(supply.getByTestId('pump-note')).toHaveText('2 × 25 m³/h × 24 h = 1\u202f200 m³/day.');
	await expect(supply.getByLabel('River pump capacity (m³/day)')).toHaveValue('1\u202f200');
	// Trigger levels belong to the trigger rule only.
	await expect(supply.getByLabel('Switch to river below (% of dam)')).toHaveCount(0);
	await expectNoViolations(page, { include: '[data-testid^="supply-"]' });
	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);

	await page.reload();
	const { sheet, supply: again } = await openUpperFarm(page);
	await expect(again.getByLabel('Supply rule', { exact: true })).toHaveValue('riverFirst');
	await expect(again.getByLabel('River pump capacity (m³/day)')).toHaveValue('1\u202f200');

	// Run of river has no dam: with Upper farm's 150 000 m³ dam the form says so and Save stays off.
	await again.getByLabel('Supply rule', { exact: true }).selectOption({ label: 'Run of river' });
	await expect(again.getByRole('alert')).toHaveText('Run of river has no dam; set the dam capacity to 0 or pick another supply rule.');
	await expect(sheet.getByText('1 problem to fix before saving')).toBeVisible();
	await expect(sheet.getByRole('button', { name: 'Save changes' })).toBeDisabled();

	// The trigger rule shows its two levels; a stop below the trigger is blocked too.
	await again.getByLabel('Supply rule', { exact: true }).selectOption({ label: 'Dam, river when low' });
	await expect(again.getByRole('alert')).toHaveCount(0);
	await again.getByLabel('Back to the dam at (% of dam)').fill('30');
	await expect(again.getByRole('alert')).toHaveText('The switch-back level must be at least the switch-to-river level.');
	await expect(sheet.getByRole('button', { name: 'Save changes' })).toBeDisabled();
});
