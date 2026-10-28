// A sheet or modal kept in the URL (crop=, edit=, grid=, settings=) shuts at once on Done, Esc or
// the ✕, and its parameter leaves the URL only when the page's navigation lands. Meanwhile
// `<html data-closing>` is set (frontend/src/lib/nav/closeNav.ts). A helper that reads
// page.url() to learn whether something is already open waits this out first, or it would see
// the closed one still named and wait for a dialog nothing is going to open.
import type { Page } from '@playwright/test';

/** Waits until no closing sheet's URL change is under way, so page.url() says what is open. */
export async function urlSettled(page: Page) {
	await page.locator('html:not([data-closing])').waitFor({ state: 'attached' });
}
