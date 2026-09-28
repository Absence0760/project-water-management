// The workspace's Compare runs tab (issue #17, option A step 3): the /compare
// page's view inside the project, its pair in the workspace URL.
import type { Page } from '@playwright/test';
import { createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const nav = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });
const runPicker = (page: Page, side: 'Baseline' | 'What-if 1') =>
	page.getByRole('group', { name: side, exact: true }).getByRole('combobox', { name: 'Run' });

test('Compare runs opens on the latest run against the one before, and keeps its pair in the workspace URL', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Compare tab');
	const first = await createRun(page.request, project.id, 'Baseline');
	const second = await createRun(page.request, project.id, 'Second');

	// From the Runs tab's link, into the tab (not the standalone page).
	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByRole('region', { name: 'Runs', exact: true }).getByRole('link', { name: 'Compare runs' }).click();
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=compare&a=${project.id}%3A${first}&b=${project.id}%3A${second}$`));
	await expect(nav(page).getByRole('link', { name: 'Compare runs' })).toHaveAttribute('aria-current', 'page');
	await expect(page.getByTestId('project-name').filter({ hasText: 'Compare tab' })).toBeVisible();
	await expect(runPicker(page, 'Baseline')).toHaveValue(first);
	await expect(runPicker(page, 'What-if 1')).toHaveValue(second);
	await expect(page.getByRole('heading', { level: 2, name: 'Headline results' })).toBeVisible();

	// Swapping a side stays in the tab.
	await runPicker(page, 'What-if 1').selectOption(first);
	await expect(page).toHaveURL(new RegExp(`\\?tab=compare&a=${project.id}%3A${first}&b=${project.id}%3A${first}$`));
	await expect(page.getByText('Both sides are the same run, so nothing has changed.')).toBeVisible();

	// Back returns to the previous pair.
	await page.goBack();
	await expect(runPicker(page, 'What-if 1')).toHaveValue(second);
});
