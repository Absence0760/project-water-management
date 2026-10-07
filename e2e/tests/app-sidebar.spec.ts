// The app sidebar's height (issue #17, option A; docs/ui.md § App frame):
// with a project open, every section an owner sees fits a 1440×960 window
// with the account block at the foot in view and room for one more row. On a
// shorter window the project's sections scroll inside the sidebar on their
// own, so the account block still never leaves the screen, and the open
// section is scrolled into view. The slot never scrolls sideways (the
// hidden-sections count badge once stuck out of it), and the model save bar
// starts at the sidebar's edge instead of covering its foot. Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, seedRunnableProject, showAllSections } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

// Long enough to wrap to two lines in the sidebar (the name is clamped to two).
const LONG_NAME = 'Upper Catchment Irrigation Board Demonstration Sidebar';
// Review first, then Build the model, then Outcomes (lib/workspace/tabs.ts NAV_SECTIONS).
const OWNER_TABS = [
	'Project',
	'Applications',
	'History',
	'Network',
	'Map',
	'Crops & demand',
	'Transfers',
	'Data',
	'Settings & calibration',
	'Summary',
	'River & reserve',
	'Hydrological units',
	'Runs & results',
	'Dams',
	'Compare runs',
	'Scenarios',
	'Allocations'
];
/** Hidden until a person chooses their own sections (lib/workspace/tabs.ts DEFAULT_HIDDEN_TABS). */
const DEFAULT_HIDDEN = ['Applications', 'History'];
/** One sidebar row (the rows are 32 px since the Map took the spare one, #326 D3): the room left for one more section. */
const ROW = 32;

const sidebar = (page: Page) => page.locator('aside.app-sidebar');
const nav = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });
const account = (page: Page) => sidebar(page).getByRole('button', { name: /^Account menu for / });

/** The sidebar and its project slot, measured: overflow in each (down, and sideways in the slot), and the gap above the foot. */
function measure(page: Page) {
	return page.evaluate(() => {
		const aside = document.querySelector('aside.app-sidebar') as HTMLElement;
		const slot = aside.querySelector('.slot') as HTMLElement;
		const foot = aside.querySelector('.foot') as HTMLElement;
		const last = [...slot.querySelectorAll('a')].at(-1)!;
		return {
			asideOverflow: aside.scrollHeight - aside.clientHeight,
			slotOverflow: slot.scrollHeight - slot.clientHeight,
			slotOverflowX: slot.scrollWidth - slot.clientWidth,
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
		// By default two sections are hidden (Allocations shows since issue #444).
		await expect(links).toHaveText(OWNER_TABS.filter((t) => !DEFAULT_HIDDEN.includes(t)).map((t) => new RegExp(`^${t}`)));
		await expect(page.getByRole('button', { name: 'Choose sections: Hidden (2)' })).toBeVisible();

		// The budget is for the worst case: every section shown.
		await showAllSections(page.request);
		await page.reload();
		await expect(page.getByRole('heading', { level: 1, name: 'River & reserve' })).toBeVisible();
		await expect(links).toHaveText(OWNER_TABS.map((t) => new RegExp(`^${t}`)));
		for (const link of await links.all()) await expect(link).toBeInViewport({ ratio: 1 });
		await expect(account(page)).toBeInViewport({ ratio: 1 });
		// The name is clamped visually, not cut: its full text is still the link's name and tooltip.
		await expect(page.getByTestId('project-name')).toHaveText(LONG_NAME);
		await expect(page.getByTestId('project-name')).toHaveAttribute('title', LONG_NAME);

		const m = await measure(page);
		expect(m.asideOverflow).toBeLessThanOrEqual(0);
		expect(m.slotOverflow).toBeLessThanOrEqual(0);
		expect(m.slotOverflowX).toBeLessThanOrEqual(0);
		expect(m.spare).toBeGreaterThanOrEqual(ROW);
		await expectNoViolations(page);

		// The account menu still opens upward from the foot, inside the window.
		await account(page).click();
		await expect(sidebar(page).getByRole('link', { name: /^Account/ })).toBeInViewport({ ratio: 1 });
		await page.keyboard.press('Escape');
	});

	test("the group titles read as Help's side panel's do", async ({ page, owner }) => {
		void owner;
		const project = await seedRunnableProject(page.request, LONG_NAME);
		const look = (selector: string) =>
			page.locator(selector).evaluateAll((els) =>
				els.map((el) => {
					const s = getComputedStyle(el);
					return [s.color, s.fontSize, s.fontWeight, s.letterSpacing, s.textTransform].join(' ');
				})
			);
		await page.goto('/help');
		await expect(page.getByRole('navigation', { name: 'Help' })).toBeVisible();
		// Each group's title is the button inside its heading (it opens and shuts the group): that carries the style.
		const help = await look('nav.help-nav .group button');
		expect(help.length).toBeGreaterThan(1);
		expect(new Set(help).size).toBe(1);

		await page.goto(`/projects/${project.id}`);
		await expect(nav(page).getByRole('group', { name: 'Outcomes' })).toBeVisible();
		// "Catchment" and each section's label (Outcomes, Build the model, Review).
		const titles = await look('aside.app-sidebar .side-kicker, aside.app-sidebar .section-label');
		expect(titles).toHaveLength(4);
		expect(titles).toEqual(titles.map(() => help[0]));
	});

	test('with sections hidden, the count badge keeps the slot from scrolling sideways', async ({ page, owner }) => {
		void owner;
		const project = await seedRunnableProject(page.request, LONG_NAME);
		const res = await page.request.patch(`${API_URL}/auth/me`, { data: { preferences: { hiddenTabs: ['crops', 'history'] } } });
		expect(res.status()).toBe(200);
		await page.goto(`/projects/${project.id}`);
		const trigger = page.getByRole('button', { name: 'Choose sections: Hidden (2)' });
		await expect(trigger).toBeVisible();
		const m = await measure(page);
		expect(m.slotOverflowX).toBeLessThanOrEqual(0);
		expect(m.slotOverflow).toBeLessThanOrEqual(0);
		// The count stays within its 24 px button, and the button on the head's line beside the role.
		const b = (await trigger.boundingBox())!;
		const c = (await trigger.locator('.count').boundingBox())!;
		expect(c.x + c.width).toBeLessThanOrEqual(b.x + b.width);
		const role = (await page.getByTestId('project-role').boundingBox())!;
		expect(Math.abs(b.y + b.height / 2 - (role.y + role.height / 2))).toBeLessThanOrEqual(2);
	});

	test('unsaved changes: the save bar starts at the sidebar edge and leaves the account menu usable', async ({ page, owner }) => {
		void owner;
		const project = await seedRunnableProject(page.request, LONG_NAME);
		await page.goto(`/projects/${project.id}?tab=project`);
		await page.getByLabel('Name', { exact: true }).fill('Renamed, not saved');
		const bar = page.getByRole('region', { name: 'Unsaved project details' });
		await expect(bar).toBeVisible();
		const barBox = (await bar.boundingBox())!;
		const side = (await sidebar(page).boundingBox())!;
		expect(barBox.x).toBeGreaterThanOrEqual(side.x + side.width);
		// The account menu at the sidebar's foot is in view and takes the click (nothing lies over it).
		await expect(account(page)).toBeInViewport({ ratio: 1 });
		await account(page).click();
		await expect(sidebar(page).getByRole('link', { name: /^Account/ })).toBeInViewport({ ratio: 1 });
		await page.keyboard.press('Escape');
		await expect(bar.getByRole('button', { name: 'Discard' })).toBeInViewport({ ratio: 1 });
	});

	test('a viewer with the model inputs shown: still fits', async ({ page, owner, signIn }) => {
		void owner;
		const project = await seedRunnableProject(page.request, LONG_NAME);
		const viewer = await signIn('Sidebar viewer');
		await addMember(page.request, project.id, viewer.user.email, 'viewer');
		const v = viewer.page;
		// Every section the role sees, not the default that hides some.
		await showAllSections(v.request);
		await v.setViewportSize({ width: 1440, height: 960 });
		await v.goto(`/projects/${project.id}`);
		await expect(v.getByTestId('project-role')).toHaveText('viewer');
		await sidebar(v).getByLabel('Show model inputs').check();
		await expect(nav(v).getByRole('link', { name: 'Network' })).toBeVisible();
		await expect(nav(v).getByRole('link', { name: 'History' })).toBeVisible();
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
		// Every section, so the list is at its longest and has to scroll.
		await showAllSections(page.request);
		await page.goto(`/projects/${project.id}?tab=allocations`);
		await expect(page.getByRole('heading', { level: 1, name: 'Allocations' })).toBeVisible();

		// The whole sidebar never scrolls; its account block is in the window.
		const m = await measure(page);
		expect(m.asideOverflow).toBeLessThanOrEqual(0);
		await expect(account(page)).toBeInViewport({ ratio: 1 });
		await expect(sidebar(page).getByRole('link', { name: 'Projects', exact: true })).toBeInViewport({ ratio: 1 });
		// The open section, last in the list, is scrolled into view in the slot.
		await expect(nav(page).getByRole('link', { name: 'Allocations' })).toBeInViewport({ ratio: 1 });
		await expectNoViolations(page);

		// Arrow keys wrap to the first section, which comes into view with focus.
		await nav(page).getByRole('link', { name: 'Allocations' }).focus();
		await page.keyboard.press('ArrowDown');
		await expect(page.getByRole('heading', { level: 1, name: 'Project' })).toBeVisible();
		const first = nav(page).getByRole('link', { name: 'Project', exact: true });
		await expect(first).toBeFocused();
		await expect(first).toBeInViewport({ ratio: 1 });
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
		// The last section by default (History, Applications and Allocations are hidden until chosen).
		await expect(nav(page).getByRole('link', { name: 'Project', exact: true })).toBeVisible();
		await expect(nav(page).getByRole('link', { name: 'History' })).toHaveCount(0);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
		await expectNoViolations(page);
	});
});
