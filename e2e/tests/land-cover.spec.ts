// Land-cover streamflow reductions (roadmap WP-1.35, docs/model.md §2.5a):
// put invasive trees on a farm, save, run, read the reduction, then clear
// them on a copy and compare the two runs ("what does the river get back?").
import type { Page } from '@playwright/test';
import { copyProject, createRun, putModel, seedRunnableProject, type Model } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { openNodeForm, saveModelChanges } from '../support/network.ts';
import { answerConfirm } from '../support/confirm.ts';
import { whatChanged } from '../support/compare.ts';

const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved model changes' });

test('add invasive trees to a farm, run, and compare with a copy that clears them', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Invaded');
	await page.goto(`/projects/${project.id}?tab=network`);
	await openNodeForm(page);
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '2. Upper farm · hydrological unit' });

	const cover = page.getByRole('group', { name: 'Land cover' });
	await expect(cover.getByText('No land cover on Upper farm.')).toBeVisible();
	await cover.getByRole('button', { name: '+ Add land cover' }).click();
	await expect(cover.getByLabel('Cover class')).toHaveValue('invasive');
	await cover.getByLabel('Area (km²)').fill('3');
	await cover.getByLabel('Condensed cover (%)').fill('50');
	await expect(cover.getByText('Class reductions at full cover: 50 % of flows, 60 % of low flows.')).toBeVisible();
	// Upper farm is 12 km²: 3 × 50 % = 1.5 km², 13 %.
	await expect(cover.getByText(/Condensed cover 13 % of the hydrological unit's 12\.00 km²/)).toBeVisible();
	await saveModelChanges(page);
	await expect(saveBar(page)).toHaveCount(0);

	await page.reload();
	await openNodeForm(page);
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: '2. Upper farm · hydrological unit' });
	await expect(page.getByRole('group', { name: 'Land cover' }).getByLabel('Area (km²)')).toHaveValue('3');

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('Invaded');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Invaded' })).toBeVisible();
	// The table is in Other uses on Hydrological units (issue #137), and the Summary says so and links there.
	const toUses = page.getByTestId('other-uses-link');
	await expect(toUses).toHaveText('Land cover: Other uses on Hydrological units.');
	await expect(page.locator('#res-summary').getByRole('heading', { name: 'Land cover' })).toHaveCount(0);
	await toUses.getByRole('link', { name: 'Other uses on Hydrological units' }).click();
	await expect(page).toHaveURL(/[?&]tab=supply\b.*#res-other-uses$/);
	const uses = page.getByRole('region', { name: 'Other uses of water' });
	await expect(uses.getByRole('heading', { level: 3, name: 'Land cover' })).toBeVisible();
	await expect(uses).toBeInViewport();
	const row = uses.locator('table.land-cover').getByRole('row', { name: /^Invasive alien trees, dryland/ });
	await expect(row.getByRole('cell').first()).toHaveText('1.50');

	// The clearing scenario: a copy without the patch, compared with the invaded run.
	const invadedRun = (await (await page.request.get(`${API_URL}/projects/${project.id}/runs`)).json()).runs[0].id as string;
	const copy = await copyProject(page.request, project.id, 'Cleared');
	const model = (await (await page.request.get(`${API_URL}/projects/${copy}/model`)).json()) as Model & { landCover: unknown[] };
	await putModel(page.request, copy, { ...model, landCover: [] } as Model);
	const clearedRun = await createRun(page.request, copy, 'Cleared');
	await page.goto(`/compare?a=${project.id}:${invadedRun}&b=${copy}:${clearedRun}`);
	await expect(page.getByRole('heading', { name: 'Headline results' })).toBeVisible();
	await expect(whatChanged(page).getByText('Land cover "invasive" removed from Upper farm (was 1.5 km² condensed)')).toBeVisible();
});

test('removing a patch with an area asks, names it, and moves the focus on', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Land cover remove');
	await page.goto(`/projects/${project.id}?tab=network`);
	const sheet = await openNodeForm(page, 'Upper farm');
	const cover = sheet.getByRole('group', { name: 'Land cover', exact: true });
	await cover.getByRole('button', { name: '+ Add land cover' }).click();
	await cover.getByRole('button', { name: '+ Add land cover' }).click();
	await cover.getByLabel('Area (km²)').first().fill('2');
	await cover.getByRole('button', { name: /^Remove land-cover patch 1 \(/ }).click();
	await answerConfirm(page, false, 'Its area and cover go with it.');
	await expect(cover.getByLabel('Cover class')).toHaveCount(2);
	await cover.getByRole('button', { name: /^Remove land-cover patch 1 \(/ }).click();
	await answerConfirm(page, true);
	await expect(cover.getByLabel('Cover class')).toHaveCount(1);
	await expect(cover.getByLabel('Cover class')).toBeFocused();
	// The one left has no area: it goes at once, and + Add land cover takes the focus.
	await cover.getByRole('button', { name: /^Remove land-cover patch 1 \(/ }).click();
	await expect(page.getByRole('alertdialog')).toHaveCount(0);
	await expect(cover.getByRole('button', { name: '+ Add land cover' })).toBeFocused();
});
