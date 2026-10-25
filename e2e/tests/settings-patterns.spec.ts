// The playbook's head-row rules over every Settings panel at once (issue #521 round 4, ui-playbook.md § 2): with
// every fold open, no two visible buttons in a panel share an accessible name (round 1 checked Rain gaps alone,
// whose "Add a water year" appeared twice), and every fold keeps its line: the values it holds, the app's one
// chevron and a named action. Checked on the Showcase, which fills nearly every panel, and on a new project,
// whose panels show their empty states. Synthetic data.
import type { Page } from '@playwright/test';
import { createProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll, layoutSettled, resizeTo } from '../support/reflow.ts';
import { expectFoldsNamed, sharedButtonNames } from '../support/settings.ts';
import { seedShowcaseModel } from '../support/showcase.ts';

test.describe.configure({ timeout: 120_000 });

async function checkPanels(page: Page, projectId: string) {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/projects/${projectId}?tab=settings`);
	await expect(page.getByRole('heading', { level: 2, name: 'Demand' })).toBeVisible();
	// Evaporation from the map, a card of Flow calibration, loads on its own; wait for it.
	await expect(page.locator('#set-evaporation').locator('h2, h3').first()).toBeVisible();
	await layoutSettled(page);

	// Closed, every fold's line says its values.
	const closed = await expectFoldsNamed(page.locator('.settings-form'));
	expect(closed).toBeGreaterThan(3);

	// Open every fold (each opened in turn, so a fold inside another is reached once its parent is open).
	for (;;) {
		const shut = page.locator('details.fold:visible:not([open]) > summary');
		if (!(await shut.count())) break;
		await shut.first().click();
	}
	await expectFoldsNamed(page.locator('.settings-form'));

	const panels = await page.locator('.settings-form section.panel').all();
	expect(panels.length).toBeGreaterThan(10);
	for (const panel of panels) {
		const id = (await panel.getAttribute('id')) ?? (await panel.getByRole('heading', { level: 2 }).first().innerText());
		expect(await sharedButtonNames(panel), `${id}: buttons that share a name`).toEqual([]);
	}

	// Every fold open, the page still stacks on a phone with no sideways scroll (the chevron takes room on each line).
	for (const width of [320, 390]) {
		await resizeTo(page, { width, height: 844 });
		await expectNoSidewaysScroll(page);
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
