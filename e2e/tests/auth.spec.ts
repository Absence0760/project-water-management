import { createProject, LEGAL_VERSION, PASSWORD, register, signInUnconfirmed, uniqueEmail } from '../support/api.ts';
import { plantEmailToken, termsAccepted } from '../support/db.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { agreeToTerms, fillNewPassword } from '../support/signup.ts';
import { answerConfirm } from '../support/confirm.ts';

async function signInThroughForm(page: import('@playwright/test').Page, email: string, password: string) {
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
}

// Sign-up (issue #57, as threkir does it): the password asked twice, a
// confirmation email, on to sign-in, which is refused until the address is
// confirmed, with the link offered again.
test('sign-up asks for the password twice, emails a link and goes to sign-in; the account signs in once confirmed, then out and back in', async ({ page }) => {
	const email = uniqueEmail('new-user');

	await page.goto('/register');
	await page.getByLabel('Display name').fill('New User');
	await page.getByLabel('Email').fill(email);
	// A typo in the second field (a trailing space counts) stops it before any account is made.
	await fillNewPassword(page, PASSWORD, `${PASSWORD} `);
	await agreeToTerms(page);
	await page.getByRole('button', { name: 'Create account' }).click();
	await expect(page.getByRole('alert')).toHaveText('The two passwords don’t match. Type the same password in both.');
	await expect(page.getByLabel('Confirm password')).toBeFocused();
	await expect(page).toHaveURL('/register');
	await expect(page.getByText('We’ll email you a link to confirm your address. You can sign in once it’s confirmed.')).toBeVisible();

	await page.getByLabel('Confirm password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Create account' }).click();
	// On to sign-in: where the link went, and the address filled in.
	await expect(page).toHaveURL('/login?confirm=sent');
	const notice = page.getByRole('status').filter({ hasText: 'Check your email to finish signing up' });
	await expect(notice).toContainText(`We sent a confirmation link to ${email}. Open it to confirm your address, then sign in here.`);
	await expect(notice).toContainText('You can’t sign in until your address is confirmed.');
	await expect(page.getByLabel('Email')).toHaveValue(email);
	await expectNoViolations(page);
	// The ticked "I have read the main points above and accept the Terms of use and Privacy notice": the account records which (087).
	expect(await termsAccepted(email)).toEqual({ version: LEGAL_VERSION, at: expect.any(Date) });

	// Signing in before confirming says so, and offers the link again.
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	const warning = page.getByRole('alert');
	await expect(warning).toContainText(`Your email address isn’t confirmed yet. Open the link we emailed to ${email}, then sign in again.`);
	await expect(page).toHaveURL(/\/login/);
	await warning.getByRole('button', { name: 'Send the link again' }).click();
	await expect(warning).toContainText(`If ${email} still needs confirming, a new link is on its way.`);

	// The link confirms it; now it signs in.
	await page.goto(`/verify-email?token=${await plantEmailToken(email, 'verify')}`);
	await expect(page.getByRole('status')).toContainText('is confirmed');
	await page.goto('/login');
	await signInThroughForm(page, email, PASSWORD);
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	await expect(page).toHaveURL('/');
	await expect(page.getByText('You have no projects yet.')).toBeVisible();
	await expect(page.getByRole('region', { name: 'Email confirmation' })).toHaveCount(0);
	// The account sits at the foot of the app sidebar.
	await expect(page.getByRole('button', { name: 'Account menu for New User' })).toContainText('New User');

	await page.getByRole('button', { name: 'Account menu for New User' }).click();
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	await expect(page).toHaveURL('/login');
	await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

	// The session is really gone: a protected page bounces back to login
	// (`/` itself is the public landing page when signed out, landing.spec.ts).
	await page.goto('/teams');
	await expect(page).toHaveURL(/\/login\?next=/);

	await signInThroughForm(page, email, PASSWORD);
	await expect(page.getByRole('heading', { level: 1, name: 'Teams' })).toBeVisible();
	await expect(page).toHaveURL('/teams');
});

test('"Sign out everywhere" from the account menu also signs out another device', async ({ page, owner, browser }) => {
	// A second "device": its own browser context and cookie jar, signed in
	// through the login form as the same account.
	const otherDevice = await browser.newContext();
	const otherPage = await otherDevice.newPage();
	await otherPage.goto('/login');
	await signInThroughForm(otherPage, owner.email, owner.password);
	await expect(otherPage.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();

	await page.goto('/');
	await page.getByRole('button', { name: /^Account menu for / }).click();
	await page.getByRole('button', { name: 'Sign out everywhere' }).click();
	await answerConfirm(page, true, 'Sign out of every device?');
	await expect(page).toHaveURL('/login');

	// The other device's session is really revoked: its next request is rejected.
	await otherPage.goto('/teams');
	await expect(otherPage).toHaveURL(/\/login\?next=/);

	await otherDevice.close();
});

test('cancelling "Sign out everywhere" leaves the session signed in', async ({ page, owner }) => {
	void owner;
	await page.goto('/');
	await page.getByRole('button', { name: /^Account menu for / }).click();
	await page.getByRole('button', { name: 'Sign out everywhere' }).click();
	await answerConfirm(page, false, 'Sign out of every device?');

	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	await expect(page).toHaveURL('/');
});

test('a wrong password shows an error and stays on the login page', async ({ page, playwright }) => {
	const api = await playwright.request.newContext();
	const user = await register(api, 'Forgetful');
	await api.dispose();

	await page.goto('/login');
	await signInThroughForm(page, user.email, 'not the password');

	await expect(page.getByRole('alert')).toHaveText('Wrong email or password.');
	await expect(page).toHaveURL('/login');
	await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
});

test('signing up with a taken address looks exactly like a new one (no account-existence oracle)', async ({ page, playwright }) => {
	const api = await playwright.request.newContext();
	const user = await register(api, 'Taken');
	await api.dispose();

	await page.goto('/register');
	await page.getByLabel('Display name').fill('Someone else');
	await page.getByLabel('Email').fill(user.email);
	await fillNewPassword(page, 'another passphrase');
	await agreeToTerms(page);
	await page.getByRole('button', { name: 'Create account' }).click();

	// The same page as a fresh sign-up: its owner gets an email instead.
	await expect(page).toHaveURL('/login?confirm=sent');
	await expect(page.getByRole('status').filter({ hasText: 'Check your email to finish signing up' })).toContainText(`We sent a confirmation link to ${user.email}.`);
	await expect(page.getByRole('alert')).toHaveCount(0);
	// The owner's own password still works.
	await signInThroughForm(page, user.email, user.password);
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
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
	await expect(page.getByTestId('project-name').filter({ hasText: 'Deep-linked catchment' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
});

test('a full load of a catchment asks for the project beside /auth/me, not after it', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Parallel first load');
	// The order the browser saw (the API's GETs: the page's own document has the same path, a CORS preflight is an OPTIONS):
	// the project's request goes out before /auth/me has answered (workspace/firstLoad.ts), and the page still renders
	// only once it has.
	const events: string[] = [];
	page.on('request', (r) => {
		if (r.resourceType() === 'fetch' && r.method() === 'GET' && new URL(r.url()).pathname === `/projects/${project.id}`) events.push('project sent');
	});
	page.on('response', (r) => {
		if (r.request().method() === 'GET' && new URL(r.url()).pathname === '/auth/me') events.push('me answered');
	});
	await page.goto(`/projects/${project.id}`);
	await expect(page.getByTestId('project-name').filter({ hasText: 'Parallel first load' })).toBeVisible();
	expect(events.slice(0, 2)).toEqual(['project sent', 'me answered']);
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
	await expect(page.getByRole('alert')).toHaveText('Wrong email or password.');
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
	await signInUnconfirmed(page.context(), user);
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

// WCAG 2.4.3 (issue #51): Dismiss takes the banner, and itself, away; focus
// goes on to the page below instead of falling back to <body>.
test('dismissing the confirm-email banner moves focus to the page’s title', async ({ page }) => {
	const user = await register(page.context().request, 'Dismisses banner', { verified: false });
	await signInUnconfirmed(page.context(), user);
	const banner = page.getByRole('region', { name: 'Email confirmation' });
	await page.goto('/');
	const title = page.getByRole('heading', { level: 1, name: 'Projects' });
	await expect(title).toBeVisible();
	await banner.getByRole('button', { name: 'Dismiss' }).focus();
	await page.keyboard.press('Enter');
	await expect(banner).toHaveCount(0);
	await expect(title).toBeFocused();
});

// Signed out, an unconfirmed account can't sign in to reach the banner's
// Resend email: the dead-link page sends a new link itself.
test('a dead confirmation link, signed out, asks for the address and sends a new link from the page', async ({ page }) => {
	const email = uniqueEmail('dead-link');
	await page.goto(`/verify-email?token=${'x'.repeat(43)}`);
	await expect(page.getByRole('alert')).toHaveText('This confirmation link is invalid, already used, or older than 48 hours.');
	await page.getByLabel('Email').fill(` ${email} `);
	const sent = page.waitForResponse((r) => r.url().endsWith('/auth/resend-confirmation'));
	await page.getByRole('button', { name: 'Send a new link' }).click();
	const res = await sent;
	expect(res.status()).toBe(202);
	expect(res.request().postDataJSON()).toEqual({ email });
	await expect(page.getByRole('status')).toHaveText(`If ${email} still needs confirming, a new link is on its way. Check your inbox and spam folder.`);
	await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
});

// The page stays open to any session: a link for another address confirms
// that address, and the page says so instead of naming the signed-in one.
test('signed in, a confirmation link for another address doesn’t say the signed-in account is confirmed', async ({ page, playwright }) => {
	const me = await register(page.context().request, 'Signed in here');
	const api = await playwright.request.newContext();
	const other = await register(api, 'Colleague', { verified: false });
	await api.dispose();

	await page.goto(`/verify-email?token=${await plantEmailToken(other.email, 'verify')}`);
	// Not "Thanks — <me> is confirmed": the signed-in account isn't the one the link confirmed.
	await expect(page.getByRole('status')).toHaveText('Thanks — your email address is confirmed. Sign in to see any projects or teams you were invited to.');
	await expect(page.getByRole('status')).not.toContainText(me.email);
	// The dead link signed in as a confirmed account: no "Send a new link" for an address that needs none.
	await page.goto(`/verify-email?token=${'x'.repeat(43)}`);
	await expect(page.getByRole('alert')).toHaveText('This confirmation link is invalid, already used, or older than 48 hours.');
	await expect(page.getByRole('button', { name: 'Send a new link' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Back to your projects' })).toBeVisible();
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
