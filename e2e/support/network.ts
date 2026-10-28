// The Network page is a map (issue #17): the node table opens as a grid from
// the Tables menu (`grid=nodes`), a node's full form in a sheet from its card's
// Edit (`edit=<id>`). These open them the way a person does.
import { expect, type Locator, type Page } from '@playwright/test';
import { showHeaderControls } from './sectionHeader.ts';
import { urlSettled } from './urlSettled.ts';

/** Opens the node table (Tables → Node table) and returns the grid's dialog. */
export async function openNodeTable(page: Page) {
	const open = page.getByRole('dialog', { name: 'Hydrological unit table' });
	// The URL already names it (a reload keeps `grid=nodes`): it opens with the page; wait for it.
	await urlSettled(page);
	if (/[?&]grid=nodes\b/.test(page.url())) {
		await open.waitFor();
		return open;
	}
	await showHeaderControls(page);
	const menu = page.locator('details.grids-menu');
	if (!(await menu.evaluate((d: HTMLDetailsElement) => d.open))) await menu.locator('summary').click();
	await page.getByRole('group', { name: 'Open as a table' }).getByRole('link', { name: 'Hydrological unit table', exact: true }).click();
	return page.getByRole('dialog', { name: 'Hydrological unit table' });
}

/**
 * Opens a node's form (the first node in the list unless `name` is given) and
 * returns the sheet's dialog. The form folds its sections to a line of their
 * values (issue #521); unless `folded`, this presses Show every field, so a
 * spec about a field finds it open (the switch is remembered on the device,
 * so it holds across a reload or ‹ ›). node-sheet-layout.spec.ts checks the
 * folded form itself.
 */
export async function openNodeForm(page: Page, name?: string, opts: { folded?: boolean } = {}) {
	const sheet = page.getByRole('dialog', { name: /^(?:Edit .*|.*: details)$/ });
	// Already open (the sheet stays open after a save, and a reload keeps `edit=`): its picker moves it
	// to another node. Wait for it rather than click the map behind it.
	await urlSettled(page);
	if (/[?&]edit=/.test(page.url())) await sheet.waitFor();
	else {
		const list = page.getByRole('list', { name: 'All hydrological units' });
		// The row's own Edit (the card has none since 2026-10-03).
		await (name ? list.getByRole('button', { name: new RegExp(`^(Edit|Details) ${name}`) }) : list.getByRole('button', { name: /^(Edit|Details) / }).first()).click();
	}
	if (!opts.folded) await showEveryField(sheet);
	return sheet;
}

/** Presses the node sheet's Show every field unless it is already on: every section and fold open. */
export async function showEveryField(sheet: Locator) {
	const all = sheet.getByRole('button', { name: 'Show every field' });
	if ((await all.getAttribute('aria-pressed')) !== 'true') await all.click();
	await expect(all).toHaveAttribute('aria-pressed', 'true');
}

/** Opens one section card of the node sheet by its heading (clicking its summary), and returns the card. */
export async function openNodeSection(sheet: Locator, title: string) {
	const card = sheet.locator('details.sec').filter({ has: sheet.page().locator('summary > .sec-title', { hasText: new RegExp(`^${title}$`) }) });
	if (!(await card.evaluate((d: HTMLDetailsElement) => d.open))) await card.locator(':scope > summary').click();
	await expect(card).toHaveAttribute('open', '');
	return card;
}

/** Saves the model: in the open grid or sheet's save row if one is open (it hides the save bar), else from the save bar. */
/**
 * Clicks Save changes (the open grid's or sheet's, else the save bar's) and
 * waits for the model save (PUT …/model) to answer, whether it saved or was
 * refused, so a reload or a read that follows sees what the server has.
 * The page takes the answer in a moment later: before a reload, wait for
 * the save bar (or the sheet's "No unsaved changes") too.
 */
export async function saveModelChanges(page: Page) {
	const modal = page.locator('dialog[open]');
	const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/projects\/[^/]+\/model$/.test(new URL(r.url()).pathname));
	if (await modal.count()) await modal.getByRole('button', { name: 'Save changes' }).click();
	else await page.getByRole('region', { name: 'Unsaved model changes' }).getByRole('button', { name: 'Save changes' }).click();
	return saved;
}

/**
 * Presses Done on the open sheet or grid, then clicks `opener` on the very next task: ahead of the
 * navigation that drops the closed one from the URL, as a quick person can. `opener` is behind the
 * modal until it shuts, so find it by CSS (a role query skips the inert page).
 */
export async function doneThenClick(page: Page, opener: Locator) {
	const done = await page.locator('dialog[open]').getByRole('button', { name: 'Done', exact: true }).elementHandle();
	const next = await opener.elementHandle();
	await page.evaluate(
		([d, n]) => {
			(d as HTMLElement).click();
			setTimeout(() => (n as HTMLElement).click(), 0);
		},
		[done, next] as const
	);
}

/** Closes the open grid or sheet with Done (Close for a viewer), leaving any edit for the save bar. */
export async function closeModal(page: Page) {
	const modal = page.locator('dialog[open]');
	await modal.getByRole('button', { name: /^(Done|Close)$/ }).click();
	await modal.waitFor({ state: 'detached' });
}
