import { createProject, PASSWORD, register, uniqueEmail } from '../support/api.ts';
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
