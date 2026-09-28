// The sign-up form's two password fields (issue #57: it asks twice). `exact`,
// since a label lookup for "Password" also matches "Confirm password".
import type { Page } from '@playwright/test';

export async function fillNewPassword(page: Page, password: string, confirm = password): Promise<void> {
	await page.getByLabel('Password', { exact: true }).fill(password);
	await page.getByLabel('Confirm password').fill(confirm);
}

/** Tick the sign-up form's required "I have read the main points above and accept …" box. */
export async function agreeToTerms(page: Page): Promise<void> {
	await page.getByRole('checkbox', { name: /^I have read the main points above and accept the Terms of use and Privacy notice/ }).check();
}
