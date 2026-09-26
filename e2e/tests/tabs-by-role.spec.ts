// Tabs by role (issue #6, docs/ui.md § Tabs by role, lib/workspace/tabs.ts):
// owners and editors see every tab; a viewer sees Overview, Data and Runs &
// results, with the model inputs behind "Show model inputs". Presentation
// only: a deep link to a hidden tab still opens it. Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, putModel, sampleModel } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const strip = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });
const setup = (page: Page) => page.getByRole('region', { name: 'Set up this catchment' });
const toggle = (page: Page) => page.getByLabel('Show model inputs');

const EVERY_TAB = ['Overview', 'Network', 'Crops & demand', 'Transfers', 'Data', 'Settings & calibration', 'Runs & results', 'Scenarios', 'Allocations', 'History'];
const SHORT = ['Overview', 'Data', 'Runs & results', 'Scenarios', 'Allocations'];

/** The strip's tab names, in order. */
async function tabNames(page: Page) {
	await expect(strip(page).getByRole('link', { name: 'Overview' })).toBeVisible();
	return (await strip(page).getByRole('link').allInnerTexts()).map((t) => t.replace('(has problems)', '').trim());
}

test('owners and editors see every tab, and no "Show model inputs"', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Tabs for modellers');
	const editor = await signIn('Tabs editor');
	await addMember(page.request, project.id, editor.user.email, 'editor');

	for (const p of [page, editor.page]) {
		await p.goto(`/projects/${project.id}`);
		await expect.poll(() => tabNames(p)).toEqual(EVERY_TAB);
		await expect(toggle(p)).toHaveCount(0);
		// Every checklist step links to its tab.
		await expect(setup(p).getByRole('link')).toHaveCount(5);
	}
});

test('a viewer sees the short tab set and turns on "Show model inputs"', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Tabs for a viewer');
	await putModel(page.request, project.id, sampleModel());
	const viewer = await signIn('Tabs viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;

	await v.goto(`/projects/${project.id}`);
	await expect.poll(() => tabNames(v)).toEqual(SHORT);
	await expect(toggle(v)).not.toBeChecked();

	// The checklist links only to tabs the strip shows; the rest keep their status.
	const steps = setup(v);
	await expect(steps.getByRole('link', { name: 'Rainfall & flow data' })).toBeVisible();
	await expect(steps.getByRole('link', { name: 'Run the model' })).toBeVisible();
	await expect(steps.getByText('River network', { exact: true })).toBeVisible();
	await expect(steps.getByRole('link', { name: 'River network' })).toHaveCount(0);
	await expect(steps.getByRole('link', { name: 'Crops & irrigated areas' })).toHaveCount(0);
	await expect(steps.getByRole('link', { name: 'Evaporation, calibration & EWR' })).toHaveCount(0);
	await expectNoViolations(v);

	await toggle(v).check();
	await expect.poll(() => tabNames(v)).toEqual(EVERY_TAB);
	await expect(steps.getByRole('link')).toHaveCount(5);

	// A model tab opens read-only from the strip.
	await strip(v).getByRole('link', { name: 'Network' }).click();
	await expect(v).toHaveURL(/\?tab=network$/);
	await expect(v.getByText('You have view-only access to this project.')).toBeVisible();
	await expect(v.getByRole('textbox', { name: 'Name' }).first()).not.toBeEditable();

	// Turning it off hides the inputs again, but the open tab stays in the strip.
	await toggle(v).uncheck();
	await expect.poll(() => tabNames(v)).toEqual(['Overview', 'Network', 'Data', 'Runs & results', 'Scenarios', 'Allocations']);
	await expect(strip(v).getByRole('link', { name: 'Network' })).toHaveAttribute('aria-current', 'page');
	await strip(v).getByRole('link', { name: 'Overview' }).click();
	await expect.poll(() => tabNames(v)).toEqual(SHORT);
});

test('a deep link to a hidden tab still opens it for a viewer', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Tabs deep link');
	const viewer = await signIn('Deep link viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;

	await v.goto(`/projects/${project.id}?tab=settings`);
	await expect(v.getByLabel('A-pan evaporation, Oct, mm')).not.toBeEditable();
	await expect(toggle(v)).not.toBeChecked();
	// The open tab shows in the strip, in its place, and names the tab body.
	await expect.poll(() => tabNames(v)).toEqual(['Overview', 'Data', 'Settings & calibration', 'Runs & results', 'Scenarios', 'Allocations']);
	const current = strip(v).getByRole('link', { name: 'Settings & calibration' });
	await expect(current).toHaveAttribute('aria-current', 'page');
	await expect(v.getByRole('region', { name: 'Settings & calibration', exact: true })).toBeVisible();

	// An alias works the same way.
	await v.goto(`/projects/${project.id}?tab=demand`);
	await expect(strip(v).getByRole('link', { name: 'Crops & demand' })).toHaveAttribute('aria-current', 'page');

	// Arrow keys move through the strip as shown.
	await v.goto(`/projects/${project.id}?tab=series`);
	await strip(v).getByRole('link', { name: 'Data' }).focus();
	await v.keyboard.press('ArrowRight');
	await expect(v).toHaveURL(/\?tab=runs$/);
	await expect(strip(v).getByRole('link', { name: 'Runs & results' })).toBeFocused();
});
