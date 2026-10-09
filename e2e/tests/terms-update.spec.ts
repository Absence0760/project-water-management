// The re-acceptance step (docs/legal-status.md): an account that accepted an
// older version of the terms and privacy notice (or none) sees a full-page
// notice in place of any app page until it accepts the version in force; the
// legal pages stay open from it, and Sign out leaves it.
import { expectNoViolations } from '../support/a11y.ts';
import { createProject, LEGAL_VERSION } from '../support/api.ts';
import { setTermsVersion, termsAccepted } from '../support/db.ts';
import { expect, test } from '../support/fixtures.ts';

test('after the terms change, the app waits for Accept; the legal pages stay open, and the page asked for follows', async ({ page, owner }) => {
	const project = await createProject(page.request, 'Terms-update catchment');
	await setTermsVersion([owner.email], '2020-01-01');

	await page.goto(`/projects/${project.id}`);
	const title = page.getByRole('heading', { level: 1, name: 'Our terms have changed' });
	await expect(title).toBeVisible();
	await expect(page).toHaveURL(`/projects/${project.id}`);
	// Nothing of the app behind it: no sidebar, no catchment.
	await expect(page.getByText('Terms-update catchment')).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'What changed' })).toBeVisible();
	// Accepted a version before both listed ones: every change since, the first version's included (round 4).
	await expect(page.locator('ul.changes').getByRole('listitem')).toHaveCount(11);
	const summary = page.getByRole('region', { name: 'The main things you agree to' });
	await expect(summary.getByRole('listitem')).toHaveCount(4);
	await expectNoViolations(page);

	// The Terms open from it, and aren't held behind it.
	await page.getByRole('link', { name: 'Terms of use' }).click();
	await expect(page).toHaveURL('/terms');
	await expect(page.getByRole('heading', { level: 1, name: 'Terms of use' })).toBeVisible();
	await page.goBack();
	await expect(title).toBeVisible();

	await page.getByRole('button', { name: 'Accept the new terms' }).click();
	await expect(title).toHaveCount(0);
	await expect(page).toHaveURL(`/projects/${project.id}`);
	// The button went with the notice: focus is at the start of the page asked for (its title, or
	// #main while it loads), not dropped on <body> (WCAG 2.4.3, issue #51).
	await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('#main'))).toBe(true);
	await expect(page.getByText('Terms-update catchment').first()).toBeVisible();
	expect(await termsAccepted(owner.email)).toEqual({ version: LEGAL_VERSION, at: expect.any(Date) });

	// Accepted once: not asked again.
	await page.reload();
	await expect(page.getByRole('heading', { level: 1, name: 'Our terms have changed' })).toHaveCount(0);
});

test('an account that accepted an older version can sign out from the notice instead, and passes an a11y scan on a phone', async ({ page, owner }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await setTermsVersion([owner.email], '2020-01-01');
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1, name: 'Our terms have changed' })).toBeVisible();
	await expectNoViolations(page);

	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL('/login');
	expect((await termsAccepted(owner.email)).version).toBe('2020-01-01');
});

test('an account that accepted the previous version is shown only what changed since', async ({ page, owner }) => {
	await setTermsVersion([owner.email], '2026-10-03');
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1, name: 'Our terms have changed' })).toBeVisible();
	const changes = page.locator('ul.changes').getByRole('listitem');
	// 2026-10-08's one entry: who must use two-step sign-in, recovering it, and codes by email.
	await expect(changes).toHaveCount(3);
	await expect(changes.nth(0)).toHaveText(/Two-step sign-in is now needed only to publish to farmers/);
	await expect(changes.nth(1)).toHaveText(/remove two-step sign-in yourself after a 3-day wait, or ask a team admin/);
	await expect(changes.nth(2)).toHaveText(/get your sign-in codes by email/);
});
