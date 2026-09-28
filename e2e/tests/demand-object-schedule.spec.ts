// A demand object's on/off schedule (engine 1.17.0, issue #90 Q4 and Q12,
// docs/model.md §2.7f): give a unit's town weekends off and an Easter peak in
// the one-node form, reorder the windows, save, reload, run, and read its
// days off in the run's demand-objects table.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openNodeForm, saveModelChanges } from '../support/network.ts';
import { ungroup } from '../support/format.ts';

const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });

/** Opens the one-node form on the seeded project's upper farm (by its name, whatever the option's suffix). */
async function openUpperFarm(page: Page) {
	await openNodeForm(page);
	const picker = page.getByLabel('Node to edit');
	const value = await picker.locator('option', { hasText: 'Upper farm' }).getAttribute('value');
	await picker.selectOption(value!);
	return page.getByRole('group', { name: 'Demand objects', exact: true });
}

test('give a town weekends off and an Easter peak, save, reload, run, and see its days off', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Demand schedule');
	await page.goto(`/projects/${project.id}?tab=network`);
	const group = await openUpperFarm(page);
	await group.getByLabel('Category of the new demand object').selectOption('municipal');
	await group.getByRole('button', { name: '+ Add demand' }).click();
	await group.getByLabel('Name').fill('Town');
	await group.getByLabel('Demand of Town in Oct, m³/day').fill('400');
	await group.getByRole('button', { name: 'Use October’s demand for every month' }).click();

	const schedule = group.getByTestId(/^demand-schedule-/).first();
	await expect(schedule.getByText('Every day at its month’s demand.')).toBeVisible();
	// A new "Every day" window starts as weekends off.
	await schedule.getByLabel('Days the new window covers').selectOption('always');
	await schedule.getByRole('button', { name: '+ Add window' }).click();
	const first = schedule.getByTestId(/^demand-schedule-window-.*-0$/);
	await expect(first.getByLabel('Window 1')).toHaveValue('Weekends');
	await expect(first.getByLabel('Sat')).toBeChecked();
	await expect(first.getByLabel('Sun')).toBeChecked();
	await expect(first.getByLabel('Mon')).not.toBeChecked();
	await expect(first.getByLabel('Factor (0 = off)')).toHaveValue('0');

	// An Easter window, Good Friday to Family Day, at twice the demand; then moved above the weekends.
	await schedule.getByLabel('Days the new window covers').selectOption('easter');
	await schedule.getByRole('button', { name: '+ Add window' }).click();
	const second = schedule.getByTestId(/^demand-schedule-window-.*-1$/);
	await expect(second.getByLabel('From (days from Easter Sunday)')).toHaveValue('-2');
	await expect(second.getByLabel('To (days from Easter Sunday)')).toHaveValue('1');
	await second.getByLabel('Factor (0 = off)').fill('2');
	await schedule.getByRole('button', { name: 'Move window 2 up' }).click();
	await expect(schedule.getByTestId(/^demand-schedule-window-.*-0$/).getByLabel('Window 1')).toHaveValue('Easter weekend');

	// A span that ends before it starts is flagged on the window, and fixed.
	const easter = schedule.getByTestId(/^demand-schedule-window-.*-0$/);
	await easter.getByLabel('To (days from Easter Sunday)').fill('-5');
	await expect(easter.getByText(/^Not used: its Easter span ends/)).toBeVisible();
	await easter.getByLabel('To (days from Easter Sunday)').fill('1');
	await expect(easter.getByText(/^Not used:/)).toHaveCount(0);

	await expectNoViolations(page, { include: '.detail' });
	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);

	await page.reload();
	const again = (await openUpperFarm(page)).getByTestId(/^demand-schedule-/).first();
	await expect(again.getByTestId(/^demand-schedule-window-.*-0$/).getByLabel('Window 1')).toHaveValue('Easter weekend');
	await expect(again.getByTestId(/^demand-schedule-window-.*-0$/).getByLabel('Factor (0 = off)')).toHaveValue('2');
	await expect(again.getByTestId(/^demand-schedule-window-.*-1$/).getByLabel('Window 2')).toHaveValue('Weekends');
	await expect(again.getByTestId(/^demand-schedule-window-.*-1$/).getByLabel('Sat')).toBeChecked();

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('Town with weekends off');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Town with weekends off' })).toBeVisible();
	const table = page.getByTestId('demand-objects-table');
	await expect(table.getByRole('columnheader', { name: 'Days off' })).toBeVisible();
	const row = table.getByRole('row', { name: /Town/ });
	// Unit, priority, demand, supplied, %, days short, days off.
	const off = ungroup(await row.getByRole('cell').nth(6).innerText());
	expect(off).toBeGreaterThan(0);
	// Off on weekends, so the mean demand is below the 400 m³/day of a day on.
	expect(ungroup(await row.getByRole('cell').nth(2).innerText())).toBeLessThan(400);
});
