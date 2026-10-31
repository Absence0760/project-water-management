// Scenarios → the scenario editor (issue #521, section 12): two cards. Changes with Add a change is the main
// job, its button on the first screen; Application details holds the proposer's units, the applicant's
// statement and the rebase, each a one-line summary with a disclosure marker that opens its form. Synthetic data.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll, layoutSettled, resizeTo } from '../support/reflow.ts';
import { createScenario, openDetails } from '../support/scenarios.ts';
import { expectFoldsNamed } from '../support/settings.ts';

async function seed(page: Page, name: string) {
	const project = await seedRunnableProject(page.request, name);
	const base = await createRun(page.request, project.id, 'Calibrated baseline');
	await createRun(page.request, project.id, 'Newer run');
	const upper = (project.model.nodes as { id: string; name: string }[]).find((n) => n.name === 'Upper farm')!.id;
	const sid = await createScenario(page.request, project.id, {
		name: 'Upper farm dam raise',
		baseRunId: base,
		ops: [{ op: 'node.set', nodeId: upper, field: 'damCapacityM3', value: 300_000 }]
	});
	return { id: project.id, sid };
}

const details = (page: Page) => page.getByTestId('application-details');

test('at 1440×900 Add change is on the first screen, and Application details is three one-line summaries that open', async ({ page, owner }) => {
	void owner;
	const p = await seed(page, 'Scenario editor layout');
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/projects/${p.id}?tab=scenarios&scenario=${p.sid}`);
	await expect(details(page)).toBeVisible();
	await layoutSettled(page);
	await expect(page.getByRole('button', { name: 'Add change', exact: true })).toBeInViewport({ ratio: 1 });
	await expect(page.getByRole('button', { name: 'Run scenario' })).toBeInViewport({ ratio: 1 });

	// Closed, each line says its value, then its action, a word apart: the action ends the summary's accessible name
	// (Fold.svelte, issue #586 R4-I).
	await expect(details(page).getByRole('heading', { name: 'Application details' })).toBeVisible();
	await expect(page.getByTestId('proposer-fold').locator(':scope > summary')).toHaveText(/^Proposer: none ticked Change$/);
	// The WULA it models (294_wula_reference): none given yet.
	await expect(page.getByTestId('scenario-wula').locator(':scope > summary')).toHaveText(/^WULA: Not given Change$/);
	await expect(page.getByTestId('scenario-statement').locator(':scope > summary')).toHaveText(/^Statement: 0 of 3 answered Change$/);
	await expect(page.getByTestId('rebase-fold').locator(':scope > summary')).toHaveText(/^Based on Calibrated baseline: rebase onto another run Rebase…$/);
	for (const id of ['proposer-fold', 'scenario-wula', 'scenario-statement', 'rebase-fold']) {
		const fold = page.getByTestId(id);
		await expect(fold).not.toHaveAttribute('open');
		// Each summary is one line and has its disclosure marker (the rebase line had none).
		const summary = fold.locator(':scope > summary');
		expect((await summary.boundingBox())!.height).toBeLessThan(48);
		expect(await summary.evaluate((el) => getComputedStyle(el, '::before').borderRightWidth)).toBe('2px');
	}

	expect(await expectFoldsNamed(details(page))).toBe(4);

	// Each opens to its form.
	await openDetails(page, 'proposer-fold');
	await expect(page.getByRole('group', { name: "The proposer's hydrological units" }).getByLabel('Upper farm')).toBeVisible();
	await openDetails(page, 'scenario-wula');
	await expect(page.getByTestId('scenario-wula').getByRole('button', { name: 'Add the WULA reference' })).toBeVisible();
	await openDetails(page, 'scenario-statement');
	await expect(page.getByTestId('scenario-statement').getByRole('button', { name: 'Answer the prompts' })).toBeVisible();
	await openDetails(page, 'rebase-fold');
	await expect(page.getByLabel('New base run')).toBeVisible();
	await expect(page.getByTestId('rebase-fold').locator(':scope > summary')).toContainText('Hide');

	// Ticking a unit says so on the closed line.
	await page.getByRole('group', { name: "The proposer's hydrological units" }).getByLabel('Upper farm').check();
	await expect(page.getByTestId('proposer-summary')).toHaveText('Upper farm');
	await expectNoViolations(page, { include: '[data-testid="application-details"]' });
});

test('a viewer reads the summaries and opens them read only; no rebase is offered', async ({ page, owner, signIn }) => {
	void owner;
	const p = await seed(page, 'Scenario editor viewer');
	const viewer = await signIn('Scenario layout viewer');
	await addMember(page.request, p.id, viewer.user.email, 'viewer');
	await viewer.page.setViewportSize({ width: 1440, height: 900 });
	await viewer.page.goto(`/projects/${p.id}?tab=scenarios&scenario=${p.sid}`);
	await expect(details(viewer.page)).toBeVisible();
	await expect(viewer.page.getByTestId('rebase-fold')).toHaveCount(0);
	await expect(viewer.page.getByTestId('scenario-statement').locator(':scope > summary')).toHaveText(/^Statement: 0 of 3 answered Show$/);
	await openDetails(viewer.page, 'scenario-statement');
	await expect(viewer.page.getByTestId('scenario-statement').getByRole('button')).toHaveCount(0);
	await expect(viewer.page.getByTestId('scenario-wula').locator(':scope > summary')).toHaveText(/^WULA: Not given Show$/);
	await openDetails(viewer.page, 'scenario-wula');
	await expect(viewer.page.getByTestId('scenario-wula').getByRole('button')).toHaveCount(0);
});

test('the editor stacks on a phone with no sideways scroll, folds open, and passes axe', async ({ page, owner }) => {
	void owner;
	const p = await seed(page, 'Scenario editor phone');
	await page.goto(`/projects/${p.id}?tab=scenarios&scenario=${p.sid}`);
	await expect(details(page)).toBeVisible();
	for (const width of [320, 390]) {
		await resizeTo(page, { width, height: 844 });
		await expectNoSidewaysScroll(page);
	}
	for (const id of ['proposer-fold', 'scenario-wula', 'scenario-statement', 'rebase-fold'] as const) await openDetails(page, id);
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page, { include: '[data-testid="application-details"]' });
});

// The explanations under the form's fields (issue #521): hidden behind the same remembered switch as Settings' and a
// node's sheet, so the fields come first; a hint that says a value, a classification or what to do next stays.
test('the hints that only explain follow the remembered explain switch, the one Settings has', async ({ page, owner }) => {
	void owner;
	const p = await seed(page, 'Scenario editor explain');
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/projects/${p.id}?tab=scenarios&scenario=${p.sid}`);
	await expect(details(page)).toBeVisible();
	const sw = page.getByRole('checkbox', { name: 'Explain each setting under its field' });
	const tables = page.getByText("The Network, Crops and Transfers tables on this scenario's model; each edit is recorded as a change.");
	await expect(sw).not.toBeChecked();
	await expect(tables).toBeHidden();
	// In the Changes card's head row, beside Undo, so Add change keeps its place on the first screen.
	await expect(sw).toBeInViewport({ ratio: 1 });
	await expect(page.getByRole('button', { name: 'Add change', exact: true })).toBeInViewport({ ratio: 1 });
	// A classification stays: changing the Reserve is always a baseline assumption.
	await page.getByLabel('Kind of change').selectOption({ label: "Set an EWR site's rule table" });
	await expect(page.getByTestId('op-ewr-baseline')).toBeVisible();
	// The rebase fold's explanation hides; its ⓘ stays.
	await openDetails(page, 'rebase-fold');
	const rebase = page.getByTestId('rebase-fold');
	await expect(rebase.getByText(/^Rebase onto another run: apply the same changes/)).toBeHidden();
	await expect(rebase.getByRole('button', { name: 'About rebasing a scenario' })).toBeVisible();

	await sw.check();
	await expect(tables).toBeVisible();
	await expect(rebase.getByText(/^Rebase onto another run: apply the same changes/)).toBeVisible();
	// Remembered on this device, and the same switch in Settings.
	await page.reload();
	await expect(page.getByRole('checkbox', { name: 'Explain each setting under its field' })).toBeChecked();
	await expect(tables).toBeVisible();
	await page.goto(`/projects/${p.id}?tab=settings`);
	await expect(page.getByRole('checkbox', { name: 'Explain each setting under its field' })).toBeChecked();
	await page.getByRole('checkbox', { name: 'Explain each setting under its field' }).uncheck();
	await page.goto(`/projects/${p.id}?tab=scenarios&scenario=${p.sid}`);
	await expect(page.getByRole('checkbox', { name: 'Explain each setting under its field' })).not.toBeChecked();
	await expect(tables).toBeHidden();

	// On, the editor still stacks at 320 and 390 with no sideways scroll.
	await page.getByRole('checkbox', { name: 'Explain each setting under its field' }).check();
	for (const width of [320, 390]) {
		await resizeTo(page, { width, height: 844 });
		await expectNoSidewaysScroll(page);
	}
	await expectNoViolations(page);
});
