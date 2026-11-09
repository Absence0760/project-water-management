// River bed losses in the reach below a node (engine 1.75.0, issue #444,
// docs/model.md §2.6b): set a share and a daily cap on a unit in the one-node
// form, save, reload, see them kept, check the outlet can't take any, and run
// the model with them: the self-checks pass and the water balance shows the
// bed losses as their own loss.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openNodeForm, saveModelChanges } from '../support/network.ts';

const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });
const reach = (page: Page) => page.getByRole('group', { name: 'Bed losses in the reach below' });

test('set bed losses below a unit, save, reload and run', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Bed losses');
	await page.goto(`/projects/${project.id}?tab=network`);
	await openNodeForm(page);
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '2. Upper farm · hydrological unit' });

	const share = reach(page).getByLabel('Share of the flow lost (%)');
	const cap = reach(page).getByLabel('Most lost in a day (m³/day)');
	await expect(share).toHaveValue('0');
	// No share, nothing to cap.
	await expect(cap).not.toBeEditable();
	await share.fill('20');
	await share.blur();
	await expect(cap).toBeEditable();
	await cap.fill('5000');
	await cap.blur();
	await expectNoViolations(page, { include: '[data-testid="reach-note"]' });
	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);

	await page.reload();
	await openNodeForm(page);
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '2. Upper farm · hydrological unit' });
	await expect(reach(page).getByLabel('Share of the flow lost (%)')).toHaveValue('20');
	await expect(reach(page).getByLabel('Most lost in a day (m³/day)')).toHaveValue(/^5[\s\u202f]?000$/);

	// The outlet has no reach below it in the model.
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '1. Outflow gauge · gauge' });
	await expect(reach(page).getByLabel('Share of the flow lost (%)')).not.toBeEditable();
	await expect(reach(page)).toContainText('Not used at the outlet, which has no reach below it in the model: Share of the flow lost, Most lost in a day.');

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('Losing reach');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Losing reach' })).toBeVisible();
	// The engine's self-checks pass with the losses: every unit's inflow is the outflow above less the loss.
	await page.getByRole('navigation', { name: 'Result sections' }).getByRole('link', { name: 'Arithmetic checks' }).click();
	const checks = page.getByRole('region', { name: /^Arithmetic checks/ });
	await expect(checks.getByRole('status').filter({ hasText: 'arithmetic checks' })).toHaveText(/^All \d+ arithmetic checks passed\.$/);
	// The bed losses leave the catchment: their own column in the balance, and named in its equation.
	const balance = page.getByRole('region', { name: 'Water balance by water year' });
	await expect(balance.getByRole('columnheader', { name: 'Bed losses', exact: true })).toBeVisible();
	await expect(balance).toContainText('+ bed losses + outflow + end storage.');
});

test('vary the bed losses by month: a small share with a high cap in the wet months, a larger share with a small cap in the dry ones', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Bed losses by month');
	await page.goto(`/projects/${project.id}?tab=network`);
	await openNodeForm(page);
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '2. Upper farm · hydrological unit' });

	await reach(page).getByLabel('Share of the flow lost (%)').fill('10');
	await reach(page).getByLabel('Share of the flow lost (%)').blur();
	await reach(page).getByTestId('reach-vary').check();
	// The one share folds away; every month starts at it.
	const jan = reach(page).getByLabel('Share of the flow lost below Upper farm in Jan, %');
	const jul = reach(page).getByLabel('Share of the flow lost below Upper farm in Jul, %');
	await expect(jan).toHaveValue('10');
	// The one share stays stored, folded under "Set by month below instead" and read-only.
	await expect(reach(page).getByText('Set by month below instead: Share of the flow lost.')).toBeVisible();
	await expect(reach(page).getByLabel('Share of the flow lost (%)')).not.toBeEditable();
	await jul.fill('40');
	await jul.blur();
	await reach(page).getByTestId('reach-cap-vary').check();
	await reach(page).getByRole('button', { name: 'Use October’s cap for every month' }).click();
	const capJan = reach(page).getByLabel('Most lost below Upper farm in a day in Jan, m³/day');
	const capJul = reach(page).getByLabel('Most lost below Upper farm in a day in Jul, m³/day');
	await capJan.fill('40000');
	await capJan.blur();
	await capJul.fill('300');
	await capJul.blur();
	await expectNoViolations(page, { include: '[data-testid="reach-by-month"]' });
	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);

	await page.reload();
	await openNodeForm(page);
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '2. Upper farm · hydrological unit' });
	await expect(reach(page).getByTestId('reach-vary')).toBeChecked();
	await expect(reach(page).getByLabel('Share of the flow lost below Upper farm in Jul, %')).toHaveValue('40');
	await expect(reach(page).getByLabel('Most lost below Upper farm in a day in Jan, m³/day')).toHaveValue(/^40[\s ]?000$/);
	await expect(reach(page).getByLabel('Most lost below Upper farm in a day in Jul, m³/day')).toHaveValue('300');

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('Bed losses by month');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Bed losses by month' })).toBeVisible();
	await page.getByRole('navigation', { name: 'Result sections' }).getByRole('link', { name: 'Arithmetic checks' }).click();
	const checks = page.getByRole('region', { name: /^Arithmetic checks/ });
	await expect(checks.getByRole('status').filter({ hasText: 'arithmetic checks' })).toHaveText(/^All \d+ arithmetic checks passed\.$/);
});
