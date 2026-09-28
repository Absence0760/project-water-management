// Liability and credibility on the report (WP-3.13, docs/ui.md § Report): the
// validation statement with its generated limitations, the agreed disclaimer,
// and the professional sign-off flow — every statement ticked, the whole
// limitations list scrolled, then a permanent sign-off printed on the report
// and shown to a viewer, who can't sign.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const ready = (page: Page) => expect(page.locator('main[data-report-ready="true"]')).toBeVisible();

test('an editor signs a run off from its report; a viewer sees the sign-off and cannot sign', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Sign-off catchment');
	const runId = await createRun(page.request, project.id, 'Baseline');
	const url = `/projects/${project.id}/report?run=${runId}`;
	await page.goto(url);
	await ready(page);

	// The validation statement and the disclaimer (agreed 2026-09-28, so no draft line), before anyone signs.
	const validation = page.locator('#rep-validation');
	await expect(validation.getByRole('heading', { name: 'Known limitations' })).toBeVisible();
	await expect(validation.getByRole('rowheader', { name: 'N1', exact: true })).toBeVisible();
	await expect(validation.getByText(/set for monthly flows/)).toBeVisible();
	const disclaimer = page.locator('#rep-disclaimer');
	await expect(disclaimer).toContainText('It is not an authorisation to use water.');
	await expect(disclaimer).toContainText('Disclaimer version 2026-09-28.');
	await expect(disclaimer).not.toContainText('Draft wording');
	const signoff = page.locator('#rep-signoff');
	await expect(signoff).toContainText('Not signed off.');

	await signoff.getByRole('button', { name: 'Sign off this run…' }).click();
	const dialog = page.getByRole('dialog', { name: 'Sign off this run' });
	await expect(dialog).toBeVisible();
	await expectNoViolations(page, { include: 'dialog[open]' });

	const submit = dialog.getByRole('button', { name: 'Sign off', exact: true });
	await dialog.getByLabel('Full name', { exact: true }).fill('Dr A. Hydrologist');
	await dialog.getByLabel('Registration number', { exact: true }).fill('400999/20');
	await dialog.getByLabel('What this sign-off covers', { exact: true }).fill('Hydrology section of a synthetic WULA');
	const boxes = dialog.getByRole('checkbox');
	await expect(boxes).toHaveCount(10);
	await expect(boxes.first()).toHaveAccessibleName(/^I am the person named above/);
	// What the signature does not cover is printed with the statement, not ticked.
	await expect(dialog.getByText('This sign-off makes no finding on whether any water use or works are lawful.')).toBeVisible();
	for (const box of await boxes.all()) await box.check();
	// Still disabled: the limitations list hasn't been read to the end.
	await expect(submit).toBeDisabled();
	await expect(dialog.getByText('Scroll to the end of the known limitations.')).toBeVisible();
	const list = dialog.getByRole('region', { name: /^Known limitations/ });
	await list.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
	await expect(dialog.getByText('You have reached the end of the list.')).toBeVisible();
	// Unticking one statement blocks it again.
	await boxes.first().uncheck();
	await expect(submit).toBeDisabled();
	await boxes.first().check();
	await expect(submit).toBeEnabled();
	await submit.click();

	await expect(dialog).toBeHidden();
	await expect(signoff.getByRole('status')).toHaveText('Signed off by Dr A. Hydrologist.');
	const record = signoff.getByRole('definition').filter({ hasText: 'SACNASP 400999/20' });
	await expect(record).toBeVisible();
	await expect(signoff).not.toContainText('Not signed off.');

	// A viewer sees the same sign-off after a reload, and has no way to sign.
	const viewer = await signIn('Sign-off viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(url);
	await ready(viewer.page);
	const theirs = viewer.page.locator('#rep-signoff');
	await expect(theirs.getByText('Dr A. Hydrologist', { exact: true })).toBeVisible();
	await expect(theirs.getByRole('button', { name: 'Sign off this run…' })).toHaveCount(0);

	// The run is kept for good: the Runs tab tags it and offers no delete.
	await page.goto(`/projects/${project.id}?tab=runs&run=${runId}`);
	await expect(page.getByText('Signed off', { exact: true }).first()).toBeVisible();
});
