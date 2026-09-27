// The sign-up form's two password fields (issue #57: it asks twice). `exact`,
// since a label lookup for "Password" also matches "Confirm password".
import type { Page } from '@playwright/test';

export async function fillNewPassword(page: Page, password: string, confirm = password): Promise<void> {
	await page.getByLabel('Password', { exact: true }).fill(password);
	await page.getByLabel('Confirm password').fill(confirm);
}
