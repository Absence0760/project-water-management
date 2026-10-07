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
	await expect(reach(page)).toContainText('Not used: the outlet has no reach below it in the model.');

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('Losing reach');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Losing reach' })).toBeVisible();
	// The engine's self-checks pass with the losses: every unit's inflow is the outflow above less the loss.
	await page.getByRole('navigation', { name: 'Result sections' }).getByRole('link', { name: 'Self-checks' }).click();
	const checks = page.getByRole('region', { name: /^Self-checks/ });
	await expect(checks.getByRole('status').filter({ hasText: 'self-checks' })).toHaveText(/^All \d+ self-checks passed\.$/);
	// The bed losses leave the catchment: their own column in the balance, and named in its equation.
	const balance = page.getByRole('region', { name: 'Water balance by water year' });
	await expect(balance.getByRole('columnheader', { name: 'Bed losses', exact: true })).toBeVisible();
	await expect(balance).toContainText('+ bed losses + outflow + end storage.');
});
