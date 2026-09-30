// A farm's supply rule and river pump in the node form (roadmap WP-3.8, issue
// #54 item 2c, docs/model.md §2.7e): set a farm to river first with 2 pumps ×
// 25 m³/h, save, reload and read back 1,200 m³/day; and see run of river on a
// farm with a dam blocked with the message the save would be refused with.
// And the hands-off flow and River to dam by month (engine 1.31.0, issue #204,
// §2.7h): set, saved, reloaded and read back.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openNodeForm, saveModelChanges } from '../support/network.ts';

const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });

async function openUpperFarm(page: Page) {
	const sheet = await openNodeForm(page);
	await page.getByLabel('Node to edit').selectOption({ label: '2. Upper farm · hydrological unit' });
	return { sheet, supply: sheet.getByRole('group', { name: 'Supply', exact: true }), routing: sheet.getByRole('group', { name: 'Routing', exact: true }) };
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

test('a hands-off flow by month with the EWR, and River to dam by month, save and read back', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Hands-off flow');
	await page.goto(`/projects/${project.id}?tab=network`);
	const { supply, routing } = await openUpperFarm(page);

	// Off by default: no set flow, the EWR not kept, River to dam one value all year.
	const note = supply.getByTestId('hands-off-note');
	await expect(note).toHaveText('No hands-off flow: the river pump and River to dam leave in the river only what senior water users downstream need, not the EWR.');
	await expect(supply.getByLabel('Hands-off flow of Upper farm in Oct, m³/day')).toHaveCount(0);

	await supply.getByLabel('Leave a set flow in the river, by month').check();
	await supply.getByLabel('Hands-off flow of Upper farm in Oct, m³/day').fill('150');
	await supply.getByRole('button', { name: 'Use October’s flow for every month' }).click();
	await supply.getByLabel('Hands-off flow of Upper farm in Jan, m³/day').fill('250');
	await supply.getByLabel('Also leave the EWR in the river').check();
	await expect(note).toHaveText(
		'Leaves the larger of 150–250 m³/day and the EWR required here (this unit’s share and upstream shares) in the river before the river pump or River to dam takes anything. When less flows, neither takes anything.'
	);

	// River to dam by month: winter only (May–Sep); the one value is then not used.
	await routing.getByLabel('Set River to dam by month').check();
	await expect(routing.getByLabel('River to dam (m³/day)', { exact: true })).not.toBeEditable();
	for (const m of ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr']) await routing.getByLabel(`River to dam of Upper farm in ${m}, m³/day`).fill('0');
	for (const m of ['May', 'Jun', 'Jul', 'Aug', 'Sep']) await routing.getByLabel(`River to dam of Upper farm in ${m}, m³/day`).fill('800');
	await expect(routing.getByTestId('river-to-dam-months-note')).toHaveText('River to dam takes up to 800 m³/day; nothing in Oct–Apr. The one value above is not used.');
	await expectNoViolations(page, { include: '[data-testid^="supply-"]' });
	await expectNoViolations(page, { include: '[data-testid^="river-to-dam-months-"]' });
	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);

	await page.reload();
	const { supply: s2, routing: r2 } = await openUpperFarm(page);
	await expect(s2.getByLabel('Leave a set flow in the river, by month')).toBeChecked();
	await expect(s2.getByLabel('Hands-off flow of Upper farm in Dec, m³/day')).toHaveValue('150');
	await expect(s2.getByLabel('Hands-off flow of Upper farm in Jan, m³/day')).toHaveValue('250');
	await expect(s2.getByLabel('Also leave the EWR in the river')).toBeChecked();
	await expect(r2.getByLabel('Set River to dam by month')).toBeChecked();
	await expect(r2.getByLabel('River to dam of Upper farm in Apr, m³/day')).toHaveValue('0');
	await expect(r2.getByLabel('River to dam of Upper farm in Jul, m³/day')).toHaveValue('800');

	// Unticked, the one value is back in use and nothing by month is left.
	await r2.getByLabel('Set River to dam by month').uncheck();
	await expect(r2.getByLabel('River to dam (m³/day)', { exact: true })).toBeEditable();
	await expect(r2.getByTestId('river-to-dam-months-note')).toHaveCount(0);
});
