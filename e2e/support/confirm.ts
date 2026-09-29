// The app's confirmation dialog (frontend lib/components/common/ConfirmHost.svelte,
// issue #162): an alertdialog with Cancel and a confirm button named after the
// action. It replaced the browser's confirm() box, so specs answer it by
// clicking, not with page.on('dialog') (which now only meets the browser's own
// prompt on a reload or tab close).
import { expect, type Locator, type Page } from '@playwright/test';

/** The confirmation dialog on screen. */
export const confirmBox = (page: Page): Locator => page.getByRole('alertdialog');

/**
 * Answer the question on screen: `true` clicks the confirm button, `false` Cancel.
 * `text` (optional) is checked against the dialog's title and message first.
 */
export async function answerConfirm(page: Page, ok: boolean, text?: string | RegExp): Promise<void> {
	const box = confirmBox(page);
	await expect(box).toBeVisible();
	if (text !== undefined) await expect(box).toContainText(text);
	await box.getByTestId(ok ? 'confirm-ok' : 'confirm-cancel').click();
	await expect(box).toBeHidden();
}
