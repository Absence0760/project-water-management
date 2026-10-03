import type { Page } from '@playwright/test';
import { addMember, createProject, LEGAL_VERSION, PASSWORD, putModel, register, sampleModel, signInUnconfirmed, uniqueEmail } from '../support/api.ts';
import { plantEmailToken, plantInviteToken, userIdByEmail } from '../support/db.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { openCropSheet } from '../support/crops.ts';
import { closeModal, openNodeTable } from '../support/network.ts';
import { agreeToTerms, fillNewPassword } from '../support/signup.ts';
import { answerConfirm } from '../support/confirm.ts';

const PHONE = { width: 360, height: 740 };

test('an owner shares a project read-only with a viewer, who joins by accepting the invitation', async ({ page, owner, signIn }) => {
	const project = await createProject(page.request, 'Shared catchment', 'Shared with the consultant');
	await putModel(page.request, project.id, sampleModel());
	const secret = await createProject(page.request, 'Private catchment');
	const viewer = await signIn('Consultant');

	// Owner invites the viewer from the Project page's Members panel. The address has an account, but
	// adding it is only an invitation (issue #136): the owner sees a pending invite, not the account.
	await page.goto(`/projects/${project.id}?tab=project`);
	const members = page.getByRole('region', { name: 'Members' });
	await members.getByLabel('Add member by email').fill(viewer.user.email);
	await members.getByLabel('Role', { exact: true }).selectOption('viewer');
	await members.getByRole('button', { name: 'Add' }).click();
	await expect(members.getByRole('status').filter({ hasText: 'Invitation sent' })).toHaveText(`Invitation sent to ${viewer.user.email}. They’ll join as viewer once they accept it.`);
	await expect(members.getByRole('row').filter({ hasText: viewer.user.email })).toHaveCount(0);
	await expect(members.getByText('Consultant', { exact: true })).toHaveCount(0);
	await expect(page.getByRole('region', { name: /^Pending invitations/ }).getByText(viewer.user.email)).toBeVisible();

	// The viewer hasn't joined yet: the banner offers the invitation, and they accept it.
	const v = viewer.page;
	await v.goto('/');
	await expect(v.getByRole('rowheader', { name: 'Shared catchment' })).toHaveCount(0);
	const banner = v.getByRole('region', { name: 'Invitations' });
	await expect(banner).toContainText('You have 1 invitation waiting.');
	await banner.getByRole('link', { name: 'See invitations' }).click();
	await expect(v).toHaveURL(/\/account\/invitations$/);
	const card = v.getByRole('listitem').filter({ has: v.getByRole('heading', { name: 'Shared catchment' }) });
	await expect(card).toContainText(`${owner.displayName} invited you to this catchment as a viewer.`);
	await card.getByRole('button', { name: 'Accept' }).click();
	await expect(v.getByRole('status').filter({ hasText: 'You joined' })).toHaveText('You joined Shared catchment. Open it');
	await expect(v.getByText('You have no invitations waiting.')).toBeVisible();
	await expect(banner).toHaveCount(0);

	// Now a member, as the viewer the owner chose.
	await page.reload();
	const memberRow = members.getByRole('row').filter({ hasText: viewer.user.email });
	await expect(memberRow.getByLabel('Role for Consultant')).toHaveValue('viewer');

	// The viewer sees it in their list, as a viewer.
	await v.goto('/');
	const listRow = v.getByRole('row').filter({ has: v.getByRole('rowheader', { name: 'Shared catchment' }) });
	await expect(listRow).toContainText('viewer');
	await expect(v.getByRole('rowheader', { name: 'Private catchment' })).toHaveCount(0);

	// …and can read but not change anything.
	await listRow.getByRole('link', { name: 'Shared catchment' }).click();
	await expect(v.getByTestId('project-name').filter({ hasText: 'Shared catchment' })).toBeVisible();
	await v.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Project', exact: true }).click();
	await expect(v.getByLabel('Name', { exact: true })).not.toBeEditable();
	await expect(v.getByTestId('details-save-hint')).toHaveCount(0);
	await expect(v.getByLabel('Add member by email')).toHaveCount(0);

	// The model inputs sit behind a toggle for a viewer (tabs-by-role.spec.ts).
	await v.getByLabel('Show model inputs').check();
	await v.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Network' }).click();
	await openNodeTable(v);
	await expect(v.getByText('You have view-only access to this project.')).toBeVisible();
	const names = v.getByRole('textbox', { name: 'Name' });
	await expect(names).toHaveCount(3);
	await expect(names.first()).toHaveValue('Outflow gauge');
	await expect(names.first()).not.toBeEditable();
	await expect(v.getByLabel('Area of Upper farm, km²', { exact: true })).not.toBeEditable();
	await expect(v.getByLabel('Kind of Upper farm')).toBeDisabled();
	await expect(v.getByRole('button', { name: '+ Add node' })).toHaveCount(0);
	await expect(v.getByRole('button', { name: /^Remove/ })).toHaveCount(0);
	await closeModal(v);

	await v.getByRole('link', { name: 'Crops' }).click();
	await expect(v.getByRole('button', { name: '+ Add crop' })).toHaveCount(0);
	// A crop card's View opens its factors read-only.
	const sheet = await openCropSheet(v, 'Orchard');
	await expect(sheet.getByLabel('Orchard crop factor, Oct')).not.toBeEditable();
	await expect(sheet.getByRole('button', { name: 'Remove Orchard' })).toHaveCount(0);
	await closeModal(v);

	await v.getByRole('link', { name: 'Transfers' }).click();
	await expect(v.getByLabel('From, transfer 1', { exact: true })).toBeDisabled();

	await v.getByRole('link', { name: 'Settings' }).click();
	await expect(v.getByLabel('A-pan evaporation, Oct, mm')).not.toBeEditable();
	// No save bar for a viewer, whatever they type into.
	await expect(v.getByRole('region', { name: /^Unsaved / })).toHaveCount(0);
	await expect(v.getByRole('button', { name: 'Save changes' })).toHaveCount(0);

	await v.getByRole('link', { name: 'Data', exact: true }).click();
	await expect(v.getByRole('heading', { name: 'Input time series' })).toBeVisible();
	await expect(v.getByRole('button', { name: 'Add data' })).toHaveCount(0);

	await v.getByRole('link', { name: 'Runs & results' }).click();
	await expect(v.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible();
	await expect(v.getByRole('button', { name: 'Run model' })).toHaveCount(0);

	// No save bar ever appears for a viewer.
	await expect(v.getByRole('button', { name: 'Save changes' })).toHaveCount(0);

	// A project that was never shared is indistinguishable from one that doesn't exist.
	await v.goto(`/projects/${secret.id}`);
	await expect(v.getByRole('alert')).toContainText("This project doesn't exist or you don't have access to it.");
	// It keeps the page frame: one title, the section header's.
	await expect(v.getByRole('heading', { level: 1 })).toHaveText(['Project not found']);
	await expect(v.getByTestId('project-name').filter({ hasText: 'Private catchment' })).toHaveCount(0);
	await v.getByRole('alert').getByRole('link', { name: 'Back to projects' }).click();
	await expect(v.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
});

test('an editor can change the shared model but cannot manage members', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Team catchment');
	await putModel(page.request, project.id, sampleModel());
	const editor = await signIn('Engineer');
	await addMember(page.request, project.id, editor.user.email, 'editor');

	const e = editor.page;
	await e.goto(`/projects/${project.id}?tab=project`);
	await expect(e.getByText('Only owners can manage members.')).toBeVisible();
	await expect(e.getByLabel('Add member by email')).toHaveCount(0);
	await expect(e.getByLabel('Name', { exact: true })).toBeEditable();

	await e.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Network' }).click();
	const grid = await openNodeTable(e);
	await expect(grid.getByLabel('Area of Upper farm, km²', { exact: true })).toBeEditable();
	await expect(grid.getByRole('button', { name: '+ Add node' })).toBeVisible();
});

test('an owner invites an address with no account, sees it pending, and revokes it', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Invite catchment');
	const email = uniqueEmail('not-yet-registered');

	await page.goto(`/projects/${project.id}?tab=project`);
	const members = page.getByRole('region', { name: 'Members' });
	await members.getByLabel('Add member by email').fill(email);
	await members.getByLabel('Role', { exact: true }).selectOption('editor');
	await members.getByRole('button', { name: 'Add' }).click();
	await expect(members.getByText(`Invitation sent to ${email}.`)).toBeVisible();

	const pending = page.getByRole('region', { name: /Pending invitations/ });
	const item = pending.getByRole('listitem').filter({ hasText: email });
	await expect(item).toContainText('editor');
	await expect(item).toContainText(/invited by Owner \d+ · expires in 7 days/);
	// Not a member yet.
	await expect(members.getByRole('rowheader').filter({ hasText: email })).toHaveCount(0);

	// Still pending after a reload (it's the server's list, not local state).
	await page.reload();
	await expect(pending.getByRole('listitem').filter({ hasText: email })).toBeVisible();

	// Re-sending inside a minute keeps the link that's already in their inbox.
	await pending.getByRole('button', { name: `Resend invitation to ${email}` }).click();
	await expect(page.getByText(`An invitation went to ${email} less than a minute ago`)).toBeVisible();

	await pending.getByRole('button', { name: `Revoke invitation to ${email}` }).click();
	await answerConfirm(page, true, 'Revoke this invitation?');
	await expect(page.getByText(`Invitation to ${email} revoked.`)).toBeVisible();
	await expect(pending).toHaveCount(0);
	await page.reload();
	await expect(page.getByTestId('project-name').filter({ hasText: 'Invite catchment' })).toBeVisible();
	await expect(page.getByRole('region', { name: /Pending invitations/ })).toHaveCount(0);
});

test('an account that declines an invitation never joins, and the owner never sees who it was (issue #136)', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Declined catchment');
	const stranger = await signIn('Declining stranger');
	expect((await page.request.post(`${API_URL}/projects/${project.id}/members`, { data: { email: stranger.user.email, role: 'editor' } })).status()).toBe(201);

	const s = stranger.page;
	await s.setViewportSize(PHONE);
	await s.goto('/account/invitations');
	const card = s.getByRole('listitem').filter({ has: s.getByRole('heading', { name: 'Declined catchment' }) });
	await expect(card).toContainText('invited you to this catchment as an editor.');
	await expectNoViolations(s);
	await card.getByRole('button', { name: 'Decline' }).click();
	await expect(s.getByRole('status').filter({ hasText: 'You declined' })).toHaveText('You declined the invitation to Declined catchment.');
	await expect(s.getByText('You have no invitations waiting.')).toBeVisible();
	// Not a member: the project isn't theirs to open.
	expect((await s.request.get(`${API_URL}/projects/${project.id}`)).status()).toBe(404);

	// The owner's pending invite is gone; the members list never showed the account.
	await page.goto(`/projects/${project.id}?tab=project`);
	await expect(page.getByTestId('project-name').filter({ hasText: 'Declined catchment' })).toBeVisible();
	await expect(page.getByRole('region', { name: /^Pending invitations/ })).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Members' }).getByText('Declining stranger', { exact: true })).toHaveCount(0);
});

test('adding an account that never confirmed its email invites it until the address is confirmed', async ({ page, owner, playwright }) => {
	void owner;
	const project = await createProject(page.request, 'Unconfirmed catchment');
	const api = await playwright.request.newContext();
	const unconfirmed = await register(api, 'Unconfirmed colleague', { verified: false });

	await page.goto(`/projects/${project.id}?tab=project`);
	const members = page.getByRole('region', { name: 'Members' });
	await members.getByLabel('Add member by email').fill(unconfirmed.email);
	await members.getByLabel('Role', { exact: true }).selectOption('editor');
	await members.getByRole('button', { name: 'Add' }).click();
	await expect(members.getByText(`Invitation sent to ${unconfirmed.email}.`)).toBeVisible();
	await expect(members.getByRole('rowheader').filter({ hasText: unconfirmed.email })).toHaveCount(0);
	const pending = page.getByRole('region', { name: /Pending invitations/ });
	await expect(pending.getByRole('listitem').filter({ hasText: unconfirmed.email })).toContainText('editor');

	// Confirming the address (the emailed link) turns the invite into a membership.
	const token = await plantEmailToken(unconfirmed.email, 'verify');
	expect((await api.post(`${API_URL}/auth/verify-email`, { data: { token } })).status()).toBe(200);
	await api.dispose();
	await page.reload();
	await expect(members.getByRole('rowheader').filter({ hasText: 'Unconfirmed colleague' })).toBeVisible();
	await expect(page.getByRole('region', { name: /Pending invitations/ })).toHaveCount(0);
});

test('an invited person signs up through the link and lands in the project', async ({ page, owner, browser }) => {
	void owner;
	const project = await createProject(page.request, 'Invited-to catchment');
	const email = uniqueEmail('invitee');
	const res = await page.request.post(`${API_URL}/projects/${project.id}/members`, {
		data: { email, role: 'editor' }
	});
	expect(res.status()).toBe(201);
	expect((await res.json()).invited).toBe(true);
	const token = await plantInviteToken(email);

	const context = await browser.newContext();
	const v = await context.newPage();
	await v.goto(`/register?invite=${token}`);
	await expect(v.getByText('invited you to the project Invited-to catchment')).toBeVisible();
	await expect(v.getByLabel('Email')).toHaveValue(email);
	await expect(v.getByLabel('Email')).not.toBeEditable();
	await v.getByLabel('Display name').fill('Invited Hydrologist');
	await fillNewPassword(v, PASSWORD);
	await agreeToTerms(v);
	await v.getByRole('button', { name: 'Create account and join' }).click();

	// Signed up through the link: already a verified editor, no confirm banner.
	await expect(v.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	const row = v.getByRole('row').filter({ has: v.getByRole('rowheader', { name: 'Invited-to catchment' }) });
	await expect(row).toContainText('editor');
	await expect(v.getByRole('region', { name: 'Email confirmation' })).toHaveCount(0);
	await context.close();

	// The owner now sees a member, not an invite.
	await page.goto(`/projects/${project.id}?tab=project`);
	await expect(page.getByRole('region', { name: 'Members' }).getByRole('rowheader', { name: /Invited Hydrologist/ })).toBeVisible();
	await expect(page.getByRole('region', { name: /Pending invitations/ })).toHaveCount(0);
});

test('a dead invite link falls back to a normal sign-up', async ({ page }) => {
	await page.goto('/register?invite=' + 'y'.repeat(43));
	await expect(page.getByRole('alert')).toContainText('This invitation link has expired or was withdrawn');
	await expect(page.getByRole('heading', { level: 1, name: 'Create an account' })).toBeVisible();
	await expect(page.getByLabel('Email')).toBeEditable();
});

/** Invites `email` (no account yet) to a new project of `page`'s user; returns the link token. */
async function inviteToProject(page: Page, projectName: string, email: string): Promise<string> {
	const project = await createProject(page.request, projectName);
	const res = await page.request.post(`${API_URL}/projects/${project.id}/members`, { data: { email, role: 'viewer' } });
	expect(res.status()).toBe(201);
	return plantInviteToken(email);
}

test('someone signed in as another account opens an invitation: told whose it is, can sign out and accept', async ({ page, owner, signIn }) => {
	void owner;
	const email = uniqueEmail('forwarded');
	const token = await inviteToProject(page, 'Forwarded catchment', email);

	const other = await signIn('Colleague on a shared laptop');
	await other.page.goto(`/register?invite=${token}`);
	// Not sent home: the page explains the mismatch.
	await expect(other.page.getByRole('heading', { level: 1, name: 'You’re already signed in' })).toBeVisible();
	await expect(other.page).toHaveURL(/\/register\?invite=/);
	await expect(other.page.getByText(`Signed in as ${other.user.email}.`)).toBeVisible();
	await expect(other.page.getByRole('alert')).toHaveText(
		`This invitation to the project Forwarded catchment is for ${email}, not the account you’re signed in with.`
	);
	await expect(other.page.getByRole('link', { name: 'Stay signed in and go to your projects' })).toHaveAttribute('href', '/');

	await other.page.getByRole('button', { name: `Sign out and accept as ${email}` }).click();
	await expect(other.page.getByRole('heading', { level: 1, name: 'Accept your invitation' })).toBeVisible();
	await expect(other.page.getByLabel('Email')).toHaveValue(email);
	await other.page.getByLabel('Display name').fill('Forwarded Invitee');
	await fillNewPassword(other.page, PASSWORD);
	await agreeToTerms(other.page);
	await other.page.getByRole('button', { name: 'Create account and join' }).click();
	await expect(other.page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	await expect(other.page.getByRole('rowheader', { name: 'Forwarded catchment' })).toBeVisible();
});

test('the invitee, signed up without the link, is told to confirm their email to join', async ({ page, owner, browser }) => {
	void owner;
	const email = uniqueEmail('early-signup');
	const token = await inviteToProject(page, 'Confirm-first catchment', email);

	// Signs up directly (not through the link), so the invite waits for a confirmed address.
	const context = await browser.newContext();
	const v = await context.newPage();
	const res = await v.request.post(`${API_URL}/auth/register`, { data: { email, password: PASSWORD, displayName: 'Early Bird', acceptTerms: LEGAL_VERSION } });
	expect(res.status()).toBe(202);
	// Signed in before confirming: a session from before confirmation was required (issue #57).
	await signInUnconfirmed(context, { id: await userIdByEmail(email), email, displayName: 'Early Bird', password: PASSWORD });

	await v.goto(`/register?invite=${token}`);
	await expect(v.getByRole('heading', { level: 1, name: 'You’re already signed in' })).toBeVisible();
	await expect(v.getByRole('status').filter({ hasText: 'invited this address' })).toContainText(
		'invited this address to the project Confirm-first catchment.'
	);
	await expect(v.getByText(`You’ll join as soon as you confirm your email address: use the link we sent to ${email}.`)).toBeVisible();
	// Sign-up mailed a link seconds ago, so the server holds a resend back (429) and says why.
	await v.getByRole('button', { name: 'Resend confirmation email' }).click();
	await expect(v.getByRole('status').filter({ hasText: 'sent a moment ago' })).toBeVisible();
	await context.close();
});

test('a signed-in user opening a dead invitation link is told so, not sent home', async ({ page, owner }) => {
	void owner;
	await page.goto('/register?invite=' + 'z'.repeat(43));
	await expect(page.getByRole('heading', { level: 1, name: 'You’re already signed in' })).toBeVisible();
	await expect(page.getByRole('alert')).toContainText('This invitation link is invalid, was revoked, or has expired');
	await page.getByRole('link', { name: 'Go to your projects' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
});

test('a signed-in user opening plain /register is still sent on to the app', async ({ page, owner }) => {
	void owner;
	await page.goto('/register');
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	await expect(page).toHaveURL(/\/$/);
});
