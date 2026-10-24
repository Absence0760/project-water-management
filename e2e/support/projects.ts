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

/** A phone's Import control, one for both imports (issue #521; they were two full-width buttons); wider, the two are named buttons. */
export const importButton = (page: Page) => page.getByRole('button', { name: 'Import', exact: true });

/**
 * Open one of the two imports at any width: its named button where there is room, or on a phone from
 * Import's list (the dialog then opens with the focus kept on Import).
 */
export async function pickImport(page: Page, which: 'Import workbook' | 'Import project file (.json)') {
	await expect(page.locator('main.projects-page .head-actions')).toBeVisible();
	const trigger = importButton(page);
	// settled: the head is drawn, and which of the two shows is the viewport's media query alone, no app state.
	if (!(await trigger.isVisible())) {
		await page.getByRole('button', { name: which, exact: true }).click();
		return;
	}
	if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
	await expect(trigger).toHaveAttribute('aria-expanded', 'true');
	await page.locator('#pj-import-menu').getByRole('button', { name: which, exact: true }).click();
}

/** The per-project figures (GET /projects/outcomes) are in, or failed and said so. */
export async function outcomesReady(page: Page) {
	await expect(page.locator('main.projects-page')).toHaveAttribute('data-outcomes-ready', 'true');
}

/** A catchment's irrigation figure from GET /projects/outcomes or the portfolio (issue #558: the list's status). */
export interface IrrigationFigure {
	status: 'green' | 'amber' | 'red' | 'unknown';
	fractionSupplied: number | null;
	units: number | null;
	unitsBelow: number | null;
}

const STATUS = { red: 'Red', amber: 'Amber', green: 'Green' } as const;

/** What the list's status pill says for a known irrigation figure (frontend portfolio.ts irrigationText, short); null when unknown. */
export function irrigationPill(r: IrrigationFigure): string | null {
	if (r.status === 'unknown' || r.fractionSupplied === null) return null;
	return `${STATUS[r.status]}: ${(r.fractionSupplied * 100).toFixed(1)}% supplied`;
}

/** The line under the pill: "3 of 14 units below 95% over the run", or null when no unit is. */
export function irrigationUnits(r: IrrigationFigure): string | null {
	if (r.status === 'unknown' || !r.unitsBelow || !r.units) return null;
	return `${r.unitsBelow} of ${r.units} ${r.units === 1 ? 'unit' : 'units'} below 95% over the run`;
}
