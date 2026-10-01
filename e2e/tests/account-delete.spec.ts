// "Delete my account" on the account page (issue #112; DELETE /auth/me,
// frontend components/account/DeleteAccount.svelte, docs/ui.md § Account):
// the card opens a dialog that says what goes and what stays, then asks for
// the password again. The only owner of a project or only admin of a team is
// refused, with links to what to hand over; once it is handed over the
// account is deleted, this browser is signed out, the sign-in page says so,
// and the password no longer signs in.
import { acceptInvites, addMember, createProject, register } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const PHONE = { width: 360, height: 740 };

async function openDialog(page: import('@playwright/test').Page) {
	await page.goto('/account');
	await page.getByRole('region', { name: 'Delete my account' }).getByRole('button', { name: 'Delete my account' }).click();
	const dialog = page.getByRole('dialog', { name: 'Delete your account?' });
	await expect(dialog).toBeVisible();
	return dialog;
}

test('the only owner and admin is refused with what to hand over; once handed over, the account is deleted', async ({ page, owner, browser }) => {
	const project = await createProject(page.request, 'Only mine');
	const teamRes = await page.request.post(`${API_URL}/teams`, { data: { name: 'My team' } });
	expect(teamRes.status()).toBe(201);
	const team = ((await teamRes.json()) as { team: { id: string } }).team;

	const dialog = await openDialog(page);
	// What goes, what stays without the name, and what keeps it.
	await expect(dialog.getByRole('heading', { name: 'Deleted', exact: true })).toBeVisible();
	await expect(dialog.getByRole('heading', { name: 'Kept, without your name' })).toBeVisible();
	await expect(dialog.getByRole('heading', { name: 'Kept, with your name' })).toBeVisible();
	await expect(dialog).toContainText('A sign-off keeps the name and registration you typed');

	// A wrong password says so, and deletes nothing.
	await dialog.getByLabel('Your password').fill('not my password');
	await dialog.getByRole('button', { name: 'Delete my account' }).click();
	await expect(dialog.getByRole('alert')).toHaveText('Your current password is wrong.');
	await expect(dialog.getByLabel('Your password')).toHaveAttribute('aria-invalid', 'true');

	// The right password, but they alone own a project and run a team: refused, naming both, with links.
	await dialog.getByLabel('Your password').fill(owner.password);
	await dialog.getByRole('button', { name: 'Delete my account' }).click();
	const held = dialog.locator('[data-sole-holder]');
	await expect(held).toBeFocused();
	await expect(held).toContainText('Your account wasn’t deleted');
	await expect(held.getByRole('link', { name: 'Only mine' })).toHaveAttribute('href', `/projects/${project.id}`);
	await expect(held.getByRole('link', { name: 'My team' })).toHaveAttribute('href', `/teams/${team.id}`);
	await expectNoViolations(page);

	// Cancel leaves everything as it was.
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toBeHidden();
	await page.reload();
	await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();

	// Hand both over to a colleague (an invite they accept), then delete.
	const asColleague = await browser.newContext();
	const colleague = await register(asColleague.request, 'Colleague');
	await addMember(page.request, project.id, colleague.email, 'owner');
	expect((await page.request.post(`${API_URL}/teams/${team.id}/members`, { data: { email: colleague.email, role: 'admin' } })).status()).toBe(201);
	expect(await acceptInvites(colleague.email, team.id)).toBe(1);

	const again = await openDialog(page);
	await again.getByLabel('Your password').fill(owner.password);
	await again.getByRole('button', { name: 'Delete my account' }).click();
	await expect(page).toHaveURL('/login?deleted=1');
	await expect(page.getByRole('status').filter({ hasText: 'Your account has been deleted' })).toContainText('We emailed you what was deleted and what was kept.');

	// Signed out here, and the password signs in nowhere.
	await page.goto('/account');
	await expect(page).toHaveURL(/\/login\?next=/);
	const relogin = await page.request.post(`${API_URL}/auth/login`, { data: { email: owner.email, password: owner.password } });
	expect(relogin.status()).toBe(401);
	// The colleague runs the project now; it stays, with its maker cleared.
	expect((await asColleague.request.get(`${API_URL}/projects/${project.id}`)).status()).toBe(200);
	await asColleague.close();
});

// axe on the open dialog in both themes, at desktop and phone width.
for (const colorScheme of ['light', 'dark'] as const) {
	for (const [sizeName, viewport] of [
		['desktop', { width: 1280, height: 800 }],
		['phone', PHONE]
	] as const) {
		test.describe(`${colorScheme}, ${sizeName}`, () => {
			test.use({ colorScheme, viewport });

			test('the delete dialog has no WCAG 2.2 AA violations, with an error shown', async ({ page, owner }) => {
				const dialog = await openDialog(page);
				await expect(dialog.getByLabel('Your password')).toBeVisible();
				await expectNoViolations(page);
				await dialog.getByRole('button', { name: 'Delete my account' }).click();
				await expect(dialog.getByRole('alert')).toHaveText('Enter your password.');
				await expectNoViolations(page);
				// Nothing was sent: the account is still there.
				await dialog.getByRole('button', { name: 'Cancel' }).click();
				await expect(dialog).toBeHidden();
				await expect(page.getByLabel('Display name')).toHaveValue(owner.displayName);
			});
		});
	}
}
