// Demand objects (engine 1.7.0, issue #54 item 2b, docs/model.md §2.7f):
// give a unit a town demand in the one-node form, save, reload, run, and read
// its supply in the run's demand-objects table.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openNodeForm, saveModelChanges } from '../support/network.ts';
import { answerConfirm } from '../support/confirm.ts';
import { ungroup } from '../support/format.ts';
import { API_URL } from '../support/env.ts';

const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });

test('add a town demand to a hydrological unit, save, reload, run, and see what it was supplied', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Demand objects');
	await page.goto(`/projects/${project.id}?tab=network`);
	await openNodeForm(page);
	await page.getByLabel('Node to edit').selectOption({ label: '2. Upper farm · hydrological unit' });

	const group = page.getByRole('group', { name: 'Demand objects', exact: true });
	await expect(group.getByText('No demand objects on Upper farm.')).toBeVisible();
	await group.getByLabel('Category of the new demand object').selectOption('municipal');
	await group.getByRole('button', { name: '+ Add demand' }).click();
	await group.getByLabel('Name').fill('Town');
	// A municipal object starts first in line, returning half of what it gets (the 2b research defaults).
	await expect(group.getByLabel('Priority')).toHaveValue('first');
	await expect(group.getByLabel('Share returned (%)')).toHaveValue('50');
	await group.getByLabel('Demand of Town in Oct, m³/day').fill('400');
	await group.getByRole('button', { name: 'Use October’s demand for every month' }).click();
	await expect(group.getByLabel('Demand of Town in Sep, m³/day')).toHaveValue('400');
	// Eleven values changed at once: a polite line says so.
	await expect(group.getByText('Copied October’s 400 to every month of Demand, m³/day, per month.')).toBeAttached();
	await expect(group.getByTestId(/^demand-object-mean-/)).toHaveText('400 m³/day on average.');
	// Per unit, the months are a profile (× the daily use, 1 by default) with no fill button; back to m³/day, the demand is kept.
	await group.getByLabel('Demand given as').selectOption('perUnit');
	await expect(group.getByRole('group', { name: 'Monthly profile (× the daily use; blank = 1)', exact: true })).toBeVisible();
	await expect(group.getByLabel('Profile of Town in Oct', { exact: true })).toHaveValue('1');
	await expect(group.getByRole('button', { name: 'Use October’s demand for every month' })).toHaveCount(0);
	await group.getByLabel('Demand given as').selectOption('monthly');
	await expect(group.getByRole('group', { name: 'Demand, m³/day, per month', exact: true })).toBeVisible();
	await expect(group.getByLabel('Demand of Town in Sep, m³/day')).toHaveValue('400');
	// Piped out: nothing can return, so the share is set to 0 and locked.
	await group.getByLabel('Destination').selectOption('external');
	await expect(group.getByLabel('Share returned (%)')).not.toBeEditable();
	await expect(group.getByLabel('Share returned (%)')).toHaveValue('0');
	await group.getByLabel('Destination').selectOption('internal');
	await group.getByLabel('Share returned (%)').fill('40');
	// The basic-needs floor (engine 1.44.0, issue #123): a town given in m³/day has none until its people are entered.
	await expect(group.getByTestId(/^demand-object-floor-/)).toHaveText(/^No basic-needs floor/);
	await group.getByLabel('People served').fill('2000');
	await expect(group.getByTestId(/^demand-object-floor-/)).toHaveText(/^Basic-needs floor 50 m³\/day \(2\D000 people served\), 25 litres a person a day: a restriction never cuts it below that/);
	await expectNoViolations(page, { include: '.detail' });
	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);

	await page.reload();
	await openNodeForm(page);
	await page.getByLabel('Node to edit').selectOption({ label: '2. Upper farm · hydrological unit' });
	const again = page.getByRole('group', { name: 'Demand objects', exact: true });
	await expect(again.getByLabel('Name')).toHaveValue('Town');
	await expect(again.getByLabel('Demand of Town in Mar, m³/day')).toHaveValue('400');
	await expect(again.getByLabel('Share returned (%)')).toHaveValue('40');
	await expect(again.getByLabel('People served')).toHaveValue(/^2\D?000$/);
	// A gauge has none.
	await page.getByLabel('Node to edit').selectOption({ label: '1. Outflow gauge · gauge' });
	await expect(page.getByRole('group', { name: 'Demand objects', exact: true })).toHaveCount(0);

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('With a town');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'With a town' })).toBeVisible();
	// On Units & supply's Other uses since issue #137, linked from the Summary.
	await page.getByTestId('other-uses-link').getByRole('link', { name: 'Other uses on Units & supply' }).click();
	const uses = page.getByRole('region', { name: 'Other uses of water' });
	await expect(uses.getByRole('heading', { level: 3, name: 'Demand objects' })).toBeVisible();
	const row = uses.getByTestId('demand-objects-table').getByRole('row', { name: /Town/ });
	await expect(row.getByRole('cell').nth(0)).toHaveText('Upper farm');
	await expect(row.getByRole('cell').nth(2)).toHaveText('400');
	const supplied = ungroup(await row.getByRole('cell').nth(3).innerText());
	expect(supplied).toBeGreaterThan(0);
	expect(supplied).toBeLessThanOrEqual(400);
	// Its floor, and what it got per person, in their own columns (engine 1.44.0).
	const table = uses.getByTestId('demand-objects-table');
	const col = async (name: string) => (await table.getByRole('columnheader').allInnerTexts()).findIndex((h) => h.replace(/\s+/g, ' ').startsWith(name));
	const floorAt = await col('Basic-needs floor');
	expect(floorAt).toBeGreaterThan(0);
	// Column headers count the row header (the object's name); cells don't.
	await expect(row.getByRole('cell').nth(floorAt - 1)).toHaveText('50');
	const perPerson = ungroup(await row.getByRole('cell').nth((await col('Per person')) - 1).innerText());
	expect(perPerson).toBeCloseTo((supplied * 1000) / 2000, -1);
	// The floor columns stack rather than widen the table: it fits its panel without scrolling sideways.
	expect(await table.evaluate((t) => t.parentElement!.scrollWidth <= t.parentElement!.clientWidth)).toBe(true);
});

test('each demand object is titled by its name, and removing one with a demand asks and moves the focus on', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Demand objects titles');
	await page.goto(`/projects/${project.id}?tab=network`);
	const sheet = await openNodeForm(page, 'Upper farm');
	const group = sheet.getByRole('group', { name: 'Demand objects', exact: true });
	await group.getByRole('button', { name: '+ Add demand' }).click();
	await group.getByRole('button', { name: '+ Add demand' }).click();
	const names = group.getByLabel('Name', { exact: true });
	await names.nth(0).fill('');
	await names.nth(1).fill('Town B');
	// A group per object, named by it, so its fields read as its own; a blank name still names its months.
	await expect(group.getByRole('group', { name: 'Demand object 2: Town B' }).getByLabel('Category')).toBeVisible();
	await expect(group.getByRole('group', { name: 'Demand object 1', exact: true })).toBeVisible();
	await expect(group.getByLabel('Demand of demand 1 in Oct, m³/day')).toBeVisible();
	await expect(group.getByRole('group', { name: 'Demand object 2: Town B' }).getByLabel('Modelled')).toHaveAccessibleDescription('Untick to keep it on record without running it.');

	// Town B with a demand asks first; Cancel keeps it; the focus then goes to the next object's name.
	await group.getByLabel('Demand of Town B in Oct, m³/day').fill('120');
	await group.getByRole('button', { name: 'Remove Town B' }).click();
	await answerConfirm(page, false, 'Its monthly demand goes with it.');
	await expect(names).toHaveCount(2);
	// The blank one first: it holds nothing, so it goes at once, and Town B's name takes the focus.
	await group.getByRole('button', { name: 'Remove demand object 1' }).click();
	await expect(page.getByRole('alertdialog')).toHaveCount(0);
	await expect(names).toHaveCount(1);
	await expect(names.first()).toBeFocused();
	await group.getByRole('button', { name: 'Remove Town B' }).click();
	await answerConfirm(page, true, 'Remove “Town B”?');
	await expect(group.getByRole('button', { name: '+ Add demand' })).toBeFocused();
});

test('a town demand given in l/s or m³/s by month is kept in m³/day and reopens in the unit it was given in (engine 1.72.0)', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Demand in l/s');
	await page.goto(`/projects/${project.id}?tab=network`);
	await openNodeForm(page);
	await page.getByLabel('Node to edit').selectOption({ label: '2. Upper farm · hydrological unit' });
	const group = page.getByRole('group', { name: 'Demand objects', exact: true });
	await group.getByLabel('Category of the new demand object').selectOption('municipal');
	await group.getByRole('button', { name: '+ Add demand' }).click();
	await group.getByLabel('Name').fill('Town');
	await group.getByLabel('Demand given as').selectOption('monthly:ls');
	await expect(group.getByRole('group', { name: 'Demand, l/s, per month', exact: true })).toBeVisible();
	await group.getByLabel('Demand of Town in Oct, l/s').fill('5');
	await group.getByRole('button', { name: 'Use October’s demand for every month' }).click();
	// 5 l/s is 432 m³/day: shown in both.
	await expect(group.getByTestId(/^demand-object-mean-/)).toHaveText('5 l/s (432 m³/day) on average.');
	await expectNoViolations(page, { include: '.detail' });
	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);

	// Stored in m³/day, with the unit it was given in.
	const model = (await (await page.request.get(`${API_URL}/projects/${project.id}/model`)).json()) as { demandObjects: { monthlyM3Day: number[]; monthlyUnit: string | null }[] };
	expect(model.demandObjects[0]!.monthlyM3Day[0]).toBeCloseTo(432, 9);
	expect(model.demandObjects[0]!.monthlyUnit).toBe('ls');

	await page.reload();
	await openNodeForm(page);
	await page.getByLabel('Node to edit').selectOption({ label: '2. Upper farm · hydrological unit' });
	const again = page.getByRole('group', { name: 'Demand objects', exact: true });
	await expect(again.getByLabel('Demand given as')).toHaveValue('monthly:ls');
	await expect(again.getByLabel('Demand of Town in Mar, l/s')).toHaveValue('5');
	// The same demand in m³/s, and back in m³/day: never changed by the unit.
	await again.getByLabel('Demand given as').selectOption('monthly:m3s');
	await expect(again.getByLabel('Demand of Town in Mar, m³/s')).toHaveValue('0.005');
	await again.getByLabel('Demand given as').selectOption('monthly');
	await expect(again.getByLabel('Demand of Town in Mar, m³/day')).toHaveValue('432');
});
