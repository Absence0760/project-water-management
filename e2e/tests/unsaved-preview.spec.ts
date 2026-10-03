// Preview of unsaved edits against the last run (issue #284, docs/ui.md §
// Preview unsaved edits): on Settings an editor changes the A-pan and, before
// saving, sees what it does to the last run, worked out in the browser by the
// preview worker; on Crops & demand the save bar's Preview does the same for
// the model's edits, naming the unit whose supply moves. Nothing is saved and
// no run is made. With no run yet, the preview says to run the model first.
// Axe on the dialog at desktop and phone width.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createProject, createRun, seedRunnableProject } from '../support/api.ts';
import { openCropGrid } from '../support/crops.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { closeModal } from '../support/network.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { openSettings, settingsBar } from '../support/settings.ts';

const preview = (page: Page) => page.getByRole('dialog', { name: /^Preview: your unsaved / });

/** The figures table's row for one figure: its last-run, with-edits and change cells. */
const figure = (page: Page, name: string) => preview(page).getByTestId('unsaved-preview-table').getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });

async function runCount(page: Page, projectId: string): Promise<number> {
	const res = await page.request.get(`${API_URL}/projects/${projectId}/runs`);
	expect(res.status()).toBe(200);
	return ((await res.json()) as { runs: unknown[] }).runs.length;
}

test('Settings: the unsaved A-pan previewed against the last run, nothing saved and no run made', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Preview settings');
	await createRun(page.request, project.id, 'Base');
	await openSettings(page, project.id);

	// Nothing unsaved, nothing to preview.
	await expect(page.getByRole('button', { name: 'Preview', exact: true })).toHaveCount(0);

	// Triple the A-pan over the run's months (it starts 1 October and runs 120 days).
	for (const [m, v] of [['Oct', '450'], ['Nov', '540'], ['Dec', '660'], ['Jan', '690']] as const) {
		await page.getByLabel(`A-pan evaporation, ${m}, mm`).fill(v);
	}
	await page.getByLabel('A-pan evaporation, Jan, mm').blur();
	await page.getByRole('button', { name: 'Preview', exact: true }).click();

	const dialog = preview(page);
	await expect(dialog).toHaveAccessibleName('Preview: your unsaved settings');
	await expect(dialog.getByTestId('unsaved-preview')).toHaveAttribute('data-state', 'done');
	await expect(dialog.getByText(/^The last run, Base, on its own inputs/)).toBeVisible();
	// More evaporation: more demand, more shortfall; the change says which way, in words too.
	await expect(figure(page, 'Demand (m³/day)').getByRole('cell').last()).toContainText(/up [\d ]+$/);
	await expect(figure(page, 'Shortfall (m³/day)').getByRole('cell').last()).toContainText(/up [\d ]+, worse$/);
	await expect(dialog.getByTestId('unsaved-preview-problems')).toHaveCount(0);
	await expectNoViolations(page, { include: '[data-testid="unsaved-preview"]' });
	await page.setViewportSize({ width: 390, height: 844 });
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page, { include: '[data-testid="unsaved-preview"]' });
	await page.setViewportSize({ width: 1280, height: 900 });

	// Closed, the edits are still unsaved, and the preview made no run and saved nothing.
	await dialog.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(settingsBar(page).getByRole('button', { name: 'Save changes' })).toBeEnabled();
	await expect(page.getByLabel('A-pan evaporation, Oct, mm')).toHaveValue('450');
	expect(await runCount(page, project.id)).toBe(1);
	const res = await page.request.get(`${API_URL}/projects/${project.id}`);
	expect(((await res.json()) as { project: { settings: { apanMm: number[] } } }).project.settings.apanMm[0]).toBe(150);
});

test("Crops & demand: the save bar's Preview shows the unit whose supply the unsaved planted area moves", async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Preview crops');
	await createRun(page.request, project.id, 'Base');
	await page.goto(`/projects/${project.id}?tab=crops`);

	const grid = await openCropGrid(page, 'planted-areas');
	await grid.getByLabel('Orchard on Upper farm, ha').fill('80');
	await grid.getByLabel('Orchard on Upper farm, ha').press('Tab');
	await closeModal(page);

	const bar = page.getByRole('region', { name: 'Unsaved model changes' });
	await bar.getByRole('button', { name: 'Preview', exact: true }).click();
	const dialog = preview(page);
	await expect(dialog).toHaveAccessibleName('Preview: your unsaved model edits');
	await expect(dialog.getByTestId('unsaved-preview')).toHaveAttribute('data-state', 'done');
	await expect(figure(page, 'Demand (m³/day)').getByRole('cell').last()).toContainText(/up [\d ]+$/);
	// The unit whose planted area grew is listed with its share of demand met before and after.
	await expect(dialog.getByTestId('unsaved-preview-units').getByRole('rowheader', { name: 'Upper farm', exact: true })).toBeVisible();
	await expectNoViolations(page, { include: '[data-testid="unsaved-preview"]' });

	await dialog.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(bar.getByRole('button', { name: 'Save changes' })).toBeEnabled();
	expect(await runCount(page, project.id)).toBe(1);
});

test("Settings: the one save bar's Preview takes the settings and the model's edits; a runs list the page couldn't load is asked for again", async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Preview both');
	await createRun(page.request, project.id, 'Base');
	// The page's first runs list fails (it then holds null): the preview must not read that as "no run".
	let failed = 0;
	await page.route(
		(url) => url.pathname.endsWith(`/projects/${project.id}/runs`),
		async (route) => {
			if (route.request().method() === 'GET' && failed === 0) {
				failed++;
				await route.fulfill({ status: 500, json: { error: 'down' } });
			} else await route.continue();
		}
	);
	await page.goto(`/projects/${project.id}?tab=crops`);
	const grid = await openCropGrid(page, 'planted-areas');
	await grid.getByLabel('Orchard on Upper farm, ha').fill('80');
	await grid.getByLabel('Orchard on Upper farm, ha').press('Tab');
	await closeModal(page);
	expect(failed).toBe(1);

	// On Settings there is still one bar, with one Preview: it takes the settings with the model's edits.
	await page.getByRole('link', { name: 'Settings & calibration' }).first().click();
	await expect(page.getByRole('heading', { level: 2, name: 'Demand' })).toBeVisible();
	const bar = page.getByRole('region', { name: 'Unsaved model changes' });
	await expect(bar.getByRole('button', { name: 'Save changes' })).toBeVisible();
	await page.getByLabel('A-pan evaporation, Oct, mm').fill('450');
	await page.getByLabel('A-pan evaporation, Oct, mm').blur();
	await expect(page.getByRole('button', { name: 'Preview', exact: true })).toHaveCount(1);
	await bar.getByRole('button', { name: 'Preview', exact: true }).click();

	const dialog = preview(page);
	await expect(dialog).toHaveAccessibleName('Preview: your unsaved settings and model edits');
	await expect(dialog.getByTestId('unsaved-preview')).toHaveAttribute('data-state', 'done');
	await expect(dialog.getByText(/^The last run, Base, on its own inputs/)).toBeVisible();
	await expect(dialog.getByTestId('unsaved-preview-units').getByRole('rowheader', { name: 'Upper farm', exact: true })).toBeVisible();
});

test('with no run yet, the preview says to run the model first', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Preview no run');
	await openSettings(page, project.id);
	await page.getByLabel('A-pan evaporation, Oct, mm').fill('200');
	await page.getByLabel('A-pan evaporation, Oct, mm').blur();
	await page.getByRole('button', { name: 'Preview', exact: true }).click();
	await expect(preview(page).getByTestId('unsaved-preview-no-run')).toHaveText(/^There is no run to compare with yet\./);
	await expectNoViolations(page, { include: '[data-testid="unsaved-preview"]' });
});
