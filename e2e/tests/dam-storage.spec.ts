// Dam survey curves and releases (roadmap WP-3.5, docs/model.md §2.7a): paste
// a farm dam's survey rows in the one-node form, give it a fixed release and
// a seepage share, save, reload, see the curve's table and chart, pass axe,
// and run the model with them.
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

test('paste a dam survey curve, set a release, save, reload and run', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Dam survey');
	await page.goto(`/projects/${project.id}?tab=network`);
	const dam = await openUpperFarm(page);
	await expect(dam.getByText(/No survey curve: using the power-law area/)).toBeVisible();

	// A row that breaks the rule says so and keeps the curve off.
	await dam.getByRole('button', { name: 'Paste survey rows' }).click();
	const box = dam.getByLabel(/Level \(m\), area \(m²\), volume \(m³\)/);
	await box.fill('100, 0, 0\n101, 8000');
	await dam.getByRole('button', { name: 'Use these rows' }).click();
	await expect(dam.getByRole('alert')).toHaveText('Line 2: expected 3 values (level, area, volume), found 2.');

	// Synthetic survey rows, a header line and a tab-separated row included; the top row is the 150 000 m³ capacity.
	await box.fill('Level\tArea\tVolume\n100, 0, 0\n102, 20000, 20000\n104\t40000\t70000\n106, 55000, 150000');
	await dam.getByRole('button', { name: 'Use these rows' }).click();
	await expect(dam.getByText('Using the survey curve for the dam area; the area when full and exponent are not used.')).toBeVisible();

	await dam.getByLabel('Release rule').selectOption('fixed');
	await dam.getByLabel('Dam release of Upper farm in Oct, m³/day').fill('120');
	await dam.getByRole('button', { name: 'Use October’s amount for every month' }).click();
	await page.getByRole('group', { name: 'Dam' }).getByLabel('Seepage returning (%)').fill('40');
	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);

	await page.reload();
	const again = await openUpperFarm(page);
	const survey = again.getByRole('table', { name: 'Survey rows of Upper farm' });
	await expect(survey.getByRole('row')).toHaveCount(5);
	await expect(survey.getByRole('row').nth(4)).toHaveText(/106\s*55\u202f000\s*150\u202f000/);
	await expect(again.getByRole('img', { name: /Area against volume for Upper farm: from 0 m² at 0 m³ to 55 000 m² at 150 000 m³/ })).toBeVisible();
	await expect(again.getByLabel('Release rule')).toHaveValue('fixed');
	await expect(again.getByLabel('Dam release of Upper farm in Sep, m³/day')).toHaveValue('120');
	await expect(page.getByRole('group', { name: 'Dam' }).getByLabel('Seepage returning (%)')).toHaveValue('40');
	await expectNoViolations(page, { include: `[data-testid^="dam-storage-"]` });

	// A gauge has no dam, so no survey or releases.
	await page.getByLabel('Node to edit').selectOption({ label: '1. Outflow gauge · gauge' });
	await expect(page.getByRole('group', { name: 'Dam survey and releases' })).toHaveCount(0);

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('Surveyed');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Surveyed' })).toBeVisible();
	// The engine's self-checks pass with the curve, the release and the lost seepage.
	await page.getByRole('navigation', { name: 'Result sections' }).getByRole('link', { name: 'Self-checks' }).click();
	const checks = page.getByRole('region', { name: /^Self-checks/ });
	await expect(checks.getByRole('status').filter({ hasText: 'self-checks' })).toHaveText('All 10 self-checks passed.');
	// The seepage lost from the catchment is a loss in the balance: its own column, and named in the equation.
	const balance = page.getByRole('region', { name: 'Water balance by water year' });
	await expect(balance.getByRole('columnheader', { name: 'Seepage lost', exact: true })).toBeVisible();
	await expect(balance).toContainText('= consumptive use + dam evaporation + seepage lost + outflow + end storage.');
});
