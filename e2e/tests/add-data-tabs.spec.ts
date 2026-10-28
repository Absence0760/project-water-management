// Add data shows only on the tabs it adds data to (issue #601; docs/ui.md §
// Header: data freshness and "Add data"): the header button, a CSV dropped on
// the page and the `?add=data` link all follow frontend/src/lib/workspace/tabs.ts
// TAB_ADDS_DATA. The lists here are written out on purpose, so a change to the
// flag has to change this pin too. Synthetic data only.
import type { Page } from '@playwright/test';
import { seedRunnableProject } from '../support/api.ts';
import { addDataDialog, dropCsv } from '../support/addData.ts';
import { expect, test } from '../support/fixtures.ts';

const ADDS_DATA = ['overview', 'crops', 'series', 'settings', 'calibration'];
const NO_ADD_DATA = ['network', 'map', 'transfers', 'warnings', 'runs', 'river', 'supply', 'dams', 'compare', 'scenarios', 'allocations', 'project', 'applications', 'history'];

const header = (page: Page) => page.getByTestId('section-header');
const addButton = (page: Page) => header(page).getByRole('button', { name: 'Add data', exact: true });

async function openTab(page: Page, projectId: string, tab: string) {
	await page.goto(`/projects/${projectId}?tab=${tab}`);
	await expect(header(page).getByRole('heading', { level: 1 })).toBeVisible();
	// The main box is drawn with the header, Add data in it or not.
	await expect(header(page).getByTestId('header-main')).toBeAttached();
}

test.describe('desktop', () => {
	test.use({ viewport: { width: 1440, height: 960 } });

	test('an editor gets Add data on Summary, Crops & demand, Data, Model settings and Calibration only', async ({ page, owner }) => {
		test.setTimeout(90_000);
		void owner;
		const project = await seedRunnableProject(page.request, 'Add data tabs');
		for (const tab of ADDS_DATA) {
			await openTab(page, project.id, tab);
			await expect(addButton(page), tab).toBeVisible();
		}
		for (const tab of NO_ADD_DATA) {
			await openTab(page, project.id, tab);
			await expect(addButton(page), tab).toHaveCount(0);
		}
		// Allocations keeps its own import, which no header Add data sits beside any more.
		await openTab(page, project.id, 'allocations');
		await expect(header(page).getByText('+ Add volume', { exact: true })).toBeVisible();
		await expect(addButton(page)).toHaveCount(0);
	});

	test('a CSV dropped on a tab without Add data is refused and says where to drop it; on Data it opens the dialog', async ({ page, owner }) => {
		void owner;
		const project = await seedRunnableProject(page.request, 'Add data drop tabs');
		await openTab(page, project.id, 'allocations');
		// The page still takes the drop, so the browser doesn't open the file in place of the app.
		const prevented = await page.locator('main.page').evaluate((main) => {
			const data = new DataTransfer();
			data.items.add(new File(['date,value\n2024-01-01,3\n'], 'rain.csv', { type: 'text/csv' }));
			const over = new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true });
			main.dispatchEvent(over);
			const drop = new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true });
			main.dispatchEvent(drop);
			return [over.defaultPrevented, drop.defaultPrevented];
		});
		expect(prevented).toEqual([true, true]);
		await expect(header(page).getByTestId('notice-line')).toContainText(
			'This page doesn’t take files. To add data, drop the file on Summary, Crops & demand, Data, Model settings or Calibration.'
		);
		await expect(addDataDialog(page)).toHaveCount(0);

		// On Data the same drop opens the dialog with the file.
		await openTab(page, project.id, 'series');
		await dropCsv(page, 'rain.csv', 'date,value\n2024-01-01,3\n');
		await expect(addDataDialog(page)).toBeVisible();
	});

	test('?add=data opens the dialog where the tab has Add data, and over Data where it has not', async ({ page, owner }) => {
		void owner;
		const project = await seedRunnableProject(page.request, 'Add data link tabs');
		const dialog = addDataDialog(page);

		// The project list's link: the Summary, which keeps the button; the param goes.
		await page.goto(`/projects/${project.id}?add=data`);
		await expect(dialog).toBeVisible();
		await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(addButton(page)).toBeVisible();

		// Model settings has the button: the dialog opens there.
		await page.goto(`/projects/${project.id}?tab=settings&add=data`);
		await expect(dialog).toBeVisible();
		await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=settings$`));
		await page.keyboard.press('Escape');

		// Allocations hasn't: the dialog opens over Data, so closing it leaves you by the button.
		await page.goto(`/projects/${project.id}?tab=allocations&add=data`);
		await expect(dialog).toBeVisible();
		await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=series$`));
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(header(page).getByRole('heading', { level: 1, name: 'Data' })).toBeVisible();
		await expect(addButton(page)).toBeVisible();
	});
});
