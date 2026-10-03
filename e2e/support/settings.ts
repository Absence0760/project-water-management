// The Settings & calibration page (?tab=settings, issue #17 option A): locators
// the specs share. Invented data only.
import type { Page } from '@playwright/test';
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
