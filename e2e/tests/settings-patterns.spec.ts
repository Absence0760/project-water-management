// The playbook's head-row rules over every Settings panel at once (issue #521 round 4, ui-playbook.md § 2): with
// every fold open, no two visible buttons in a panel share an accessible name (round 1 checked Rain gaps alone,
// whose "Add a water year" appeared twice), and every fold keeps its line: the values it holds, the app's one
// chevron and a named action. Checked on the Showcase, which fills nearly every panel, and on a new project,
// whose panels show their empty states. Synthetic data.
import type { Page } from '@playwright/test';
import { createProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { layoutSettled } from '../support/reflow.ts';
import { expectFoldsNamed, sharedButtonNames } from '../support/settings.ts';
import { seedShowcaseModel } from '../support/showcase.ts';

test.describe.configure({ timeout: 120_000 });

async function checkPanels(page: Page, projectId: string) {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/projects/${projectId}?tab=settings`);
	await expect(page.getByRole('heading', { level: 2, name: 'Demand' })).toBeVisible();
	// The panels after the form load on their own; wait for the last one.
	await expect(page.locator('#set-report-schedules section.panel')).toBeVisible();
	await layoutSettled(page);

	// Closed, every fold's line says its values.
	const closed = await expectFoldsNamed(page.locator('.settings-form, .settings-after'));
	expect(closed).toBeGreaterThan(3);

	// Open every fold (each opened in turn, so a fold inside another is reached once its parent is open).
	for (;;) {
		const shut = page.locator('details.fold:visible:not([open]) > summary');
		if (!(await shut.count())) break;
		await shut.first().click();
	}
	await expectFoldsNamed(page.locator('.settings-form, .settings-after'));

	const panels = await page.locator('.settings-form section.panel, .settings-after section.panel').all();
	expect(panels.length).toBeGreaterThan(10);
	for (const panel of panels) {
		const id = (await panel.getAttribute('id')) ?? (await panel.getByRole('heading', { level: 2 }).first().innerText());
		expect(await sharedButtonNames(panel), `${id}: buttons that share a name`).toEqual([]);
	}
}

test('every Settings panel of the Showcase: no two buttons share a name, and every fold names its values', async ({ page, owner }) => {
	void owner;
	const showcase = await seedShowcaseModel(page.request, 'Settings patterns showcase');
	await checkPanels(page, showcase.id);
});

test('the same on a new project, its panels at their empty states', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Settings patterns new');
	await checkPanels(page, project.id);
});
