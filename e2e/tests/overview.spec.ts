// The Overview tab: setup checklist and headline facts, built from the lists
// the project page loads (series, runs) and the model being edited.
import type { Page } from '@playwright/test';
import { createProject, createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const stat = (page: Page, term: string) =>
	page.locator('dl.stats > div').filter({ has: page.getByRole('term').filter({ hasText: term }) }).getByRole('definition');
const setup = (page: Page) => page.getByRole('region', { name: /^Set(up| up this catchment)/ });

test('a fresh project: nothing loaded, every step to do', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Overview empty');
	await page.goto(`/projects/${project.id}`);
	await expect(setup(page).getByRole('heading', { name: 'Set up this catchment' })).toBeVisible();
	await expect(setup(page)).toContainText('0 of 5 done');
	await expect(setup(page)).toContainText('Upload daily catchment rainfall (mm).');
	await expect(setup(page)).toContainText('Run it to get farm supply & deficit');
	await expect(stat(page, 'Time series')).toHaveText('0');
	await expect(stat(page, 'Model runs')).toHaveText('0');
	await expect(stat(page, 'Farms')).toHaveText('0+ 0 gauges');
});

test('a project with data and a run: setup complete, counts shown', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Overview ready');
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}`);
	const done = setup(page);
	await expect(done.getByRole('heading', { name: 'Setup complete' })).toBeVisible();
	await done.getByText('All 5 steps done. Show checklist').click();
	await expect(done).toContainText('Rainfall and observed flow loaded.');
	await expect(done).toContainText(/1 run, latest \d{4}-\d{2}-\d{2}\./);
	await expect(stat(page, 'Time series')).toHaveText('2');
	await expect(stat(page, 'Model runs')).toHaveText('1');
	await expect(stat(page, 'Farms')).toHaveText('2+ 1 gauge');
	await expect(stat(page, 'Outflow gauge')).toHaveText('Outflow gauge');
});
