// Members choose their own sections (followups.md, "Members choose their own
// tabs"; docs/ui.md § Sections by role; lib/workspace/tabs.ts visibleTabs,
// workspace/SectionsMenu.svelte): each person hides the workspace sections
// they don't use from their sidebar, within what their role sees. The Summary
// always stays, a hidden section still opens from a link, "Hidden (n)" brings
// them back, and the choice is the account's, so it holds after a reload and
// in another catchment. Until a person chooses, History and Applications
// are hidden (DEFAULT_HIDDEN_TABS; Allocations shows since issue #444); Reset
// to default brings that default back, while showing every section is kept as a choice of its own.
// Synthetic data only.
import type { Page, Response } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, putModel, sampleModel } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const nav = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });
const menuButton = (page: Page) => page.getByRole('button', { name: /^Choose sections/ });
const panel = (page: Page) => page.getByRole('dialog', { name: 'Sections in your sidebar' });

/** The sidebar's section names, in order (Data's link may carry its "behind" badge). */
async function sectionNames(page: Page) {
	await expect(nav(page).getByRole('link', { name: 'Summary' })).toBeVisible();
	return (await nav(page).getByRole('link').allInnerTexts()).map((t) => t.replace(/\s*\d+$/, '').trim());
}

const EVERY = ['Project', 'Applications', 'History', 'Network', 'Map', 'Crops & demand', 'Transfers', 'Data', 'Settings & calibration', 'Summary', 'River & reserve', 'Hydrological units', 'Runs & results', 'Dams', 'Compare runs', 'Scenarios', 'Allocations'];
// Hidden until a person chooses their own sections (lib/workspace/tabs.ts DEFAULT_HIDDEN_TABS), and again after Reset to default.
const DEFAULT_HIDDEN = ['Applications', 'History'];
const DEFAULTS = EVERY.filter((t) => !DEFAULT_HIDDEN.includes(t));
const without = (...names: string[]) => EVERY.filter((t) => !names.includes(t));

/** The next PATCH /auth/me the page sends. */
const nextSave = (page: Page) => page.waitForResponse((r) => r.url().endsWith('/auth/me') && r.request().method() === 'PATCH');
/** The hiddenTabs a PATCH /auth/me sent. */
const sent = async (res: Promise<Response>) => ((await res).request().postDataJSON() as { preferences: { hiddenTabs: string[] | null } }).preferences.hiddenTabs;
/** The account's stored choice, as GET /auth/me returns it. */
const storedChoice = async (page: Page) =>
	((await (await page.request.get(`${API_URL}/auth/me`)).json()) as { user: { preferences: { hiddenTabs: string[] | null } } }).user.preferences.hiddenTabs;

test.describe('1440×960', () => {
	test.use({ viewport: { width: 1440, height: 960 } });

	test('an owner starts from the default, hides and shows sections, keeps the choice, opens one from a link, and resets to the default', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Own sections');
		const other = await createProject(page.request, 'Own sections, another catchment');
		await page.goto(`/projects/${project.id}`);
		// No choice of their own yet: History and Applications are hidden, and counted (Allocations shows, issue #444).
		await expect.poll(() => sectionNames(page)).toEqual(DEFAULTS);
		await expect(menuButton(page)).toHaveAccessibleName('Choose sections: Hidden (2)');
		expect(await storedChoice(page)).toBeNull();

		await menuButton(page).click();
		await expect(panel(page)).toBeVisible();
		// It opens right beside its button, not across the screen.
		const b = (await menuButton(page).boundingBox())!;
		const d = (await panel(page).boundingBox())!;
		expect(d.x - (b.x + b.width)).toBeCloseTo(8, 0);
		expect(d.y).toBeCloseTo(b.y, 0);
		// The Summary can't be hidden.
		const summary = panel(page).getByRole('checkbox', { name: /^Summary/ });
		await expect(summary).toBeChecked();
		await expect(summary).toBeDisabled();
		for (const name of DEFAULT_HIDDEN) await expect(panel(page).getByRole('checkbox', { name })).not.toBeChecked();
		await expect(panel(page).getByRole('checkbox', { name: 'Dams' })).toBeChecked();
		// A section hidden by default says what it is for, so ticking it isn't a guess.
		await expect(panel(page).getByRole('checkbox', { name: /^Applications water-use licence applications to assess and decide$/ })).toBeVisible();
		// Nothing of their own to undo yet.
		await expect(panel(page).getByRole('button', { name: 'Reset to default' })).toBeDisabled();
		await expectNoViolations(page);

		// The first choice starts from the default.
		const saved = nextSave(page);
		await panel(page).getByRole('checkbox', { name: 'Crops & demand' }).uncheck();
		expect(await sent(saved)).toEqual(['applications', 'history', 'crops']);
		const savedAgain = nextSave(page);
		await panel(page).getByRole('checkbox', { name: 'History' }).check();
		expect((await savedAgain).status()).toBe(200);
		expect(await sent(savedAgain)).toEqual(['applications', 'crops']);
		await expect(panel(page).getByRole('button', { name: 'Reset to default' })).toBeEnabled();

		const mine = without('Applications', 'Crops & demand');
		await expect.poll(() => sectionNames(page)).toEqual(mine);
		await expect(menuButton(page)).toHaveAccessibleName('Choose sections: Hidden (2)');
		// The sidebar shows the icon and a count, and the button stays on the head's line beside the role
		// badge ("Hidden (2)" in words wrapped it onto a line of its own).
		await expect(menuButton(page).locator('.count')).toHaveText('2');
		await expect(menuButton(page).getByText('Hidden (2)')).toHaveClass(/visually-hidden/);
		const badge = (await page.getByTestId('project-role').boundingBox())!;
		const btn = (await menuButton(page).boundingBox())!;
		expect(Math.abs(btn.y + btn.height / 2 - (badge.y + badge.height / 2))).toBeLessThan(4);
		expect(btn.width).toBeCloseTo(24, 0);
		// Escape closes the dialog, back on its button.
		await page.keyboard.press('Escape');
		await expect(panel(page)).toBeHidden();
		await expect(menuButton(page)).toBeFocused();

		// The account keeps it: after a reload, and in another catchment.
		await page.reload();
		await expect.poll(() => sectionNames(page)).toEqual(mine);
		await page.goto(`/projects/${other.id}`);
		await expect.poll(() => sectionNames(page)).toEqual(mine);

		// A hidden section still opens from a link, and shows in its place while open.
		await page.goto(`/projects/${project.id}?tab=crops`);
		await expect(page.getByRole('heading', { level: 1, name: 'Crops & demand' })).toBeVisible();
		await expect(nav(page).getByRole('link', { name: 'Crops & demand' })).toHaveAttribute('aria-current', 'page');
		await expect.poll(() => sectionNames(page)).toEqual(without('Applications'));

		// "Hidden (n)" brings them back one at a time; more can go.
		// Each click's save is awaited before the next nextSave() listens: the saves go one after another
		// (SectionsMenu.svelte save()), so an unawaited one could land after Reset's listener and be taken for it.
		await menuButton(page).click();
		const shown = nextSave(page);
		await panel(page).getByRole('checkbox', { name: 'Applications' }).check();
		await expect(menuButton(page)).toHaveAccessibleName('Choose sections: Hidden (1)');
		await expect(nav(page).getByRole('link', { name: 'Applications' })).toBeVisible();
		expect(await sent(shown)).toEqual(['crops']);
		const hid = nextSave(page);
		await panel(page).getByRole('checkbox', { name: 'Transfers' }).uncheck();
		await expect(menuButton(page)).toHaveAccessibleName('Choose sections: Hidden (2)');
		await expect(nav(page).getByRole('link', { name: 'Transfers' })).toHaveCount(0);
		expect(await sent(hid)).toEqual(['crops', 'transfers']);

		// Reset to default forgets the choice: the default two are hidden again, not every section shown.
		const reset = nextSave(page);
		await panel(page).getByRole('button', { name: 'Reset to default' }).click();
		expect(await sent(reset)).toBeNull();
		await expect(panel(page).getByRole('button', { name: 'Reset to default' })).toBeDisabled();
		for (const name of DEFAULT_HIDDEN) await expect(panel(page).getByRole('checkbox', { name })).not.toBeChecked();
		await expect(panel(page).getByRole('checkbox', { name: 'Transfers' })).toBeChecked();
		await panel(page).getByRole('button', { name: 'Done' }).click();
		await expect(panel(page)).toBeHidden();
		await expect(menuButton(page)).toHaveAccessibleName('Choose sections: Hidden (2)');
		expect(await storedChoice(page)).toBeNull();
		await page.reload();
		// Crops & demand is open, and in the default anyway.
		await expect.poll(() => sectionNames(page)).toEqual(DEFAULTS);
	});

	test('an owner who shows every section keeps that as their own choice, and Reset to default hides the default ones again', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Own sections, all shown');
		await page.goto(`/projects/${project.id}`);
		await expect.poll(() => sectionNames(page)).toEqual(DEFAULTS);

		await menuButton(page).click();
		for (const name of DEFAULT_HIDDEN) {
			const save = nextSave(page);
			await panel(page).getByRole('checkbox', { name }).check();
			await save;
		}
		await expect(menuButton(page)).toHaveAccessibleName('Choose sections');
		await expect.poll(() => sectionNames(page)).toEqual(EVERY);
		// Showing everything is a choice of its own ([]), unlike the default (null), so Reset has something to undo.
		expect(await storedChoice(page)).toEqual([]);
		await expect(panel(page).getByRole('button', { name: 'Reset to default' })).toBeEnabled();
		await page.keyboard.press('Escape');

		// It survives a reload: every section, nothing counted as hidden.
		await page.reload();
		await expect.poll(() => sectionNames(page)).toEqual(EVERY);
		await expect(menuButton(page)).toHaveAccessibleName('Choose sections');

		await menuButton(page).click();
		const reset = nextSave(page);
		await panel(page).getByRole('button', { name: 'Reset to default' }).click();
		expect(await sent(reset)).toBeNull();
		await expect.poll(() => sectionNames(page)).toEqual(DEFAULTS);
		await expect(menuButton(page)).toHaveAccessibleName('Choose sections: Hidden (2)');
		await page.reload();
		await expect.poll(() => sectionNames(page)).toEqual(DEFAULTS);
	});

	test('a viewer chooses within what the role sees; the model inputs they hid stay hidden once shown', async ({ page, owner, signIn }) => {
		void owner;
		const project = await createProject(page.request, 'Own sections for a viewer');
		await putModel(page.request, project.id, sampleModel());
		const viewer = await signIn('Own sections viewer');
		await addMember(page.request, project.id, viewer.user.email, 'viewer');
		const v = viewer.page;
		await v.setViewportSize({ width: 1440, height: 960 });
		await v.goto(`/projects/${project.id}`);
		await expect(v.getByTestId('project-role')).toHaveText('viewer');
		// Of the default two, neither is in what the role shows, so nothing is counted, and Allocations shows (issue #444).
		await expect(menuButton(v)).toHaveAccessibleName('Choose sections');
		await expect(nav(v).getByRole('link', { name: 'Allocations' })).toBeVisible();

		// Only the sections the role shows are offered: no model inputs, no Applications.
		await menuButton(v).click();
		await expect(panel(v).getByRole('checkbox', { name: 'Network' })).toHaveCount(0);
		await expect(panel(v).getByRole('checkbox', { name: 'Applications' })).toHaveCount(0);
		await expect(panel(v).getByRole('checkbox', { name: 'History' })).toHaveCount(0);
		await panel(v).getByRole('checkbox', { name: 'Allocations' }).uncheck();
		await expect(nav(v).getByRole('link', { name: 'Allocations' })).toHaveCount(0);
		await expect(menuButton(v)).toHaveAccessibleName('Choose sections: Hidden (1)');
		await panel(v).getByRole('checkbox', { name: 'Dams' }).uncheck();
		await expect(nav(v).getByRole('link', { name: 'Dams' })).toHaveCount(0);
		await expect(menuButton(v)).toHaveAccessibleName('Choose sections: Hidden (2)');

		// With the inputs shown, they join the menu; History, hidden by the default the choice started from,
		// stays hidden, and so does one they hide now.
		await v.keyboard.press('Escape');
		await v.getByLabel('Show model inputs').check();
		await menuButton(v).click();
		await expect(panel(v).getByRole('checkbox', { name: 'Network' })).toBeChecked();
		await expect(panel(v).getByRole('checkbox', { name: 'History' })).not.toBeChecked();
		await expect(menuButton(v)).toHaveAccessibleName('Choose sections: Hidden (3)');
		await panel(v).getByRole('checkbox', { name: 'Transfers' }).uncheck();
		await expect(nav(v).getByRole('link', { name: 'Network' })).toBeVisible();
		await expect(nav(v).getByRole('link', { name: 'Transfers' })).toHaveCount(0);
		await expect(nav(v).getByRole('link', { name: 'History' })).toHaveCount(0);
		await expect(menuButton(v)).toHaveAccessibleName('Choose sections: Hidden (4)');
		// Turned off again, Transfers and History are out of what the role shows, so they aren't counted.
		await panel(v).getByRole('button', { name: 'Done' }).click();
		await v.getByLabel('Show model inputs').uncheck();
		await expect(menuButton(v)).toHaveAccessibleName('Choose sections: Hidden (2)');
		await expectNoViolations(v);
	});
});

test.describe('390×844', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('the phone menu offers the same choice, in words', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Own sections on a phone');
		await page.goto(`/projects/${project.id}`);
		await page.getByRole('button', { name: /^Project sections:/ }).click();
		// The default two hidden, said in words here.
		await expect(menuButton(page)).toHaveText('Choose sections: Hidden (2)');
		await menuButton(page).click();
		await panel(page).getByRole('checkbox', { name: 'Dams' }).uncheck();
		await expect(menuButton(page)).toHaveText('Choose sections: Hidden (3)');
		await expect(nav(page).getByRole('link', { name: 'Dams' })).toHaveCount(0);
		await expectNoViolations(page);
		// Escape closes only the dialog; the Sections menu it opened from stays open.
		await page.keyboard.press('Escape');
		await expect(panel(page)).toBeHidden();
		await expect(menuButton(page)).toBeFocused();
	});
});
