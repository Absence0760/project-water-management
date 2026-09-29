// Development over the run (engine 1.30.0, issue #67, docs/model.md §2.7g):
// a farm dam's survey date, sediment rate and in-service date, and a unit's
// abstraction start, in the one-node form. A rate without a survey date says
// so beside the fields; the values save, survive a reload, pass axe, and the
// run's self-checks pass with them.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openNodeForm, saveModelChanges } from '../support/network.ts';

const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });

async function openUpperFarm(page: Page) {
	await openNodeForm(page);
	await page.getByLabel('Node to edit').selectOption({ label: '2. Upper farm · hydrological unit' });
	return page.getByRole('group', { name: 'Dam survey and releases' });
}

test('date a dam’s survey, sediment and service, and a unit’s abstraction start; save, reload and run', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Dam over time');
	await page.goto(`/projects/${project.id}?tab=network`);
	const dam = await openUpperFarm(page);
	const capacity = dam.getByTestId(/^development-dam-/);
	await expect(capacity.getByRole('heading', { name: 'Capacity over time' })).toBeVisible();

	// A sediment rate needs the survey date: the form says so beside the fields.
	await capacity.getByRole('spinbutton', { name: /^Sediment/ }).fill('1.5');
	await capacity.getByRole('spinbutton', { name: /^Sediment/ }).blur();
	await expect(capacity.getByRole('alert')).toHaveText(/sediment rate needs the date the capacity was surveyed/);
	await capacity.getByLabel('Survey date', { exact: true }).fill('2015-06-01');
	await expect(capacity.getByRole('alert')).toHaveCount(0);
	await capacity.getByLabel('In service from', { exact: true }).fill('2000-01-01');
	await page.getByTestId(/^development-abstraction-/).getByLabel('Abstraction starts', { exact: true }).fill('2001-10-01');
	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);

	await page.reload();
	const again = (await openUpperFarm(page)).getByTestId(/^development-dam-/);
	await expect(again.getByLabel('Survey date', { exact: true })).toHaveValue('2015-06-01');
	await expect(again.getByRole('spinbutton', { name: /^Sediment/ })).toHaveValue('1.5');
	await expect(again.getByLabel('In service from', { exact: true })).toHaveValue('2000-01-01');
	await expect(page.getByTestId(/^development-abstraction-/).getByLabel('Abstraction starts', { exact: true })).toHaveValue('2001-10-01');
	await expectNoViolations(page, { include: `[data-testid^="development-"]` });

	// Cleared, a date is off again (null), and the save bar comes back for it.
	await again.getByLabel('In service from', { exact: true }).fill('');
	await expect(saveBar(page)).toBeVisible();
	await again.getByLabel('In service from', { exact: true }).fill('2000-01-01');

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('Dated');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Dated' })).toBeVisible();
	await page.getByRole('navigation', { name: 'Result sections' }).getByRole('link', { name: 'Self-checks' }).click();
	const checks = page.getByRole('region', { name: /^Self-checks/ });
	await expect(checks.getByRole('status').filter({ hasText: 'self-checks' })).toHaveText(/^All \d+ self-checks passed\.$/);
});
