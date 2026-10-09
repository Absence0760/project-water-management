// Recovery codes, made harder to lose (205_mfa_recovery; docs/ui.md
// § Account, docs/security.md § Two-step sign-in → Recovery codes): at
// set-up the ten codes download as a text file and copy to the clipboard,
// both made in the browser; the Account page counts what is left and, at two
// or fewer, warns to make a new set. The resets of a lost factor, with their
// emails, are mfa-reset-mailpit.spec.ts.
import { readFile } from 'node:fs/promises';
import { base32Decode, hotp, totpStep } from '../../backend/src/auth/totp.ts';
import { PASSWORD } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { keepRecoveryCodes } from '../support/db.ts';
import { expect, test } from '../support/fixtures.ts';

test('at set-up the codes download as a text file and copy, then the Account page counts them and warns at two', async ({ page, owner, context }) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await page.goto('/account');
	const panel = page.getByRole('region', { name: 'Two-step sign-in' });
	await panel.getByRole('button', { name: 'Set up the app' }).click();
	await panel.getByLabel('Current password').fill(PASSWORD);
	await panel.getByRole('button', { name: 'Continue' }).click();
	const secret = (await panel.locator('[data-totp-secret]').getAttribute('data-totp-secret'))!;
	await panel.getByLabel('Enter the code the app shows').fill(hotp(base32Decode(secret)!, totpStep(Date.now())));
	await panel.getByRole('button', { name: 'Turn on the authenticator app' }).click();
	await expect(panel.getByRole('heading', { name: 'Your recovery codes' })).toBeFocused();
	const codes = await panel.locator('.code-list li').allTextContents();
	expect(codes).toHaveLength(10);

	// The file: a heading naming the account, the ten codes one a line, how they work.
	const [download] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: 'Download the codes' }).click()]);
	expect(download.suggestedFilename()).toBe('water-management-recovery-codes.txt');
	const file = await readFile((await download.path())!, 'utf8');
	expect(file).toBe(`Water Management recovery codes for ${owner.email}\n\n${codes.join('\n')}\n\nEach code works once, in place of a code from your authenticator app or your email.\n`);

	// The clipboard: the same text.
	await panel.getByRole('button', { name: 'Copy the codes' }).click();
	await expect(panel.getByRole('status').filter({ hasText: 'Copied.' })).toHaveText('Copied. Paste them somewhere safe, such as a password manager.');
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(file);
	await expectNoViolations(page);

	await panel.getByRole('button', { name: 'I’ve saved them' }).click();
	await expect(panel.locator('[data-codes-left]')).toHaveText('10 recovery codes left.');
	await expect(panel.locator('[data-few-codes]')).toHaveCount(0);

	// Three left: still no warning; two: the warning, and a new set from it.
	await keepRecoveryCodes(owner.email, 3);
	await page.reload();
	await expect(panel.locator('[data-codes-left]')).toHaveText('3 recovery codes left.');
	await expect(panel.locator('[data-few-codes]')).toHaveCount(0);
	await keepRecoveryCodes(owner.email, 2);
	await page.reload();
	await expect(panel.locator('[data-codes-left]')).toHaveText('2 recovery codes left.');
	const warning = panel.locator('[data-few-codes]');
	await expect(warning).toContainText('You’re running out of recovery codes.');
	await expectNoViolations(page);
	await warning.getByRole('button', { name: 'Make a new set' }).click();
	await panel.getByLabel('Code from your authenticator app or your email', { exact: true }).fill(hotp(base32Decode(secret)!, totpStep(Date.now()) + 1));
	await panel.getByRole('button', { name: 'Make new recovery codes' }).click();
	await expect(panel.getByRole('heading', { name: 'Your recovery codes' })).toBeFocused();
	await panel.getByRole('button', { name: 'I’ve saved them' }).click();
	await expect(panel.locator('[data-codes-left]')).toHaveText('10 recovery codes left.');
	await expect(panel.locator('[data-few-codes]')).toHaveCount(0);
});
