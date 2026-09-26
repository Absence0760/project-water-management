// The Network page is a map (issue #17): the node table opens as a grid from
// the Grids menu (`grid=nodes`), a node's full form in a sheet from its card's
// Edit (`edit=<id>`). These open them the way a person does.
import type { Page } from '@playwright/test';

/** Opens the node table (Grids → Node table) and returns the grid's dialog. */
export async function openNodeTable(page: Page) {
	const open = page.getByRole('dialog', { name: 'Node table' });
	// The URL already names it (a reload keeps `grid=nodes`): it opens with the page; wait for it.
	if (/[?&]grid=nodes\b/.test(page.url())) {
		await open.waitFor();
		return open;
	}
	const menu = page.locator('details.grids-menu');
	if (!(await menu.evaluate((d: HTMLDetailsElement) => d.open))) await menu.locator('summary').click();
	await page.getByRole('group', { name: 'Open as a grid' }).getByRole('link', { name: 'Node table', exact: true }).click();
	return page.getByRole('dialog', { name: 'Node table' });
}

/** Opens a node's form (the first node in the list unless `name` is given) and returns the sheet's dialog. */
export async function openNodeForm(page: Page, name?: string) {
	const open = page.getByRole('dialog', { name: /^Edit |: details$/ });
	// Already open (the sheet stays open after a save, and a reload keeps `edit=`): its picker moves it
	// to another node. Wait for it rather than click the map behind it.
	if (/[?&]edit=/.test(page.url())) {
		await open.waitFor();
		return open;
	}
	const list = page.getByRole('list', { name: 'All nodes' });
	await (name ? list.getByRole('button', { name: new RegExp(`^${name}`) }) : list.getByRole('button').first()).click();
	await page.getByTestId('node-card').getByRole('button', { name: /^(Edit|Details) / }).click();
	return page.getByRole('dialog', { name: /^Edit |: details$/ });
}

/** Saves the model: in the open grid or sheet's save row if one is open (it hides the save bar), else from the save bar. */
export async function saveModelChanges(page: Page) {
	const modal = page.locator('dialog[open]');
	if (await modal.count()) await modal.getByRole('button', { name: 'Save changes' }).click();
	else await page.getByRole('region', { name: 'Unsaved model changes' }).getByRole('button', { name: 'Save changes' }).click();
}

/** Closes the open grid or sheet with Done (Close for a viewer), leaving any edit for the save bar. */
export async function closeModal(page: Page) {
	const modal = page.locator('dialog[open]');
	await modal.getByRole('button', { name: /^(Done|Close)$/ }).click();
	await modal.waitFor({ state: 'detached' });
}
