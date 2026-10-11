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
	await page.setViewportSize({ width: 1440, height: 900 });
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
	// Recording a check is rare, so its form stays closed behind "+ Record a check" in the panel's head row, beside
	// its heading (issue #521 § 13); opening it puts focus on its first field, Cancel closes it and returns focus.
	const heading = (await panel.getByRole('heading', { level: 2, name: /^Registration checks/ }).boundingBox())!;
	const opener = panel.getByRole('button', { name: '+ Record a check' });
	const openerBox = (await opener.boundingBox())!;
	expect(Math.abs(openerBox.y + openerBox.height / 2 - (heading.y + heading.height / 2))).toBeLessThan(8);
	expect(openerBox.x).toBeGreaterThan(heading.x + heading.width);
	await expect(panel.getByLabel('Registration number')).toHaveCount(0);
	await expect(panel.getByRole('button', { name: 'Record the check' })).toHaveCount(0);
	await opener.click();
	await expect(panel.getByLabel('Member', { exact: true })).toBeFocused();
	await expect(opener).toHaveCount(0);
	await panel.getByRole('button', { name: 'Cancel' }).click();
	await expect(panel.getByLabel('Registration number')).toHaveCount(0);
	await expect(opener).toBeFocused();
	await opener.click();
	// Open, the form's action row is on screen with it at 1440 wide.
	await panel.getByRole('button', { name: 'Record the check' }).scrollIntoViewIfNeeded();
	await expect(panel.getByLabel('Member', { exact: true })).toBeInViewport();
	await expect(panel.getByRole('button', { name: 'Record the check' })).toBeInViewport();
	await panel.getByLabel('Member', { exact: true }).selectOption({ label: 'Party specialist' });
	await panel.getByLabel('Category', { exact: true }).selectOption({ index: 1 });
	await panel.getByLabel('Registration number').fill('400123/10');
	await panel.getByLabel('Name on the register').fill('Party Specialist');
	await panel.getByLabel('Checked by (organisation)').fill('Rooikloof WUA');
	await panel.getByRole('button', { name: 'Record the check' }).click();
	await expect(panel.getByRole('row', { name: /Party specialist/ })).toContainText('On the register');
	await expect(panel.getByRole('row', { name: /Party specialist/ })).toContainText('Rooikloof WUA');
	// Recorded: the form closes and focus goes back to the header's button.
	await expect(panel.getByLabel('Registration number')).toHaveCount(0);
	await expect(opener).toBeFocused();
	await panel.getByTestId('registration-check-required').uncheck();
	await expect(panel.getByTestId('registration-check-required')).not.toBeChecked();
	await expectNoViolations(page);

	// The editor reads the check, and has no form to record one or switch the requirement.
	await openProject(editor.page, project.id);
	const theirs = editor.page.getByTestId('registration-checks');
	await expect(theirs.getByRole('row', { name: /Party specialist/ })).toContainText('Rooikloof WUA');
	await expect(theirs.getByRole('button', { name: '+ Record a check' })).toHaveCount(0);
	await expect(theirs.getByRole('button', { name: 'Record the check' })).toHaveCount(0);
	await expect(theirs.getByTestId('registration-check-required')).toHaveCount(0);
	await expect(theirs).toContainText('Issuing an evidence pack doesn’t wait for a check.');
});
