// The project list (`/`, docs/ui.md § Project list): its rows, their ⋯ menu,
// and the moment its outcome figures have arrived.
import { expect, type Page } from '@playwright/test';

/** A project's row, found by its row header (the project name). */
export const row = (page: Page, name: string) =>
	page.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });

/** Open a row's ⋯ menu (Copy, and Delete for an owner). */
export async function openRowMenu(page: Page, name: string) {
	const more = row(page, name).getByRole('button', { name: `More actions for ${name}`, exact: true });
	await more.click();
	await expect(more).toHaveAttribute('aria-expanded', 'true');
}

/** The per-project figures (GET /projects/outcomes) are in, or failed and said so. */
export async function outcomesReady(page: Page) {
	await expect(page.locator('main.projects-page')).toHaveAttribute('data-outcomes-ready', 'true');
}
