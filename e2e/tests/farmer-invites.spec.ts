// Farmer invites (WP-2.2, issue #27): the Project page's "Invite farmers" dialog,
// one farmer by email or many from a CSV (e2e/fixtures/farmers.csv,
// synthetic), and an invited farmer signing up through the link and landing
// on their own farm. e2e mails go to the backend log (MAIL_TRANSPORT=log), so
// the link's token is planted, as sharing.spec.ts does.
import { fileURLToPath } from 'node:url';
import { createProject, PASSWORD, putModel, sampleModel, uniqueEmail } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { plantInviteToken } from '../support/db.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { fillNewPassword } from '../support/signup.ts';

const CSV = fileURLToPath(new URL('../fixtures/farmers.csv', import.meta.url));

test('an owner invites a farmer by email, who signs up through the link and sees exactly that farm', async ({ page, owner, browser }) => {
	void owner;
	const project = await createProject(page.request, 'Invite-a-farmer catchment');
	const model = sampleModel();
	await putModel(page.request, project.id, model);
	const upper = model.nodes.find((n) => n.name === 'Upper farm')!;
	const email = uniqueEmail('farmer-invitee');

	await page.goto(`/projects/${project.id}?tab=project`);
	const panel = page.getByRole('region', { name: /^Farmers/ });
	await expect(panel.getByText('No farmers yet: invite them to see their own farm.')).toBeVisible();
	await panel.getByRole('button', { name: 'Invite farmers' }).click();
	const dialog = page.getByRole('dialog', { name: 'Invite farmers' });
	await expect(dialog.getByLabel('One farmer')).toBeChecked();
	await expectNoViolations(page, { include: 'dialog[open]' });
	await dialog.getByLabel('Email', { exact: true }).fill(email);
	await dialog.getByRole('checkbox', { name: 'Upper farm' }).check();
	await dialog.getByRole('button', { name: 'Invite farmer' }).click();
	await expect(dialog).toBeHidden();
	await expect(panel.getByRole('status')).toHaveText(`Invitation sent to ${email} for Upper farm.`);
	const pending = panel.getByRole('region', { name: /Pending farmer invitations/ });
	await expect(pending.getByRole('listitem')).toHaveCount(1);
	await expect(pending.getByRole('listitem')).toContainText(email);
	await expect(pending.getByRole('listitem')).toContainText('Upper farm · invited by Owner');
	// The Members panel's pending list leaves farmer invites to this panel.
	await expect(page.getByRole('region', { name: 'Members' }).getByText(email)).toHaveCount(0);

	// The farmer signs up through the emailed link.
	const token = await plantInviteToken(email);
	const context = await browser.newContext();
	const v = await context.newPage();
	await v.goto(`/register?invite=${token}`);
	await expect(v.getByText('invited you to the project Invite-a-farmer catchment')).toBeVisible();
	await v.getByLabel('Display name').fill('Invited Farmer');
	await fillNewPassword(v, PASSWORD);
	await v.getByRole('button', { name: 'Create account and join' }).click();
	await expect(v).toHaveURL(new RegExp(`/farm/${project.id}`));
	await expect(v.getByRole('heading', { level: 2, name: 'Your WUA hasn’t published figures yet' })).toBeVisible();
	// Their farm index holds that farm and no other.
	const index = await v.request.get(`${API_URL}/projects/${project.id}/farm`);
	expect((await index.json()).farms).toEqual([{ nodeId: upper.id, name: 'Upper farm' }]);
	await context.close();

	// The owner now sees a farmer, not an invite.
	await page.reload();
	await expect(panel.getByRole('rowheader', { name: /Invited Farmer/ })).toBeVisible();
	await expect(panel.getByRole('row').filter({ hasText: 'Invited Farmer' })).toContainText('Upper farm');
	await expect(pending).toHaveCount(0);
});

test('an owner previews a CSV of farmers, row by row, before sending it', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Bulk-invite catchment');
	await putModel(page.request, project.id, sampleModel());

	await page.goto(`/projects/${project.id}?tab=project`);
	const panel = page.getByRole('region', { name: /^Farmers/ });
	await panel.getByRole('button', { name: 'Invite farmers' }).click();
	const dialog = page.getByRole('dialog', { name: 'Invite farmers' });
	await dialog.getByLabel('Several, from a CSV').check();
	await dialog.getByLabel('…or upload a .csv file').setInputFiles(CSV);
	await expect(dialog.getByLabel('Paste the CSV')).toHaveValue(/^email,farm,language\nfarmer\.one@example\.com/);
	await dialog.getByRole('button', { name: 'Preview' }).click();

	const results = dialog.getByRole('region', { name: /^Preview/ });
	await expect(results.getByRole('heading')).toHaveText('Preview: 3 to invite, 2 with errors');
	const rows = results.getByRole('row');
	await expect(rows).toHaveCount(6); // header + 5
	// Line numbers are the file's (the header is line 1).
	await expect(rows.nth(1)).toHaveText(/^2\s*farmer\.one@example\.com\s*Upper farm\s*Will be invited by email$/);
	await expect(rows.nth(2)).toHaveText(/^3\s*farmer\.two@example\.com\s*lower farm\s*Will be invited by email$/);
	await expect(rows.nth(4)).toHaveText(/^5\s*farmer\.three@example\.com\s*Middle farm\s*Error\s*no farm named “Middle farm” in this catchment$/);
	await expect(rows.nth(5)).toHaveText(/^6\s*not-an-email\s*Upper farm\s*Error\s*not a valid email address$/);
	await expectNoViolations(page, { include: 'dialog[open]' });
	// A preview sends nothing.
	await expect(panel.getByRole('region', { name: /Pending farmer invitations/ })).toHaveCount(0);

	await dialog.getByRole('button', { name: 'Send' }).click();
	await expect(dialog.getByRole('region', { name: /^Done/ }).getByRole('heading')).toHaveText('Done: 3 invited, 2 with errors');
	await dialog.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(panel.getByRole('status')).toHaveText('Farmer invitations: 3 invited, 2 with errors.');
	// One invite per address: farmer.two's two rows are one invite for both farms.
	const pending = panel.getByRole('region', { name: /Pending farmer invitations/ });
	await expect(pending.getByRole('listitem')).toHaveCount(2);
	await expect(pending.getByRole('listitem').filter({ hasText: 'farmer.two@example.com' })).toContainText('Upper farm, Lower farm');
});
