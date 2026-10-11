// The Settings & calibration page (?tab=settings, issue #17 option A): locators
// the specs share. Invented data only.
import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export const header = (page: Page) => page.getByTestId('section-header');
export const settingsMenu = (page: Page) => page.getByRole('navigation', { name: 'Settings sections' });
/** The header's line: where the GR4J parameters came from. */
export const fitSummary = (page: Page) => header(page).getByTestId('fit-summary');

export async function openSettings(page: Page, projectId: string) {
	await page.goto(`/projects/${projectId}?tab=settings`);
	await expect(page.getByRole('heading', { level: 1, name: 'Settings & calibration' })).toBeVisible();
	await expect(page.getByRole('heading', { level: 2, name: 'Demand' })).toBeVisible();
}

/**
 * The workspace's one save bar (frontend model/SaveBar.svelte), named for
 * what is unsaved: "Unsaved settings" with only the settings, "Unsaved model
 * changes" once the model has edits too, "Unsaved changes" with only a number
 * that needs fixing. Settings has no save bar of its own (docs/ui.md §
 * Settings & calibration).
 */
export const settingsBar = (page: Page) => page.getByRole('region', { name: 'Unsaved settings' });
export const anySaveBar = (page: Page) => page.getByRole('region', { name: /^Unsaved / });
/** The save bar's Save changes. */
export const saveChanges = (page: Page) => anySaveBar(page).getByRole('button', { name: 'Save changes' });

/** A PATCH of the project (the settings' save), as `page.waitForRequest`/`page.on('request')` see it. */
export const isProjectPatch = (method: string, url: string) => method === 'PATCH' && /\/projects\/[^/]+$/.test(new URL(url).pathname);

/**
 * Clicks the save bar's Save changes and waits until the settings are saved:
 * the project's PATCH answered 200 and the bar said "Changes saved.".
 */
export async function saveSettings(page: Page) {
	const saved = page.waitForResponse((r) => isProjectPatch(r.request().method(), r.url()));
	await saveChanges(page).click();
	expect((await saved).status()).toBe(200);
	await expect(page.getByTestId('savebar-announcement')).toHaveText('Changes saved.');
	await expect(anySaveBar(page)).toHaveCount(0);
}

/**
 * Turns on Settings' "Explain each setting under its field" (issue #468): the explanations under the
 * fields are hidden until it is on (it is remembered in the browser's storage, so a fresh context starts off).
 */
export async function showExplanations(page: Page) {
	const sw = page.getByRole('checkbox', { name: 'Explain each setting under its field' });
	await sw.check();
	await expect(sw).toBeChecked();
}

/**
 * Opens a fold of rarely changed settings (a `<details>` whose summary line shows their values, ui-playbook.md
 * § 2): Fit automatically's search (`fit-search`), the calibration rules' search budget (`rules-search`), Flow
 * calibration's warm-up (`flow-more`) and the pan row's fill tools (`pan-tools`), the Calibration record's quality
 * flags (`record-flags`), or a group that starts closed while it is at its defaults (`common/DefaultsFold.svelte`):
 * Rain gaps' two cards (`rain-defaults`), Data quality's limits (`quality-limits`) and the WR2012 check's judging
 * (`wr2012-judging`). Does nothing when it is already open.
 */
export type FoldId = 'fit-search' | 'rules-search' | 'flow-more' | 'pan-tools' | 'record-flags' | 'rain-defaults' | 'quality-limits' | 'wr2012-judging';
export async function openFold(scope: Page | Locator, testId: FoldId) {
	const fold = scope.getByTestId(testId);
	// Its own summary: a fold can hold another <details> (the pan row's tools hold the FAO-56 helper).
	const summary = fold.locator(':scope > summary');
	await expect(summary).toBeVisible();
	if ((await fold.getAttribute('open')) === null) await summary.click();
	await expect(fold).toHaveAttribute('open', '');
}
