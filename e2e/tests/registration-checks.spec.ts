// Signers on the Project page (167_signers; licensing positions item 9,
// provisional position, pre-counsel research, 2026-10-01; docs/ui.md
// § Project → Registration checks): the owner appoints an applying party's
// specialist (who signs that party's evidence packs) and records the host's
// check of a member's registration against the public register; the
// requirement that issue waits for it is the owner's switch. An editor reads
// the checks and records none (control: the owner's form). axe on the panel.
// Synthetic data only.
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { openProject } from '../support/project.ts';

test('the owner appoints a party’s specialist and records a registration check; an editor only reads them', async ({ page, owner, signIn }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const specialist = await signIn('Party specialist');
	const editor = await signIn('Checks editor');
	const project = await createProject(page.request, 'Signers');
	await addMember(page.request, project.id, specialist.user.email, 'contributor');
	await addMember(page.request, project.id, editor.user.email, 'editor');
	expect((await page.request.patch(`${API_URL}/projects/${project.id}/members/${specialist.user.id}`, { data: { party: 'Rooikloof Trust' } })).status()).toBe(200);

	await openProject(page, project.id);
	const members = page.getByRole('region', { name: 'Members', exact: true });
	const row = members.getByRole('row', { name: /Party specialist/ });
	await row.getByTestId('member-specialist').check();
	await expect(row.getByTestId('member-specialist')).toBeChecked();

	const panel = page.getByTestId('registration-checks');
	await expect(panel.getByText('No check recorded yet.')).toBeVisible();
	await panel.getByLabel('Member', { exact: true }).selectOption({ label: 'Party specialist' });
	await panel.getByLabel('Category', { exact: true }).selectOption({ index: 1 });
	await panel.getByLabel('Registration number').fill('400123/10');
	await panel.getByLabel('Name on the register').fill('Party Specialist');
	await panel.getByLabel('Checked by (organisation)').fill('Rooikloof WUA');
	await panel.getByRole('button', { name: 'Record the check' }).click();
	await expect(panel.getByRole('row', { name: /Party specialist/ })).toContainText('On the register');
	await expect(panel.getByRole('row', { name: /Party specialist/ })).toContainText('Rooikloof WUA');
	await panel.getByTestId('registration-check-required').uncheck();
	await expect(panel.getByTestId('registration-check-required')).not.toBeChecked();
	await expectNoViolations(page);

	// The editor reads the check, and has no form to record one or switch the requirement.
	await openProject(editor.page, project.id);
	const theirs = editor.page.getByTestId('registration-checks');
	await expect(theirs.getByRole('row', { name: /Party specialist/ })).toContainText('Rooikloof WUA');
	await expect(theirs.getByRole('button', { name: 'Record the check' })).toHaveCount(0);
	await expect(theirs.getByTestId('registration-check-required')).toHaveCount(0);
	await expect(theirs).toContainText('Issuing an evidence pack doesn’t wait for a check.');
});
