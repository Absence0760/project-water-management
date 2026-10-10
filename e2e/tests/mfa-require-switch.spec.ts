// The "Require two-step sign-in" switches, end to end against a server with
// the requirement on (204_mfa_opt_in; operator decision, 2026-10-08;
// docs/security.md § Two-step sign-in → Who must use it). The browser's API
// calls go to the second e2e API (MFA_API_URL, as production), as in
// mfa-required.spec.ts, which covers turning a project's switch on without a
// factor of your own.
//
// Project: an owner with a factor turns the switch on; a co-owner who signs in
// with a password only is refused an owner action (deleting the project: the
// banner, and the project stays), and, once signed in with a code, does it
// (positive control). Team: an admin turns the team's switch on; a co-admin on a
// password is refused an admin action (renaming the team), and passes with a code.
import type { APIRequestContext } from '@playwright/test';
import { base32Decode, hotp, totpStep } from '../../backend/src/auth/totp.ts';
import { acceptInvites, addMember, createProject, PASSWORD } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { API_URL, MFA_API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { viaMfaApi } from '../support/mfaApi.ts';
import { openProject } from '../support/project.ts';
import { openRowMenu, row } from '../support/projects.ts';
import { openTeamSettings } from '../support/teams.ts';

/** An authenticator for the context's account, through the API: the session it shares is reissued as signed in with a code. */
async function appOn(request: APIRequestContext): Promise<void> {
	const enrol = await request.post(`${MFA_API_URL}/auth/mfa/totp/enrol`, { data: { password: PASSWORD } });
	expect(enrol.status(), await enrol.text()).toBe(200);
	const { secret } = (await enrol.json()) as { secret: string };
	const r = await request.post(`${MFA_API_URL}/auth/mfa/totp/confirm`, { data: { code: hotp(base32Decode(secret)!, totpStep(Date.now())) } });
	expect(r.status(), await r.text()).toBe(200);
}

test('a project that requires it: the owner turns it on, a password-only co-owner is refused deleting it, and with a code deletes it', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Required switch farm');
	const coOwner = await signIn('Password co-owner');
	await addMember(page.request, project.id, coOwner.user.email, 'owner');
	await acceptInvites(coOwner.user.email, project.id);

	// The owner, signed in with a code, turns the switch on.
	await appOn(page.request);
	await viaMfaApi(page);
	await openProject(page, project.id);
	const panel = page.getByRole('region', { name: 'Two-step sign-in' }).filter({ has: page.locator('[data-require-two-step]') });
	const toggle = panel.getByRole('switch', { name: 'Require two-step sign-in' });
	await expect(toggle).not.toBeChecked();
	await toggle.click();
	await expect(panel.getByRole('status')).toHaveText('Saved. Two-step sign-in is now required.');
	await expect(toggle).toBeChecked();

	// The co-owner, on a password, is refused an owner action: the banner, and the project stays.
	const them = coOwner.page;
	await viaMfaApi(them);
	await them.goto('/');
	await openRowMenu(them, 'Required switch farm');
	await row(them, 'Required switch farm').getByRole('button', { name: 'Delete Required switch farm' }).click();
	await answerConfirm(them, true, 'Delete project “Required switch farm”?');
	const banner = them.getByRole('region', { name: 'Two-step sign-in' });
	await expect(banner).toHaveAttribute('data-mfa-prompt', 'setup');
	expect((await page.request.get(`${API_URL}/projects/${project.id}`)).status()).toBe(200);

	// Positive control: the same co-owner, signed in with a code, deletes it.
	await appOn(coOwner.context.request);
	await them.goto('/');
	await openRowMenu(them, 'Required switch farm');
	await row(them, 'Required switch farm').getByRole('button', { name: 'Delete Required switch farm' }).click();
	await answerConfirm(them, true, 'Delete project “Required switch farm”?');
	await expect(row(them, 'Required switch farm')).toHaveCount(0);
	expect((await page.request.get(`${API_URL}/projects/${project.id}`)).status()).toBe(404);
});

test('a team that requires it: the admin turns it on, a password-only co-admin is refused renaming it, and passes with a code', async ({ page, owner, signIn }) => {
	void owner;
	const { team } = (await (await page.request.post(`${API_URL}/teams`, { data: { name: 'Required switch WUA' } })).json()) as { team: { id: string } };
	const coAdmin = await signIn('Password co-admin');
	expect((await page.request.post(`${API_URL}/teams/${team.id}/members`, { data: { email: coAdmin.user.email, role: 'admin' } })).status()).toBe(201);
	await acceptInvites(coAdmin.user.email, team.id);

	await appOn(page.request);
	await viaMfaApi(page);
	await page.goto(`/teams/${team.id}`);
	const part = (await openTeamSettings(page)).getByRole('region', { name: 'Two-step sign-in' });
	const toggle = part.getByRole('switch', { name: 'Require two-step sign-in' });
	await toggle.click();
	await expect(part.getByRole('status')).toHaveText('Saved. Two-step sign-in is now required.');
	expect((await (await page.request.get(`${API_URL}/teams/${team.id}`)).json()).team.requireMfa).toBe(true);

	// The co-admin on a password: an admin action is refused by the server with the requirement on.
	const rename = (name: string) => coAdmin.context.request.patch(`${MFA_API_URL}/teams/${team.id}`, { data: { name } });
	const refused = await rename('Renamed on a password');
	expect(refused.status()).toBe(403);
	expect(((await refused.json()) as { code: string }).code).toBe('mfa_required');
	expect((await (await page.request.get(`${API_URL}/teams/${team.id}`)).json()).team.name).toBe('Required switch WUA');

	// Positive control: with a code, the same action goes through.
	await appOn(coAdmin.context.request);
	expect((await rename('Renamed with a code')).status()).toBe(200);
	expect((await (await page.request.get(`${API_URL}/teams/${team.id}`)).json()).team.name).toBe('Renamed with a code');
});
