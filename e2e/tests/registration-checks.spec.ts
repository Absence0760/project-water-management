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

// The day field's latest day is the viewer's own today, not the UTC one (issue #521, round 6): around midnight in
// South Africa the UTC day is a day behind. The server's clock can't be moved, so the zone is picked to put the
// viewer on another calendar day than UTC right now (UTC−12 in the UTC morning, UTC+14 after it), and the day
// recorded by default (today) has to save: a bare day reaches the server as UTC midnight, still in the future
// east of Greenwich, so today goes as the current moment (pastDayMoment).
const otherDayZone = new Date().getUTCHours() < 11 ? 'Etc/GMT+12' : 'Etc/GMT-14';
test.describe('in a zone on another day than UTC', () => {
	test.use({ timezoneId: otherDayZone });
	test('the check’s day defaults to, and stops at, the viewer’s today, and today saves', async ({ page, owner, signIn }) => {
		void owner;
		await page.setViewportSize({ width: 1440, height: 900 });
		const specialist = await signIn('Zone specialist');
		const project = await createProject(page.request, 'Signers by zone');
		await addMember(page.request, project.id, specialist.user.email, 'contributor');
		expect((await page.request.patch(`${API_URL}/projects/${project.id}/members/${specialist.user.id}`, { data: { party: 'Rooikloof Trust' } })).status()).toBe(200);
		await openProject(page, project.id);
		const row = page.getByRole('region', { name: 'Members', exact: true }).getByRole('row', { name: /Zone specialist/ });
		await row.getByTestId('member-specialist').check();
		await expect(row.getByTestId('member-specialist')).toBeChecked();

		const days = await page.evaluate(() => {
			const d = new Date();
			const pad = (x: number) => String(x).padStart(2, '0');
			const label = `${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getFullYear()}`;
			return { local: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, utc: d.toISOString().slice(0, 10), label };
		});
		expect(days.local).not.toBe(days.utc);

		const panel = page.getByTestId('registration-checks');
		await panel.getByRole('button', { name: '+ Record a check' }).click();
		const day = panel.locator('#rc-date');
		await expect(day).toHaveValue(days.label);
		// West of UTC, the UTC day is the viewer's tomorrow, past the latest day the field takes.
		await day.fill(days.utc);
		await day.blur();
		if (days.utc > days.local) await expect(day).toHaveAttribute('aria-invalid', 'true');
		else await expect(day).not.toHaveAttribute('aria-invalid', 'true');
		await day.fill(days.local);
		await day.blur();
		await expect(day).not.toHaveAttribute('aria-invalid', 'true');

		await panel.getByLabel('Member', { exact: true }).selectOption({ label: 'Zone specialist' });
		await panel.getByLabel('Category', { exact: true }).selectOption({ index: 1 });
		await panel.getByLabel('Registration number').fill('400124/10');
		await panel.getByLabel('Name on the register').fill('Zone Specialist');
		await panel.getByLabel('Checked by (organisation)').fill('Rooikloof WUA');
		await panel.getByRole('button', { name: 'Record the check' }).click();
		await expect(panel.getByRole('row', { name: /Zone specialist/ })).toContainText(`${days.local} by Rooikloof WUA`);
		await expect(panel.getByRole('alert')).toHaveCount(0);
	});
});
