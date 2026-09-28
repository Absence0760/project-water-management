// The app sidebar's height (issue #17, option A; docs/ui.md § App frame):
// with a project open, every section an owner sees fits a 1440×960 window
// with the account block at the foot in view and room for one more row. On a
// shorter window the project's sections scroll inside the sidebar on their
// own, so the account block still never leaves the screen, and the open
// section is scrolled into view. Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

// Long enough to wrap to two lines in the sidebar (the name is clamped to two).
const LONG_NAME = 'Upper Catchment Irrigation Board Demonstration Sidebar';
const OWNER_TABS = [
	'Network',
	'Crops & demand',
	'Transfers',
	'Data',
	'Settings & calibration',
	'Project',
	'Applications',
	'History',
	'Summary',
	'River & reserve',
	'Hydrological units',
	'Runs & results',
	'Dams',
	'Compare runs',
	'Scenarios',
	'Allocations'
];
/** One sidebar row (the rows are 34 px): the room left for one more section. */
const ROW = 34;

const sidebar = (page: Page) => page.locator('aside.app-sidebar');
const nav = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });
const account = (page: Page) => sidebar(page).getByRole('button', { name: /^Account menu for / });

/** The sidebar and its project slot, measured: overflow in each, and the gap above the foot. */
function measure(page: Page) {
	return page.evaluate(() => {
		const aside = document.querySelector('aside.app-sidebar') as HTMLElement;
		const slot = aside.querySelector('.slot') as HTMLElement;
		const foot = aside.querySelector('.foot') as HTMLElement;
		const last = [...slot.querySelectorAll('a')].at(-1)!;
		return {
			asideOverflow: aside.scrollHeight - aside.clientHeight,
			slotOverflow: slot.scrollHeight - slot.clientHeight,
			spare: foot.getBoundingClientRect().top - last.getBoundingClientRect().bottom
		};
	});
}

test.describe('1440×960', () => {
	test.use({ viewport: { width: 1440, height: 960 } });

	test('an owner: every section and the account block fit, with room for one more row', async ({ page, owner }) => {
		void owner;
		const project = await seedRunnableProject(page.request, LONG_NAME);
		await page.goto(`/projects/${project.id}?tab=river`);
		await expect(page.getByRole('heading', { level: 1, name: 'River & reserve' })).toBeVisible();

		// Data's link also carries its "series behind" badge, so match each label at the start.
		const links = nav(page).getByRole('link');
		await expect(links).toHaveText(OWNER_TABS.map((t) => new RegExp(`^${t}`)));
		for (const link of await links.all()) await expect(link).toBeInViewport({ ratio: 1 });
		await expect(account(page)).toBeInViewport({ ratio: 1 });
		// The name is clamped visually, not cut: its full text is still the link's name and tooltip.
		await expect(page.getByTestId('project-name')).toHaveText(LONG_NAME);
		await expect(page.getByTestId('project-name')).toHaveAttribute('title', LONG_NAME);

		const m = await measure(page);
		expect(m.asideOverflow).toBeLessThanOrEqual(0);
		expect(m.slotOverflow).toBeLessThanOrEqual(0);
		expect(m.spare).toBeGreaterThanOrEqual(ROW);
		await expectNoViolations(page);

		// The account menu still opens upward from the foot, inside the window.
		await account(page).click();
		await expect(sidebar(page).getByRole('link', { name: /^Account/ })).toBeInViewport({ ratio: 1 });
		await page.keyboard.press('Escape');
	});

	test('a viewer with the model inputs shown: still fits', async ({ page, owner, signIn }) => {
		void owner;
		const project = await seedRunnableProject(page.request, LONG_NAME);
		const viewer = await signIn('Sidebar viewer');
		await addMember(page.request, project.id, viewer.user.email, 'viewer');
		const v = viewer.page;
		await v.setViewportSize({ width: 1440, height: 960 });
		await v.goto(`/projects/${project.id}`);
		await expect(v.getByTestId('project-role')).toHaveText('viewer');
		await sidebar(v).getByLabel('Show model inputs').check();
		await expect(nav(v).getByRole('link', { name: 'Network' })).toBeVisible();
		await expect(account(v)).toBeInViewport({ ratio: 1 });
		const m = await measure(v);
		expect(m.asideOverflow).toBeLessThanOrEqual(0);
		expect(m.slotOverflow).toBeLessThanOrEqual(0);
		await expectNoViolations(v);
	});
});

test.describe('1280×800', () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test('the sections scroll on their own; the account block and the open section stay in view', async ({ page, owner }) => {
		void owner;
		const project = await seedRunnableProject(page.request, LONG_NAME);
		await page.goto(`/projects/${project.id}?tab=history`);
		await expect(page.getByRole('heading', { level: 1, name: 'History' })).toBeVisible();

		// The whole sidebar never scrolls; its account block is in the window.
		const m = await measure(page);
		expect(m.asideOverflow).toBeLessThanOrEqual(0);
		await expect(account(page)).toBeInViewport({ ratio: 1 });
		await expect(sidebar(page).getByRole('link', { name: 'Projects', exact: true })).toBeInViewport({ ratio: 1 });
		// The open section, last in the list, is scrolled into view in the slot.
		await expect(nav(page).getByRole('link', { name: 'History' })).toBeInViewport({ ratio: 1 });
		await expectNoViolations(page);

		// Arrow keys wrap to the first section, which comes into view with focus.
		await nav(page).getByRole('link', { name: 'History' }).focus();
		await page.keyboard.press('ArrowDown');
		await expect(page.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible();
		const summary = nav(page).getByRole('link', { name: 'Summary' });
		await expect(summary).toBeFocused();
		await expect(summary).toBeInViewport({ ratio: 1 });
		await expect(account(page)).toBeInViewport({ ratio: 1 });
	});
});

test.describe('phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('no sidebar: the sections sit behind the Sections button, with no sideways scroll', async ({ page, owner }) => {
		void owner;
		const project = await seedRunnableProject(page.request, LONG_NAME);
		await page.goto(`/projects/${project.id}`);
		await expect(page.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible();
		await expect(sidebar(page)).toHaveCount(0);
		const toggle = page.getByRole('button', { name: /^Project sections: Summary/ });
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-expanded', 'true');
		await expect(nav(page)).toHaveCount(1);
		await expect(nav(page).getByRole('link', { name: 'History' })).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
		await expectNoViolations(page);
	});
});
