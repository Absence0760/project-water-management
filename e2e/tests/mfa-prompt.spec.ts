// The app-wide two-step sign-in prompt (issue #282; docs/ui.md § Invitations,
// the two-step sign-in banner; frontend lib/auth/mfaPrompt.svelte.ts): only a
// refused action prompts (2026-10-03), never the role alone: 403
// mfa_required links to set it up, 403 mfa_step_up offers "Sign in again".
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

/** Answers this project's DELETE with a 403 carrying `code`, as production would for a session without the second factor. */
async function refuseDelete(page: Page, projectId: string, origin: string, code: 'mfa_required' | 'mfa_step_up') {
	await page.route(`${API_URL}/projects/${projectId}`, (route: Route) => {
		if (route.request().method() !== 'DELETE') return route.fallback();
		return route.fulfill({
			status: 403,
			contentType: 'application/json',
			headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
			body: JSON.stringify({ error: 'this needs two-step sign-in', code })
		});
	});
}

test('an owner without an authenticator is not prompted for the role alone; a refused action prompts, and leads to the Account page’s panel', async ({ page, owner, baseURL }) => {
	const project = await createProject(page.request, 'Banner farm');
	// Production's answer for an owner: required, not enrolled. No banner, no badge (the operator's decision, 2026-10-03).
	await mfaStatusAs(page, { required: true });
	await refuseDelete(page, project.id, new URL(baseURL!).origin, 'mfa_required');
	await page.goto('/');
	await expect(row(page, 'Banner farm')).toBeVisible();
	await expect(page.locator('[data-mfa-prompt]')).toHaveCount(0);
	await expect(page.locator('[data-mfa-badge]')).toHaveCount(0);

	// The protected action is refused: now the banner and the badge.
	await openRowMenu(page, 'Banner farm');
	await row(page, 'Banner farm').getByRole('button', { name: 'Delete Banner farm' }).click();
	await answerConfirm(page, true, 'Delete project “Banner farm”?');
	const banner = page.getByRole('region', { name: 'Two-step sign-in' });
	await expect(banner).toHaveAttribute('data-mfa-prompt', 'setup');
	await expect(banner).toContainText('That needs two-step sign-in, and you haven’t set it up yet.');
	const menu = page.getByRole('button', { name: `Account menu for ${owner.displayName}, two-step sign-in needed` });
	await expect(menu).toHaveAttribute('data-mfa-badge', 'setup');
	await expectNoViolations(page);

	// Dismiss hides the banner; the badge stays while the need stands.
	await banner.getByRole('button', { name: 'Dismiss' }).click();
	await expect(banner).toHaveCount(0);
	await expect(menu).toHaveAttribute('data-mfa-badge', 'setup');

	await menu.click();
	await page.getByRole('link', { name: 'Set up two-step sign-in' }).click();
	await expect(page).toHaveURL('/account#two-step');
	const panel = page.locator('#two-step');
	await expect(panel).toHaveAttribute('data-two-step', 'off');
	await expect(panel.getByRole('button', { name: 'Set up two-step sign-in' })).toBeVisible();
	// The Account page is translated and says it in its own panel: no English banner over it.
	await expect(page.locator('[data-mfa-prompt]')).toHaveCount(0);
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
