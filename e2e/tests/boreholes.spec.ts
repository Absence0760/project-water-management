// Boreholes and stream depletion (roadmap WP-1.34, docs/model.md §2.7d): give
// a farm boreholes in the one-node form, save, reload, run, and read what it
// pumped and the depletion the river took for it; and (WP-3.9) add an
// individual borehole with an annual cap and read its use per water year.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openNodeForm, saveModelChanges } from '../support/network.ts';
import { answerConfirm } from '../support/confirm.ts';
import { ungroup } from '../support/format.ts';

const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });

test('edit a farm’s boreholes, run, and see the groundwater and stream depletion', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Boreholes');
	await page.goto(`/projects/${project.id}?tab=network`);
	await openNodeForm(page);
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '2. Upper farm · hydrological unit' });

	const group = page.getByRole('group', { name: 'Combined boreholes (one capacity)' });
	await group.getByLabel('Combined borehole capacity (m³/day)').fill('600');
	await group.getByLabel('Borehole rule').selectOption('primary');
	await group.getByLabel('Combined stream depletion (%)').fill('50');
	await group.getByLabel('Combined depletion lag (days)').fill('10');
	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);

	await page.reload();
	await openNodeForm(page);
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '2. Upper farm · hydrological unit' });
	const again = page.getByRole('group', { name: 'Combined boreholes (one capacity)' });
	await expect(again.getByLabel('Combined borehole capacity (m³/day)')).toHaveValue('600');
	await expect(again.getByLabel('Borehole rule')).toHaveValue('primary');
	await expect(again.getByLabel('Combined stream depletion (%)')).toHaveValue('50');
	// A gauge has no groundwater group.
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '1. Outflow gauge · gauge' });
	await expect(page.getByRole('group', { name: 'Combined boreholes (one capacity)' })).toHaveCount(0);

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('Pumping');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Pumping' })).toBeVisible();
	// The run warns about the calibration record measured while they pumped.
	await expect(page.getByText(/boreholes that deplete the river/).first()).toBeAttached();
	// The table is on Units & supply's Other uses (issue #137), linked from the Summary.
	await page.getByTestId('other-uses-link').getByRole('link', { name: 'Other uses on Units & supply' }).click();
	const uses = page.getByRole('region', { name: 'Other uses of water' });
	await expect(uses.getByRole('heading', { level: 3, name: 'Groundwater' })).toBeVisible();
	// One table (issue #175): the daily-mean one's share of supplied and stream depletion are columns of the annual table.
	await expect(uses.locator('table.groundwater')).toHaveCount(0);
	const table = uses.locator('table.groundwater-annual');
	await expect(table.getByRole('columnheader')).toContainText(['Hydrological unit or user', 'Mean pumped', 'Share of supplied', 'Stream depletion', 'Most in a year']);
	const row = table.getByRole('row', { name: /^Upper farm/ });
	await expect(row).toBeVisible();
	// Primary boreholes pump up to 600 m³/day, and half of it comes out of the river.
	const pumped = ungroup(await row.getByRole('cell').first().innerText());
	expect(pumped).toBeGreaterThan(0);
	expect(pumped).toBeLessThanOrEqual(600 * 366);
	await expect(row.getByRole('cell').nth(1)).toHaveText(/^\d+(\.\d)?%$/);
	const depleted = ungroup(await row.getByRole('cell').nth(2).innerText());
	expect(depleted).toBeGreaterThan(0);
	expect(depleted).toBeLessThanOrEqual(pumped);
});

test('add an individual borehole with an annual cap, run, and read its use per water year against the cap (WP-3.9)', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Individual boreholes');
	await page.goto(`/projects/${project.id}?tab=network`);
	await openNodeForm(page);
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '2. Upper farm · hydrological unit' });

	const group = page.getByRole('group', { name: 'Individual boreholes', exact: true });
	await expect(group.getByText('Depletion is a fixed fraction, not an aquifer model. Attach the geohydrology report.')).toBeVisible();
	await group.getByRole('button', { name: '+ Add borehole' }).click();
	await group.getByLabel('Name').fill('BH-01');
	await group.getByLabel('Capacity (m³/day)').fill('300');
	await group.getByLabel('Annual cap (m³/a)').fill('20000');
	await group.getByLabel('Mode').selectOption('primary');
	await group.getByLabel('Stream depletion (% of pumping)').fill('25');
	await expect(group.getByTestId('bh-cap-note')).toContainText('Annual caps total 20\u202f000 m³/a');
	// Without a property area and rate the note gives GN 538's rule, not a volume.
	await expect(group.getByTestId('bh-cap-note')).toContainText('enter the property area and rate above');
	// The property's GN 538 volume (engine 1.12.0): 10 ha × 150 m³/ha/a = 1 500 m³/a.
	const gw = page.getByRole('group', { name: 'Combined boreholes (one capacity)' });
	await gw.getByLabel('Property area (GN 538) (ha)').fill('10');
	await gw.getByLabel('GN 538 rate (m³/ha/a)').selectOption('150');
	await expect(group.getByTestId('bh-cap-note')).toContainText('allows this property 1\u202f500 m³/a of groundwater');
	await expectNoViolations(page, { include: '.detail' });
	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);

	await page.reload();
	await openNodeForm(page);
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '2. Upper farm · hydrological unit' });
	const again = page.getByRole('group', { name: 'Individual boreholes', exact: true });
	await expect(again.getByLabel('Name')).toHaveValue('BH-01');
	await expect(again.getByLabel('Annual cap (m³/a)')).toHaveValue('20\u202f000');
	await expect(again.getByLabel('Mode')).toHaveValue('primary');
	const gwAgain = page.getByRole('group', { name: 'Combined boreholes (one capacity)' });
	await expect(gwAgain.getByLabel('Property area (GN 538) (ha)')).toHaveValue('10');
	await expect(gwAgain.getByLabel('GN 538 rate (m³/ha/a)')).toHaveValue('150');

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('Capped');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Capped' })).toBeVisible();
	await page.getByTestId('other-uses-link').getByRole('link', { name: 'Other uses on Units & supply' }).click();
	const uses = page.getByRole('region', { name: 'Other uses of water' });
	await expect(uses.getByRole('heading', { level: 4, name: 'Groundwater by water year' })).toBeVisible();
	await expect(uses.getByTestId('gw-annual-note')).toContainText('never decides whether a use is lawful');
	const row = uses.locator('table.groundwater-annual').getByRole('row', { name: /^Upper farm/ });
	await expect(row).toBeVisible();
	// The cap column shows the borehole's 20 000 m³/a; no year pumps more than it. (Share of supplied and stream
	// depletion come first, after the mean: the daily-mean table's columns, merged in, issue #175.)
	await expect(row.getByRole('cell').nth(4)).toHaveText('20\u202f000');
	const most = ungroup((await row.getByRole('cell').nth(3).innerText()).split(' ')[0]!);
	expect(most).toBeGreaterThan(0);
	expect(most).toBeLessThanOrEqual(20_000);
	// The property's GN 538 volume, not the 40 000 ceiling, and the most in any 12 months beside it.
	await expect(row.getByRole('cell').nth(5)).toHaveText('1\u202f500');
	await expect(row.getByRole('cell').nth(6)).not.toHaveText('');
});

test('the combined and the individual boreholes are told apart, and removing a borehole asks, names it and keeps the focus', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Borehole setups');
	await page.goto(`/projects/${project.id}?tab=network`);
	const sheet = await openNodeForm(page, 'Upper farm');
	const combined = sheet.getByRole('group', { name: 'Combined boreholes (one capacity)' });
	const each = sheet.getByRole('group', { name: 'Individual boreholes', exact: true });
	// Each section says when to use it, and the two sit side by side in the form.
	await expect(combined).toContainText('If both are set, both run.');
	await expect(each).toContainText('use these when each has its own yield');
	const legends = await sheet.locator('.detail > fieldset > legend').allTextContents();
	expect(legends.indexOf('Individual boreholes')).toBe(legends.indexOf('Combined boreholes (one capacity)') + 1);
	// No two fields share a name: one "Stream depletion" per set-up.
	await expect(sheet.getByLabel('Combined stream depletion (%)')).toHaveCount(1);
	await each.getByRole('button', { name: '+ Add borehole' }).click();
	await each.getByRole('button', { name: '+ Add borehole' }).click();
	await expect(sheet.getByLabel('Stream depletion (% of pumping)')).toHaveCount(2);
	// The same word for the dam-low trigger in both selects.
	await expect(combined.getByLabel('Borehole rule').locator('option[value="drought"]')).toHaveText(/^Drought:/);
	await expect(each.getByLabel('Mode').first().locator('option[value="emergency"]')).toHaveText(/^Drought:/);

	// A new borehole goes at once; one with figures asks, and Cancel keeps it.
	const names = each.getByLabel('Name');
	await names.nth(0).fill('BH-01');
	await each.getByLabel('Capacity (m³/day)').first().fill('300');
	await each.getByRole('button', { name: 'Remove BH-01' }).click();
	await answerConfirm(page, false, 'Remove “BH-01”?');
	await expect(names).toHaveCount(2);
	await each.getByRole('button', { name: 'Remove BH-01' }).click();
	await answerConfirm(page, true);
	await expect(names).toHaveCount(1);
	// The focus moves to the next borehole's name, then (the last gone) to + Add borehole.
	await expect(names.first()).toBeFocused();
	await each.getByRole('button', { name: 'Remove Borehole 2' }).click();
	await expect(page.getByRole('alertdialog')).toHaveCount(0);
	await expect(each.getByRole('button', { name: '+ Add borehole' })).toBeFocused();
});
