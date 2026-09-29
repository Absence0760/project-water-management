// Tabs by role (issue #6, docs/ui.md § Tabs by role, lib/workspace/tabs.ts):
// owners and editors see every tab; a viewer sees Overview, Data and Runs &
// results, with the model inputs behind "Show model inputs". Presentation
// only: a deep link to a hidden tab still opens it. On top of the role, History,
// Allocations and Applications are hidden until a person chooses their own
// sections (DEFAULT_HIDDEN_TABS; own-sections.spec.ts), so the role's full set
// is checked with every section shown. Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, putModel, sampleModel, showAllSections } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { closeModal, openNodeTable } from '../support/network.ts';

const strip = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });
const setup = (page: Page) => page.getByRole('region', { name: 'Set up this catchment' });
const toggle = (page: Page) => page.getByLabel('Show model inputs');

// Applications (WP-3.3) is the assessors' list: owners and editors only, never a viewer.
// In sidebar order: Outcomes, Build the model, Review (issue #162: the Summary a project opens on is at the top; lib/workspace/tabs.ts NAV_SECTIONS).
const EVERY_TAB = ['Summary', 'River & reserve', 'Hydrological units', 'Runs & results', 'Dams', 'Compare runs', 'Scenarios', 'Allocations', 'Network', 'Crops & demand', 'Transfers', 'Data', 'Settings & calibration', 'Project', 'Applications', 'History'];
const VIEWER_ALL = EVERY_TAB.filter((t) => t !== 'Applications');
const SHORT = ['Summary', 'River & reserve', 'Hydrological units', 'Runs & results', 'Dams', 'Compare runs', 'Scenarios', 'Allocations', 'Data', 'Project'];
// What each shows by default: the role's set less the sections hidden until chosen.
const DEFAULT_HIDDEN = ['Allocations', 'Applications', 'History'];
const byDefault = (tabs: string[]) => tabs.filter((t) => !DEFAULT_HIDDEN.includes(t));

/** The strip's tab names, in order. */
async function tabNames(page: Page) {
	await expect(strip(page).getByRole('link', { name: 'Summary' })).toBeVisible();
	return (await strip(page).getByRole('link').allInnerTexts()).map((t) => t.replace('(has problems)', '').trim());
}

test('owners and editors see every tab, and no "Show model inputs"', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Tabs for modellers');
	const editor = await signIn('Tabs editor');
	await addMember(page.request, project.id, editor.user.email, 'editor');

	for (const p of [page, editor.page]) {
		await p.goto(`/projects/${project.id}`);
		await expect.poll(() => tabNames(p)).toEqual(byDefault(EVERY_TAB));
		await expect(strip(p).getByRole('group', { name: 'Review' }).getByRole('link')).toHaveText(['Project']);
		await expect(toggle(p)).toHaveCount(0);

		// With every section shown, the role's whole set, grouped into named sections.
		await showAllSections(p.request);
		await p.reload();
		await expect.poll(() => tabNames(p)).toEqual(EVERY_TAB);
		await expect(strip(p).getByRole('group', { name: 'Outcomes' }).getByRole('link')).toHaveText(EVERY_TAB.slice(0, 8));
		await expect(strip(p).getByRole('group', { name: 'Build the model' }).getByRole('link')).toHaveText(EVERY_TAB.slice(8, 13));
		await expect(strip(p).getByRole('group', { name: 'Review' }).getByRole('link')).toHaveText(['Project', 'Applications', 'History']);
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
	await expect.poll(() => tabNames(v)).toEqual(byDefault(SHORT));
	await expect(toggle(v)).not.toBeChecked();
	// With every section shown, the role's short set.
	await showAllSections(v.request);
	await v.reload();
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
	await expect.poll(() => tabNames(v)).toEqual(VIEWER_ALL);
	await expect(steps.getByRole('link')).toHaveCount(5);

	// A model tab opens read-only from the strip.
	await strip(v).getByRole('link', { name: 'Network' }).click();
	await expect(v).toHaveURL(/\?tab=network$/);
	await expect(v.getByText('You have view-only access to this project.')).toBeVisible();
	await openNodeTable(v);
	await expect(v.getByRole('textbox', { name: 'Name' }).first()).not.toBeEditable();
	await closeModal(v);

	// Turning it off hides the inputs again, but the open tab stays in the strip.
	await toggle(v).uncheck();
	await expect.poll(() => tabNames(v)).toEqual(['Summary', 'River & reserve', 'Hydrological units', 'Runs & results', 'Dams', 'Compare runs', 'Scenarios', 'Allocations', 'Network', 'Data', 'Project']);
	await expect(strip(v).getByRole('link', { name: 'Network' })).toHaveAttribute('aria-current', 'page');
	await strip(v).getByRole('link', { name: 'Summary' }).click();
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
	// The open tab shows in the strip, in its place, and names the tab body (Allocations is hidden by default).
	await expect.poll(() => tabNames(v)).toEqual(['Summary', 'River & reserve', 'Hydrological units', 'Runs & results', 'Dams', 'Compare runs', 'Scenarios', 'Data', 'Settings & calibration', 'Project']);
	const current = strip(v).getByRole('link', { name: 'Settings & calibration' });
	await expect(current).toHaveAttribute('aria-current', 'page');
	await expect(v.getByRole('region', { name: 'Settings & calibration', exact: true })).toBeVisible();

	// An alias works the same way.
	await v.goto(`/projects/${project.id}?tab=demand`);
	await expect(strip(v).getByRole('link', { name: 'Crops & demand' })).toHaveAttribute('aria-current', 'page');

	// Arrow keys move through the tabs as shown (skipping the hidden Allocations), across sections, and wrap.
	await v.goto(`/projects/${project.id}?tab=series`);
	await strip(v).getByRole('link', { name: 'Data' }).focus();
	await v.keyboard.press('ArrowLeft');
	await expect(v).toHaveURL(/\?tab=scenarios$/);
	await expect(strip(v).getByRole('link', { name: 'Scenarios' })).toBeFocused();
	await v.keyboard.press('ArrowDown');
	await expect(v).toHaveURL(/\?tab=series$/);
	await expect(strip(v).getByRole('link', { name: 'Data' })).toBeFocused();
	await v.keyboard.press('ArrowRight');
	await expect(v).toHaveURL(/\?tab=project$/);
	await expect(strip(v).getByRole('link', { name: 'Project', exact: true })).toBeFocused();
	await v.keyboard.press('ArrowRight');
	await expect(v).not.toHaveURL(/\?tab=/);
	await expect(strip(v).getByRole('link', { name: 'Summary' })).toBeFocused();
});

test.describe('phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('the sections sit behind a "Sections" button naming the open tab', async ({ page, owner, signIn }) => {
		void owner;
		const project = await createProject(page.request, 'Tabs on a phone');
		await putModel(page.request, project.id, sampleModel());
		await page.goto(`/projects/${project.id}`);
		const button = page.getByRole('button', { name: 'Project sections: Summary' });
		await expect(button).toHaveAttribute('aria-expanded', 'false');
		await expect(strip(page)).toBeHidden();

		await button.click();
		await expect(button).toHaveAttribute('aria-expanded', 'true');
		await expect(strip(page).getByRole('group', { name: 'Outcomes' })).toBeVisible();
		await expect(strip(page).getByRole('group', { name: 'Build the model' })).toBeVisible();
		await expect(strip(page).getByRole('link', { name: 'Summary' })).toHaveAttribute('aria-current', 'page');
		await expect.poll(() => tabNames(page)).toEqual(byDefault(EVERY_TAB));
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
		await expectNoViolations(page);

		// Choosing a tab closes the menu and names the new one.
		await strip(page).getByRole('link', { name: 'Network' }).click();
		await expect(page).toHaveURL(/\?tab=network$/);
		const now = page.getByRole('button', { name: 'Project sections: Network' });
		await expect(now).toHaveAttribute('aria-expanded', 'false');
		await expect(strip(page)).toBeHidden();

		// Escape closes it and puts focus back on the button.
		await now.click();
		await strip(page).getByRole('link', { name: 'Data' }).focus();
		await page.keyboard.press('Escape');
		await expect(strip(page)).toBeHidden();
		await expect(now).toBeFocused();

		// A viewer's "Show model inputs" is inside the menu.
		const viewer = await signIn('Phone tabs viewer');
		await addMember(page.request, project.id, viewer.user.email, 'viewer');
		const v = viewer.page;
		await v.setViewportSize({ width: 390, height: 844 });
		await v.goto(`/projects/${project.id}`);
		await expect(toggle(v)).toBeHidden();
		await v.getByRole('button', { name: 'Project sections: Summary' }).click();
		await toggle(v).check();
		await expect.poll(() => tabNames(v)).toEqual(byDefault(VIEWER_ALL));
	});
});
