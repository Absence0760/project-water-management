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
