// The Demands grid's run columns (docs/ui.md § Demands grid): the latest
// run's mean supplied and short-fall a day beside each demand, named by a
// caption; a demand the run doesn't have reads "–", and unsaved edits are
// called out as not in it. Synthetic data only.
import type { Page } from '@playwright/test';
import { createRun, putModel, sampleModel, seedRunnableProject } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';

const grid = (page: Page) => page.getByTestId('demands-grid');
const rowOf = (page: Page, name: RegExp) => grid(page).locator('tbody tr', { has: page.getByRole('rowheader', { name }) });

function withTown(m: ReturnType<typeof sampleModel>, towns: string[]) {
	const upper = m.nodes[1] as { id: string };
	return {
		...m,
		demandObjects: towns.map((name) => ({
			id: crypto.randomUUID(),
			nodeId: upper.id,
			name,
			category: 'municipal',
			sizing: 'monthly',
			monthlyM3Day: new Array(12).fill(300),
			count: null,
			litresPerUnitDay: null,
			lossPct: 0,
			monthlyFactor: null,
			returnPct: 0,
			priority: 'first',
			destination: 'internal',
			enabled: true,
			note: ''
		}))
	};
}

test('the latest run’s supplied and short-fall beside each demand, – for one added since, and unsaved edits called out', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Demands grid run');
	const model = withTown(project.model, ['Town']);
	await putModel(page.request, project.id, model);
	await createRun(page.request, project.id, 'Dry year');
	// A second town after the run: the run has no figure for it.
	const after = { ...model, demandObjects: [...model.demandObjects, ...withTown(project.model, ['New town']).demandObjects] };
	await putModel(page.request, project.id, after);

	await page.goto(`/projects/${project.id}?tab=network&grid=demands`);
	await expect(page.getByRole('dialog', { name: 'Demands' })).toBeVisible();
	await expect(page.getByTestId('demands-run')).toContainText('Supplied and Short: the mean a day over run “Dry year”, ran ');
	await expect(grid(page).getByRole('columnheader', { name: /^Supplied/ })).toBeVisible();

	// Town was in the run: a figure; its supplied and short add up to what it asked of the unit.
	const town = rowOf(page, /^Town/);
	await expect(town.locator('[data-run="supplied"]')).toHaveText(/^[\d\s]+$/);
	await expect(town.locator('[data-run="short-pct"]')).toHaveText(/^\d+\s?%$/);
	// Each unit's crops have their figure (the unit's, less its objects').
	await expect(rowOf(page, /^Crops/).first().locator('[data-run="supplied"]')).toHaveText(/^[\d\s]+$/);
	// New town wasn't: no figure.
	await expect(rowOf(page, /^New town/).locator('[data-run="supplied"]')).toHaveText('–');
	await expect(rowOf(page, /^New town/).locator('[data-run="short-pct"]')).toHaveText('–');
	await expectNoViolations(page, { include: '[data-testid="demands-grid"]' });

	// An unsaved edit isn't in the run, and the caption says so.
	await expect(page.getByTestId('demands-run')).not.toContainText('Unsaved changes');
	await page.getByLabel('Town, Oct, m³/day', { exact: true }).fill('900');
	await page.getByLabel('Town, Oct, m³/day', { exact: true }).press('Tab');
	await expect(page.getByTestId('demands-run')).toContainText("Unsaved changes aren't in it");
});

test('no run yet: no run columns and no caption', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Demands grid no run');
	await putModel(page.request, project.id, withTown(project.model, ['Town']));
	await page.goto(`/projects/${project.id}?tab=network&grid=demands`);
	await expect(rowOf(page, /^Town/)).toBeVisible();
	await expect(page.getByTestId('demands-run')).toHaveCount(0);
	await expect(grid(page).getByRole('columnheader', { name: /^Supplied/ })).toHaveCount(0);
});
