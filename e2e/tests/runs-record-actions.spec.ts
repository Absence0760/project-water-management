// Runs & results → the Record and Dig deeper panels after an action (issue #586, Round 2): the focus never
// falls to the page after a save, a nomination, a withdrawal, a publish, a notice edit, a reproduction check
// or a traced day (ui-playbook § 4: don't disable a control while its own change saves; when a state
// replaces the focused control, focus the title); dates read day first; the passed self-checks fold behind
// one button; and the things to check start with a capital. Synthetic data.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createRun, seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { resizeTo } from '../support/reflow.ts';

/** A run of the model, nothing nominated or published. */
async function seed(page: Page, name: string) {
	const project = await seedRunnableProject(page.request, name);
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	const run = await createRun(page.request, project.id, 'Baseline');
	return { id: project.id, run };
}

const panel = (page: Page, id: string) => page.locator(`#${id}`);

test('Save notes, Nominate, Withdraw and Check reproduction keep the focus on the page, never on <body>', async ({ page, owner }) => {
	void owner;
	const p = await seed(page, 'Record actions');
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/projects/${p.id}?tab=runs&run=${p.run}#res-notes`);

	// Save notes: the button stays focused (it isn't disabled under the focus), and Saved. is said.
	const notes = panel(page, 'res-notes');
	await notes.getByRole('textbox', { name: 'Run notes' }).fill('Calibrated against the weir record.');
	const save = notes.getByRole('button', { name: 'Save notes' });
	await save.click();
	await expect(notes.getByRole('status')).toHaveText('Saved.');
	await expect(save).toBeFocused();
	// Nothing to save now: marked unavailable, still focusable, and a press saves nothing again.
	await expect(save).toHaveAttribute('aria-disabled', 'true');

	// Nominate: the form gives way to the status line, and the focus goes to the panel's heading.
	const evidence = panel(page, 'res-evidence');
	await evidence.getByLabel(/^Why this run is the evidence/).fill('The run the licence application relies on.');
	await evidence.getByRole('button', { name: 'Nominate as evidence' }).click();
	await expect(evidence.getByRole('heading', { name: 'Evidence', exact: true })).toBeFocused();
	await expect(evidence).toContainText('Nominated as evidence on');
	// The status line says it once: no second "This run is the nominated evidence run." under it.
	await expect(evidence.getByText('This run is the nominated evidence run.')).toHaveCount(0);

	// Withdraw: the form and the head's button go, so the focus goes to the heading too.
	await evidence.getByRole('button', { name: 'Withdraw the nomination…' }).click();
	await evidence.getByLabel(/^Why the nomination is withdrawn/).fill('The application was withdrawn.');
	await evidence.getByRole('button', { name: 'Withdraw the nomination', exact: true }).click();
	await expect(evidence).toContainText("The project's nomination was withdrawn");
	await expect(evidence.getByRole('heading', { name: 'Evidence', exact: true })).toBeFocused();

	// Check reproduction: the button keeps the focus while it checks and after.
	const reproduce = panel(page, 'res-reproduce');
	const check = reproduce.getByRole('button', { name: 'Check reproduction' });
	await check.click();
	await expect(reproduce.getByTestId('reproduce-result')).toHaveText(/^Identical: /);
	await expect(check).toBeFocused();
	await expect(check).not.toHaveAttribute('aria-disabled', 'true');
	await expectNoViolations(page, { include: '#res-notes, #res-evidence, #res-reproduce' });
});

test('publishing, editing the notice and cancelling hand the focus to what is there after; the dialog dates day first', async ({ page, owner }) => {
	void owner;
	const p = await seed(page, 'Publication focus');
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/projects/${p.id}?tab=runs&run=${p.run}#res-publication`);
	const pub = panel(page, 'res-publication');

	await pub.getByRole('button', { name: 'Publish this run' }).click();
	const dialog = page.getByRole('dialog', { name: 'Publish this run?' });
	// The run's last day, day first (seedRunnableProject's record ends 28 Jan 2022), never 2022-01-28.
	await expect(dialog).toContainText('from 1 October to 28 Jan 2022');
	await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
	await expect(dialog).toBeHidden();
	// Publish this run is gone (the run is published): the focus goes to the panel's heading.
	await expect(pub.getByTestId('publication-published')).toBeVisible();
	await expect(pub.getByRole('heading', { name: 'Publication', exact: true })).toBeFocused();

	// Edit notice, Cancel: back on Edit notice.
	const edit = pub.getByRole('button', { name: 'Edit notice' });
	await edit.click();
	const form = pub.getByRole('form', { name: 'Edit the notice' });
	await form.getByRole('button', { name: 'Cancel' }).click();
	await expect(form).toHaveCount(0);
	await expect(edit).toBeFocused();

	// Edit notice, Save notice: the form ends in the page's action row, and the focus is back on Edit notice.
	await edit.click();
	await expect(form.locator('.action-row').getByRole('button')).toHaveText(['Save notice', 'Cancel']);
	await form.getByLabel('Level', { exact: true }).selectOption('advisory');
	await form.getByRole('button', { name: 'Save notice' }).click();
	await expect(pub.getByRole('status')).toHaveText('Notice saved.');
	await expect(edit).toBeFocused();
});

test('Changes since this run dates its changes day first', async ({ page, owner }) => {
	void owner;
	const p = await seed(page, 'Changes since');
	await updateSettings(page.request, p.id, { ewrPragmaticM3PerDay: new Array(12).fill(1800) });
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/projects/${p.id}?tab=runs&run=${p.run}#res-reproduce`);
	const since = panel(page, 'res-reproduce').locator('details');
	await since.locator('summary').click();
	const revs = since.locator('.revs li');
	await expect(revs.first()).toBeVisible();
	// "3 Sep 2026 14:05", not "2026-09-03 14:05".
	await expect(revs.first()).toContainText(/^\d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}/);
	await expect(since).not.toContainText(/\b20\d\d-\d\d-\d\d\b/);
});

test('the passed self-checks fold behind one button; Trace keeps the focus and says what it traced, at 1440 and on a phone', async ({ page, owner }) => {
	void owner;
	const p = await seed(page, 'Self-checks fold');
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/projects/${p.id}?tab=runs&run=${p.run}#res-checks`);
	const checks = page.getByRole('region', { name: /^Self-checks/ });
	await expect(checks.getByRole('status').filter({ hasText: 'self-checks' })).toHaveText('All 13 self-checks passed.');
	// All passed: the headline says so, and the list waits behind one button.
	await expect(checks.getByRole('listitem')).toHaveCount(0);
	const show = checks.getByRole('button', { name: 'Show the 13 checks' });
	await expect(show).toHaveAttribute('aria-expanded', 'false');
	await show.click();
	await expect(checks.getByRole('listitem')).toHaveCount(13);
	const hide = checks.getByRole('button', { name: 'Hide the checks' });
	await expect(hide).toBeFocused();
	await expect(hide).toHaveAttribute('aria-expanded', 'true');
	await hide.click();
	await expect(checks.getByRole('listitem')).toHaveCount(0);

	const trace = page.getByRole('region', { name: /^Trace a day/ });
	await trace.getByLabel('Hydrological unit, gauge or catchment').selectOption({ label: 'Upper farm' });
	const go = trace.getByRole('button', { name: 'Trace', exact: true });
	await go.click();
	await expect(trace.getByRole('table')).toBeVisible();
	await expect(go).toBeFocused();
	// One short line is announced, not the whole table (the table is not a live region).
	await expect(trace.getByRole('status')).toHaveText(/^Traced Upper farm on \d{1,2} [A-Z][a-z]{2} 20\d\d: \d+ columns\.$/);
	await expect(trace.locator('[aria-live]').filter({ has: page.getByRole('table') })).toHaveCount(0);
	await expectNoViolations(page, { include: '#res-checks' });
	await resizeTo(page, { width: 390, height: 844 });
	await expectNoViolations(page, { include: '#res-checks' });
});

test('the things to check start with a capital, and Explore any output names its picker for what it lists', async ({ page, owner, fetchRoute }) => {
	void owner;
	const p = await seed(page, 'Warnings case');
	await fetchRoute(page, new RegExp(`/projects/${p.id}/runs/[^/?]+(?:\\?.*)?$`), async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		const res = await route.fetch();
		const body = await res.json();
		// An engine warning that starts lower case (the bed-loss warning does).
		if (body?.run?.summary) body.run.summary.warnings = ['bed losses are on: a synthetic warning.'];
		await route.fulfill({ response: res, json: body });
	});
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/projects/${p.id}?tab=runs&run=${p.run}`);
	await expect(page.getByTestId('warnings-check').getByRole('listitem')).toHaveText(['Bed losses are on: a synthetic warning.']);

	const explore = page.locator('#res-explore');
	await explore.scrollIntoViewIfNeeded();
	const where = explore.getByLabel('Catchment, hydrological unit or gauge');
	await expect(where).toHaveValue(/.+/);
	await expect(where.getByRole('option', { name: 'Catchment (outflow gauge)' })).toHaveCount(1);
});
