// The app-wide two-step sign-in prompt (issue #282; docs/ui.md § Invitations,
// the two-step sign-in banner; frontend lib/auth/mfaPrompt.svelte.ts): a project owner
// without an authenticator is told on the workspace, with a link to set it
// up, and a request refused with 403 mfa_step_up offers "Sign in again".
//
// The requirement is off on the e2e server (MFA_REQUIRED=false,
// playwright.config.ts: hundreds of owner fixtures sign in with a password),
// so GET /auth/mfa answers `required: false` here. page.route plays the
// production answer: the real response with `required` (and, for the
// step-up, `enrolled`) set as an owner's would be, and a refused delete. The
// backend's side is tested in backend/src/auth/stepUp.db.test.ts.
import type { Page, Route } from '@playwright/test';
import { createProject, PASSWORD } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { answerConfirm } from '../support/confirm.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { openRowMenu, row } from '../support/projects.ts';

/** GET /auth/mfa as production would answer it for this owner, with `patch` laid over the real answer. */
async function mfaStatusAs(page: Page, patch: Record<string, boolean>) {
	await page.route(`${API_URL}/auth/mfa`, async (route: Route) => {
		if (route.request().method() !== 'GET') return route.fallback();
		const response = await route.fetch();
		await route.fulfill({ response, json: { ...(await response.json()), ...patch } });
	});
}

test('an owner without an authenticator sees the banner on the workspace, and it leads to the Account page’s panel', async ({ page, owner }) => {
	void owner;
	await createProject(page.request, 'Banner farm');
	await mfaStatusAs(page, { required: true });
	await page.goto('/');
	const banner = page.getByRole('region', { name: 'Two-step sign-in' });
	await expect(banner).toHaveAttribute('data-mfa-prompt', 'setup');
	await expect(banner).toContainText('As a project owner, team admin or assessor, you need two-step sign-in');
	await expect(row(page, 'Banner farm')).toBeVisible();
	await expectNoViolations(page);

	await banner.getByRole('link', { name: 'Set up two-step sign-in' }).click();
	await expect(page).toHaveURL('/account#two-step');
	const panel = page.locator('#two-step');
	await expect(panel).toHaveAttribute('data-two-step', 'off');
	await expect(panel.getByRole('button', { name: 'Set up two-step sign-in' })).toBeVisible();
	// The Account page is translated and says it in its own panel: no English banner over it.
	await expect(page.locator('[data-mfa-prompt]')).toHaveCount(0);
});

test('Dismiss hides the banner; a role that doesn’t need it never sees one', async ({ page, owner }) => {
	void owner;
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	await expect(page.locator('[data-mfa-prompt]')).toHaveCount(0);

	await mfaStatusAs(page, { required: true });
	await page.reload();
	const banner = page.getByRole('region', { name: 'Two-step sign-in' });
	await expect(banner).toBeVisible();
	await banner.getByRole('button', { name: 'Dismiss' }).click();
	await expect(banner).toHaveCount(0);
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeFocused();
});

test('a delete refused with 403 mfa_step_up offers “Sign in again”, which signs out and comes back after', async ({ page, owner, baseURL }) => {
	const project = await createProject(page.request, 'Step-up farm');
	await page.route(`${API_URL}/projects/${project.id}`, (route: Route) => {
		if (route.request().method() !== 'DELETE') return route.fallback();
		return route.fulfill({
			status: 403,
			contentType: 'application/json',
			headers: { 'access-control-allow-origin': new URL(baseURL!).origin, 'access-control-allow-credentials': 'true' },
			body: JSON.stringify({
				error: 'this needs two-step sign-in: sign out and sign in again with a code from your authenticator app',
				code: 'mfa_step_up'
			})
		});
	});
	await page.goto('/');
	await expect(row(page, 'Step-up farm')).toBeVisible();
	await expect(page.locator('[data-mfa-prompt]')).toHaveCount(0);

	await openRowMenu(page, 'Step-up farm');
	await row(page, 'Step-up farm').getByRole('button', { name: 'Delete Step-up farm' }).click();
	await answerConfirm(page, true, 'Delete project “Step-up farm”?');
	const banner = page.getByRole('region', { name: 'Two-step sign-in' });
	await expect(banner).toHaveAttribute('data-mfa-prompt', 'step-up');
	await expect(banner).toContainText('That needs a sign-in with a code from your authenticator app');
	await expectNoViolations(page);

	await banner.getByRole('button', { name: 'Sign in again' }).click();
	await expect(page).toHaveURL('/login?next=%2F');
	await page.getByLabel('Email').fill(owner.email);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
	await expect(row(page, 'Step-up farm')).toBeVisible();
	// A new session, a new start: the refusal was the old session's.
	await expect(page.locator('[data-mfa-prompt]')).toHaveCount(0);
});
