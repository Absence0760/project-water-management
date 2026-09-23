import { addMember, createProject, PASSWORD, putModel, sampleModel, uniqueEmail } from '../support/api.ts';
import { plantInviteToken } from '../support/db.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

test('an owner shares a project read-only with a viewer', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Shared catchment', 'Shared with the consultant');
	await putModel(page.request, project.id, sampleModel());
	const secret = await createProject(page.request, 'Private catchment');
	const viewer = await signIn('Consultant');

	// Owner adds the viewer from the Overview tab's Members panel.
	await page.goto(`/projects/${project.id}`);
	const members = page.getByRole('region', { name: 'Members' });
	await members.getByLabel('Add member by email').fill(viewer.user.email);
	await members.getByLabel('Role', { exact: true }).selectOption('viewer');
	await members.getByRole('button', { name: 'Add' }).click();
	const memberRow = members.getByRole('row').filter({ hasText: viewer.user.email });
	await expect(memberRow).toBeVisible();
	await expect(memberRow.getByLabel('Role for Consultant')).toHaveValue('viewer');

	// The viewer sees it in their list, as a viewer.
	const v = viewer.page;
	await v.goto('/');
	const listRow = v.getByRole('row').filter({ has: v.getByRole('rowheader', { name: 'Shared catchment' }) });
	await expect(listRow).toContainText('viewer');
	await expect(v.getByRole('rowheader', { name: 'Private catchment' })).toHaveCount(0);

	// …and can read but not change anything.
	await listRow.getByRole('link', { name: 'Shared catchment' }).click();
	await expect(v.getByRole('heading', { level: 1, name: 'Shared catchment' })).toBeVisible();
	await expect(v.getByLabel('Name', { exact: true })).not.toBeEditable();
	await expect(v.getByRole('button', { name: 'Save details' })).toHaveCount(0);
	await expect(v.getByLabel('Add member by email')).toHaveCount(0);

	await v.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Network' }).click();
	await expect(v.getByText('You have view-only access to this project.')).toBeVisible();
	const names = v.getByRole('textbox', { name: 'Name' });
	await expect(names).toHaveCount(3);
	await expect(names.first()).toHaveValue('Outflow gauge');
	await expect(names.first()).not.toBeEditable();
	await expect(v.getByLabel('Area of Upper farm, km²', { exact: true })).not.toBeEditable();
	await expect(v.getByLabel('Kind of Upper farm')).toBeDisabled();
	await expect(v.getByRole('button', { name: '+ Add node' })).toHaveCount(0);
	await expect(v.getByRole('button', { name: /^Remove/ })).toHaveCount(0);

	await v.getByRole('link', { name: 'Crops' }).click();
	await expect(v.getByLabel('Orchard crop factor, Oct')).not.toBeEditable();
	await expect(v.getByRole('button', { name: '+ Add crop' })).toHaveCount(0);

	await v.getByRole('link', { name: 'Transfers' }).click();
	await expect(v.getByLabel('Source of transfer 1')).toBeDisabled();

	await v.getByRole('link', { name: 'Settings' }).click();
	await expect(v.getByLabel('A-pan evaporation, Oct, mm')).not.toBeEditable();
	await expect(v.getByRole('button', { name: 'Save settings' })).toHaveCount(0);

	await v.getByRole('link', { name: 'Data', exact: true }).click();
	await expect(v.getByRole('heading', { name: 'Input time series' })).toBeVisible();
	await expect(v.getByRole('heading', { name: 'Upload CSV' })).toHaveCount(0);

	await v.getByRole('link', { name: 'Runs' }).click();
	await expect(v.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible();
	await expect(v.getByRole('button', { name: 'Run model' })).toHaveCount(0);

	// No save bar ever appears for a viewer.
	await expect(v.getByRole('button', { name: 'Save changes' })).toHaveCount(0);

	// A project that was never shared is indistinguishable from one that doesn't exist.
	await v.goto(`/projects/${secret.id}`);
	await expect(v.getByRole('alert')).toContainText("This project doesn't exist or you don't have access to it.");
	await expect(v.getByRole('heading', { level: 1, name: 'Private catchment' })).toHaveCount(0);
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
	await e.goto(`/projects/${project.id}`);
	await expect(e.getByText('Only owners can manage members.')).toBeVisible();
	await expect(e.getByLabel('Add member by email')).toHaveCount(0);
	await expect(e.getByLabel('Name', { exact: true })).toBeEditable();

	await e.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Network' }).click();
	await expect(e.getByLabel('Area of Upper farm, km²', { exact: true })).toBeEditable();
	await expect(e.getByRole('button', { name: '+ Add node' })).toBeVisible();
});

test('an owner invites an address with no account, sees it pending, and revokes it', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Invite catchment');
	const email = uniqueEmail('not-yet-registered');

	await page.goto(`/projects/${project.id}`);
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

	page.once('dialog', (d) => void d.accept());
	await pending.getByRole('button', { name: `Revoke invitation to ${email}` }).click();
	await expect(page.getByText(`Invitation to ${email} revoked.`)).toBeVisible();
	await expect(pending).toHaveCount(0);
	await page.reload();
	await expect(page.getByRole('heading', { level: 1, name: 'Invite catchment' })).toBeVisible();
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
	await v.getByLabel('Password').fill(PASSWORD);
	await v.getByRole('button', { name: 'Create account and join' }).click();

	// Signed up through the link: already a verified editor, no confirm banner.
	await expect(v.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	const row = v.getByRole('row').filter({ has: v.getByRole('rowheader', { name: 'Invited-to catchment' }) });
	await expect(row).toContainText('editor');
	await expect(v.getByRole('region', { name: 'Email confirmation' })).toHaveCount(0);
	await context.close();

	// The owner now sees a member, not an invite.
	await page.goto(`/projects/${project.id}`);
	await expect(page.getByRole('region', { name: 'Members' }).getByRole('rowheader', { name: /Invited Hydrologist/ })).toBeVisible();
	await expect(page.getByRole('region', { name: /Pending invitations/ })).toHaveCount(0);
});

test('a dead invite link falls back to a normal sign-up', async ({ page }) => {
	await page.goto('/register?invite=' + 'y'.repeat(43));
	await expect(page.getByRole('alert')).toContainText('This invitation link is invalid, was revoked, or has expired');
	await expect(page.getByRole('heading', { level: 1, name: 'Create an account' })).toBeVisible();
	await expect(page.getByLabel('Email')).toBeEditable();
});
