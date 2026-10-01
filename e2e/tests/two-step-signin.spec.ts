// Two-step sign-in (issue #282; docs/ui.md § Account, docs/security.md §
// Two-step sign-in): set up an authenticator on the Account page (the
// password, the QR code drawn in the page, the first code, the recovery codes
// shown once), then sign in with a code from it and, the phone lost, with a
// recovery code. The codes are made here from the secret the page shows, with
// the backend's own RFC 6238 code (backend/src/auth/totp.ts, by path: it
// imports nothing but node:crypto). The requirement for owners, team admins
// and assessors is off on the e2e server (MFA_REQUIRED=false,
// playwright.config.ts) and tested in backend/src/auth/stepUp.db.test.ts.
import type { Page } from '@playwright/test';
import { base32Decode, hotp, totpStep } from '../../backend/src/auth/totp.ts';
import { PASSWORD } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';

/** The code for a step a few ahead of now: each sign-in uses a later step than the last (a step is never accepted twice), still inside the ±1 window. */
const codeFor = (secret: string, step: number) => hotp(base32Decode(secret)!, step);

async function signOut(page: Page, displayName: string) {
	await page.getByRole('button', { name: `Account menu for ${displayName}` }).click();
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	await expect(page).toHaveURL('/login');
}

async function password(page: Page, email: string) {
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { name: 'Two-step sign-in' })).toBeVisible();
}

test('set up two-step sign-in on the Account page, then sign in with a code, and with a recovery code', async ({ page, owner }) => {
	await page.goto('/account');
	const panel = page.getByRole('region', { name: 'Two-step sign-in' });
	await expect(panel).toHaveAttribute('data-two-step', 'off');
	await panel.getByRole('button', { name: 'Set up two-step sign-in' }).click();

	// The password first: a wrong one is refused.
	await panel.getByLabel('Current password').fill('not my password');
	await panel.getByRole('button', { name: 'Continue' }).click();
	await expect(panel.getByRole('alert')).toHaveText('Your current password is wrong.');
	await panel.getByLabel('Current password').fill(PASSWORD);
	await panel.getByRole('button', { name: 'Continue' }).click();

	// The QR code, drawn in the page, and the key to type instead.
	await expect(panel.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
	const secret = (await panel.locator('[data-totp-secret]').getAttribute('data-totp-secret'))!;
	expect(secret).toMatch(/^[A-Z2-7]{32}$/);
	await expect(panel.locator('[data-totp-secret]')).toHaveText(secret.replace(/(.{4})/g, '$1 ').trim());
	await expectNoViolations(page);

	let step = totpStep(Date.now());
	await panel.getByLabel('Enter the code the app shows').fill(codeFor(secret, step));
	await panel.getByRole('button', { name: 'Turn on two-step sign-in' }).click();

	// The recovery codes, shown once.
	await expect(panel.getByRole('heading', { name: 'Your recovery codes' })).toBeFocused();
	const codes = await panel.getByRole('listitem').allTextContents();
	expect(codes).toHaveLength(10);
	for (const c of codes) expect(c).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
	await panel.getByRole('button', { name: 'I’ve saved them' }).click();
	await expect(panel.getByRole('heading', { name: 'Your recovery codes' })).toHaveCount(0);
	await expect(panel).toHaveAttribute('data-two-step', 'on');
	await expect(panel).toContainText('10 recovery codes left.');

	// Signing in now takes a code after the password.
	await signOut(page, owner.displayName);
	await password(page, owner.email);
	await expectNoViolations(page);
	step = Math.max(step + 1, totpStep(Date.now()));
	await page.getByLabel('Code from your authenticator app').fill(codeFor(secret, step));
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	await expect(page).toHaveURL('/');

	// The phone lost: a recovery code, once.
	await signOut(page, owner.displayName);
	await password(page, owner.email);
	await page.getByRole('button', { name: 'Lost your phone? Use a recovery code' }).click();
	await expect(page.getByLabel('Recovery code')).toBeFocused();
	await page.getByLabel('Recovery code').fill('AAAAA-AAAAA');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('alert')).toHaveText('That code isn’t right. Enter the newest code from your authenticator app, or one of your recovery codes.');
	await page.getByLabel('Recovery code').fill(codes[0]!.toLowerCase());
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();

	await page.goto('/account');
	await expect(page.getByRole('region', { name: 'Two-step sign-in' })).toContainText('9 recovery codes left.');
});

test('turning two-step sign-in off needs a code, and sign-in is one step again', async ({ page, owner }) => {
	await page.goto('/account');
	const panel = page.getByRole('region', { name: 'Two-step sign-in' });
	await panel.getByRole('button', { name: 'Set up two-step sign-in' }).click();
	await panel.getByLabel('Current password').fill(PASSWORD);
	await panel.getByRole('button', { name: 'Continue' }).click();
	const secret = (await panel.locator('[data-totp-secret]').getAttribute('data-totp-secret'))!;
	const step = totpStep(Date.now());
	await panel.getByLabel('Enter the code the app shows').fill(codeFor(secret, step));
	await panel.getByRole('button', { name: 'Turn on two-step sign-in' }).click();
	await panel.getByRole('button', { name: 'I’ve saved them' }).click();

	await panel.getByRole('button', { name: 'Turn off', exact: true }).click();
	await panel.getByLabel('Code from your authenticator app, or a recovery code').fill(codeFor(secret, step + 1));
	await panel.getByRole('button', { name: 'Turn off two-step sign-in' }).click();
	await expect(panel.getByRole('status')).toHaveText('Two-step sign-in is off.');
	await expect(panel).toHaveAttribute('data-two-step', 'off');

	await signOut(page, owner.displayName);
	await page.getByLabel('Email').fill(owner.email);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
});
