// Crops & demand is a crop list and bars (issue #17, option A · A3): the full grids
// open from the header's Tables menu in the grid modal (`grid=<id>`), a crop's
// name and factors in a side sheet from its row's Edit (`crop=<id>`). These
// open them the way a person does. Save and close with saveModelChanges /
// closeModal from ./network.ts.
import type { Page } from '@playwright/test';

export type CropGrid = 'crop-factors' | 'planted-areas';
const TITLE: Record<CropGrid, string> = {
	'crop-factors': 'Crop factors',
	'planted-areas': 'Planted areas'
};
const MENU: Record<CropGrid, string> = { 'crop-factors': 'Crop factors', 'planted-areas': 'Planted areas' };

/** Opens one of the crop grids from the Crops page's Tables menu and returns the grid's dialog. */
export async function openCropGrid(page: Page, grid: CropGrid) {
	const dialog = page.getByRole('dialog', { name: TITLE[grid] });
	// The URL already names it (a reload keeps `grid=`): it opens with the page; wait for it.
	if (new RegExp(`[?&]grid=${grid}\\b`).test(page.url())) {
		await dialog.waitFor();
		return dialog;
	}
	const menu = page.locator('details.grids-menu');
	if (!(await menu.evaluate((d: HTMLDetailsElement) => d.open))) await menu.locator('summary').click();
	await page.getByRole('group', { name: 'Open as a table' }).getByRole('link', { name: MENU[grid], exact: true }).click();
	await dialog.waitFor();
	return dialog;
}

/** Opens a crop's sheet from its row in the crop list (Edit, or View for a viewer) and returns the sheet's dialog. */
export async function openCropSheet(page: Page, name: string) {
	const sheet = page.getByRole('dialog', { name: new RegExp(`^(Edit ${name}|${name}: crop factors)$`) });
	if (/[?&]crop=/.test(page.url())) {
		await sheet.waitFor();
		return sheet;
	}
	await page.getByRole('button', { name: new RegExp(`^(Edit|View) ${name}$`) }).click();
	await sheet.waitFor();
	return sheet;
}

/** Adds a crop from the header's + Add crop and returns its sheet (named "Edit Crop N" until renamed). */
export async function addCrop(page: Page) {
	await page.getByRole('button', { name: '+ Add crop', exact: true }).click();
	const sheet = page.getByRole('dialog', { name: /^Edit / });
	await sheet.waitFor();
	return sheet;
}
