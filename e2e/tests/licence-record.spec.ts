// The Project page's Licence record panel (161_licence_record, docs/ui.md
// § Project; provisional position, pre-counsel research 2026-10-01): once a
// run is nominated as evidence, the record has a review five years on; an
// owner records the decision and the panel says until when the record (and
// the names it keeps) is kept: the decision + 3 years for a refusal. An
// editor reads it without the form; a viewer doesn't see it. Synthetic data.
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, createRun, nominateRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll, resizeTo } from '../support/reflow.ts';

test('an owner records the licence outcome, and the panel says how long the record is kept', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Licence record');
	const run = await createRun(page.request, project.id, 'Baseline');

	// No nomination or issued pack yet: nothing to keep.
	await page.goto(`/projects/${project.id}?tab=project`);
	const panel = page.getByTestId('licence-record');
	await expect(panel.getByTestId('licence-record-status')).toHaveText('No evidence pack is issued and no run is nominated yet, so there is no licence record to keep.');

	// A nominated run starts the five-yearly review.
	await nominateRun(page.request, project.id, run, 'Evidence for the licence record test');
	await page.reload();
	await expect(panel.getByTestId('licence-record-status')).toHaveText(/^No outcome is recorded\. Next review: \d{1,2} [A-Z][a-z]{2} \d{4}\.$/);

	// The owner records a refusal, in the authority's words (233): kept until three years after the decision.
	const form = panel.getByRole('form', { name: 'Record the licence outcome' });
	await form.getByLabel('Outcome').selectOption('licence_refused');
	await form.getByLabel('Decided on').fill('2026-03-01');
	await expect(form.getByRole('button', { name: 'Save the outcome' })).toBeDisabled();
	await form.getByLabel('Why').fill('Invented decision letter 1');
	await form.getByRole('button', { name: 'Save the outcome' }).click();
	await expect(panel.getByRole('status')).toHaveText('Saved.');
	await expect(panel.getByTestId('licence-record-status')).toHaveText('Licence refused on 1 Mar 2026. The record is kept until 1 Mar 2029.');
	await expect(panel).toContainText('Recorded because: Invented decision letter 1');
	await expectNoViolations(page);

	// On a phone the outcome picker keeps to the form, also on its longest words (233's outcomes pushed a 320 px page sideways).
	await form.getByLabel('Outcome').selectOption('application_rejected');
	await expect(form.getByLabel('Outcome')).toHaveValue('application_rejected');
	for (const width of [320, 390]) {
		await resizeTo(page, { width, height: 740 });
		await expectNoSidewaysScroll(page);
	}
	await resizeTo(page, { width: 1280, height: 800 });

	// An editor reads it, without the form; a viewer doesn't see the panel.
	const editor = await signIn('Licence record editor');
	await addMember(page.request, project.id, editor.user.email, 'editor');
	await editor.page.goto(`/projects/${project.id}?tab=project`);
	await expect(editor.page.getByTestId('licence-record-status')).toHaveText('Licence refused on 1 Mar 2026. The record is kept until 1 Mar 2029.');
	await expect(editor.page.getByRole('form', { name: 'Record the licence outcome' })).toHaveCount(0);
	const viewer = await signIn('Licence record viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=project`);
	await expect(viewer.page.getByTestId('project-role')).toBeVisible();
	await expect(viewer.page.getByTestId('licence-record')).toHaveCount(0);
});

test('the licence record email’s link (`?tab=project#licence-record`) lands on the panel, focused (issue #586)', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1280, height: 800 });
	const project = await createProject(page.request, 'Licence record link');
	await page.goto('/');
	await page.goto(`/projects/${project.id}?tab=project#licence-record`);
	const heading = page.locator('#licence-record');
	await expect(heading).toContainText('Licence record');
	await expect(heading).toBeFocused();
	await expect(heading).toBeInViewport();
});
