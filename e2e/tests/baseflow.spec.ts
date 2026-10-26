// A unit's base-flow loss and gain (engine 1.86.0, issue #523 B1, docs/model.md
// §2.6b): set both on a unit in the one-node form, save, reload, see them kept,
// check a gauge has no such section, and run the model with them: the
// self-checks pass and the water balance shows the gain as a gain and the
// loss as a loss.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openNodeForm, saveModelChanges } from '../support/network.ts';

const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });
const baseflow = (page: Page) => page.getByRole('group', { name: 'Base-flow loss and gain' });

test('set a base-flow loss and gain on a unit, save, reload and run', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Base flow');
	await page.goto(`/projects/${project.id}?tab=network`);
	await openNodeForm(page);
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '2. Upper farm · hydrological unit' });

	const loss = baseflow(page).getByLabel('Base-flow loss (m³/day)');
	const gain = baseflow(page).getByLabel('Base-flow gain (m³/day)');
	await expect(loss).toHaveValue('0');
	await expect(gain).toHaveValue('0');
	await loss.fill('2000');
	await loss.blur();
	await gain.fill('150');
	await gain.blur();
	await expectNoViolations(page, { include: '[data-testid="baseflow-note"]' });
	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);

	await page.reload();
	await openNodeForm(page);
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '2. Upper farm · hydrological unit' });
	await expect(baseflow(page).getByLabel('Base-flow loss (m³/day)')).toHaveValue(/^2[\s ]?000$/);
	await expect(baseflow(page).getByLabel('Base-flow gain (m³/day)')).toHaveValue('150');

	// A gauge has no runoff of its own, so no base-flow section.
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '1. Outflow gauge · gauge' });
	await expect(baseflow(page)).toHaveCount(0);

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('Base flow');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Base flow' })).toBeVisible();
	await page.getByRole('navigation', { name: 'Result sections' }).getByRole('link', { name: 'Arithmetic checks' }).click();
	const checks = page.getByRole('region', { name: /^Arithmetic checks/ });
	await expect(checks.getByRole('status').filter({ hasText: 'arithmetic checks' })).toHaveText(/^All \d+ arithmetic checks passed\.$/);
	// The gain comes in, the loss leaves the catchment: their own columns, named in the equation.
	const balance = page.getByRole('region', { name: 'Water balance by water year' });
	await expect(balance.getByRole('columnheader', { name: 'Base-flow gain', exact: true })).toBeVisible();
	await expect(balance.getByRole('columnheader', { name: 'Base-flow loss', exact: true })).toBeVisible();
	await expect(balance).toContainText('+ base-flow gain + rain on dams =');
	await expect(balance).toContainText('+ base-flow loss + outflow + end storage.');
});
