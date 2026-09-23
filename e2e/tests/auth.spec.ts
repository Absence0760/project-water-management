import { createProject, PASSWORD, register, uniqueEmail } from '../support/api.ts';
import { plantEmailToken } from '../support/db.ts';
import { expect, test } from '../support/fixtures.ts';

async function signInThroughForm(page: import('@playwright/test').Page, email: string, password: string) {
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
}

test('register lands on the project list, sign out and back in', async ({ page }) => {
	const email = uniqueEmail('new-user');

	await page.goto('/register');
	await page.getByLabel('Display name').fill('New User');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Create account' }).click();

	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	await expect(page).toHaveURL('/');
	await expect(page.getByText('You have no projects yet.')).toBeVisible();
	await expect(page.getByRole('banner')).toContainText('New User');

	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL('/login');
	await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

	// The session is really gone: a protected page bounces back to login.
	await page.goto('/');
	await expect(page).toHaveURL(/\/login\?next=/);

	await signInThroughForm(page, email, PASSWORD);
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	await expect(page).toHaveURL('/');
});

test('a wrong password shows an error and stays on the login page', async ({ page, playwright }) => {
	const api = await playwright.request.newContext();
	const user = await register(api, 'Forgetful');
	await api.dispose();

	await page.goto('/login');
	await signInThroughForm(page, user.email, 'not the password');

	await expect(page.getByRole('alert')).toHaveText('wrong email or password');
	await expect(page).toHaveURL('/login');
	await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
});

test('registering an email twice is refused', async ({ page, playwright }) => {
	const api = await playwright.request.newContext();
	const user = await register(api, 'Taken');
	await api.dispose();

	await page.goto('/register');
	await page.getByLabel('Display name').fill('Someone else');
	await page.getByLabel('Email').fill(user.email);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Create account' }).click();

	await expect(page.getByRole('alert')).toHaveText('an account with that email already exists');
});

test('an unauthenticated deep link goes to login and back after signing in', async ({ page, playwright }) => {
	const api = await playwright.request.newContext();
	const user = await register(api, 'Deep linker');
	const project = await createProject(api, 'Deep-linked catchment');
	await api.dispose();

	await page.goto(`/projects/${project.id}?tab=settings`);
	await expect(page).toHaveURL(`/login?next=${encodeURIComponent(`/projects/${project.id}?tab=settings`)}`);

	await signInThroughForm(page, user.email, user.password);

	await expect(page).toHaveURL(`/projects/${project.id}?tab=settings`);
	await expect(page.getByRole('heading', { level: 1, name: 'Deep-linked catchment' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
});

test('an off-site ?next= is ignored after signing in', async ({ page, playwright }) => {
	const api = await playwright.request.newContext();
	const user = await register(api, 'Redirect target');
	await api.dispose();

	await page.goto('/login?next=//evil.example.com/');
	await signInThroughForm(page, user.email, user.password);

	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	await expect(page).toHaveURL('/');
});

// --- Email flows. e2e mails go to the backend log (MAIL_TRANSPORT=log), so the
// link tokens below are planted in the database (support/db.ts). ---

test('"Forgot password?" carries the typed email and the request is acknowledged', async ({ page }) => {
	const email = uniqueEmail('forgetful');
	await page.goto('/login');
	await page.getByLabel('Email').fill(email);
	await page.getByRole('link', { name: 'Forgot password?' }).click();

	await expect(page).toHaveURL(`/forgot-password?email=${encodeURIComponent(email)}`);
	await expect(page.getByLabel('Email')).toHaveValue(email);
	await page.getByRole('button', { name: 'Send reset link' }).click();

	// Same answer whether or not the address has an account.
	await expect(page.getByRole('heading', { level: 1, name: 'Check your email' })).toBeVisible();
	await expect(page.getByRole('status')).toContainText(`If there is an account for ${email}`);
});

test('a reset link sets a new password and signs in with it', async ({ page, playwright }) => {
	const api = await playwright.request.newContext();
	const user = await register(api, 'Resetter');
	await api.dispose();
	const token = await plantEmailToken(user.email, 'reset');

	await page.goto(`/reset-password?token=${token}`);
	// The token is dropped from the address bar once read.
	await expect(page).toHaveURL('/reset-password');
	await page.getByLabel('New password', { exact: true }).fill('a brand new passphrase');
	await page.getByLabel('Repeat new password').fill('a brand new passphrase');
	await page.getByRole('button', { name: 'Set new password' }).click();
	await expect(page.getByRole('status')).toContainText('Your password has been changed');

	await page.getByRole('link', { name: 'Sign in', exact: true }).click();
	await signInThroughForm(page, user.email, user.password);
	await expect(page.getByRole('alert')).toHaveText('wrong email or password');
	await page.getByLabel('Password').fill('a brand new passphrase');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
});

test('a signed-in user can still open a reset link, and a spent link says so', async ({ page, owner }) => {
	const token = await plantEmailToken(owner.email, 'reset');
	await page.goto(`/reset-password?token=${token}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Choose a new password' })).toBeVisible();
	await expect(page).toHaveURL('/reset-password');
	await expect(page.getByText(`You’re signed in as ${owner.email}`)).toBeVisible();

	await page.goto('/reset-password?token=' + 'x'.repeat(43));
	await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
	await page.getByLabel('New password', { exact: true }).fill('another passphrase');
	await page.getByLabel('Repeat new password').fill('another passphrase');
	await page.getByRole('button', { name: 'Set new password' }).click();
	await expect(page.getByRole('alert')).toContainText('This reset link is invalid, already used, or older than 1 hour.');
	await expect(page.getByRole('link', { name: 'Send a new link' })).toBeVisible();
});

test('the confirm-email banner goes once the link is used', async ({ page }) => {
	const user = await register(page.context().request, 'Unconfirmed', { verified: false });
	const banner = page.getByRole('region', { name: 'Email confirmation' });
	await page.goto('/');
	await expect(banner).toContainText(`We sent a link to ${user.email}`);

	const token = await plantEmailToken(user.email, 'verify');
	await page.goto(`/verify-email?token=${token}`);
	await expect(page.getByRole('status')).toContainText(`${user.email} is confirmed`);
	await page.getByRole('link', { name: 'Go to your projects' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	await expect(banner).toHaveCount(0);
});

test('a confirmation link works signed out', async ({ page, playwright }) => {
	const api = await playwright.request.newContext();
	const user = await register(api, 'Other device', { verified: false });
	await api.dispose();
	const token = await plantEmailToken(user.email, 'verify');

	await page.goto(`/verify-email?token=${token}`);
	await expect(page).toHaveURL('/verify-email');
	await expect(page.getByRole('status')).toContainText('your email address is confirmed');
	await page.getByRole('link', { name: 'Sign in', exact: true }).click();
	await signInThroughForm(page, user.email, user.password);
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Email confirmation' })).toHaveCount(0);
});
