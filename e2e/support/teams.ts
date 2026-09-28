// The team page keeps its name, the portfolio thresholds and leave/delete in a
// settings sheet (`?settings=1`, issue #17). These open and close it the way a
// person does.
import type { Page } from '@playwright/test';

/** Opens the team settings sheet from the page header and returns its dialog. */
export async function openTeamSettings(page: Page) {
	const sheet = page.getByRole('dialog', { name: 'Team settings' });
	// The URL already names it (a reload keeps `settings=1`): it opens with the page; wait for it.
	if (/[?&]settings=/.test(page.url())) {
		await sheet.waitFor();
		return sheet;
	}
	await page.getByRole('link', { name: 'Team settings', exact: true }).click();
	await sheet.waitFor();
	return sheet;
}

/** Closes the sheet with Done and waits for it to go. */
export async function closeTeamSettings(page: Page) {
	const sheet = page.getByRole('dialog', { name: 'Team settings' });
	await sheet.getByRole('button', { name: 'Done' }).click();
	await sheet.waitFor({ state: 'hidden' });
}
