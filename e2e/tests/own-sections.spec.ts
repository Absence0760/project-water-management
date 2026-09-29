// Members choose their own sections (followups.md, "Members choose their own
// tabs"; docs/ui.md § Sections by role; lib/workspace/tabs.ts visibleTabs,
// workspace/SectionsMenu.svelte): each person hides the workspace sections
// they don't use from their sidebar, within what their role sees. The Summary
// always stays, a hidden section still opens from a link, "Hidden (n)" brings
// them back, and the choice is the account's, so it holds after a reload and
// in another catchment. Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, putModel, sampleModel } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const nav = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });
const menuButton = (page: Page) => page.getByRole('button', { name: /^Choose sections/ });
const panel = (page: Page) => page.getByRole('dialog', { name: 'Sections in your sidebar' });

/** The sidebar's section names, in order (Data's link may carry its "behind" badge). */
async function sectionNames(page: Page) {
	await expect(nav(page).getByRole('link', { name: 'Summary' })).toBeVisible();
	return (await nav(page).getByRole('link').allInnerTexts()).map((t) => t.replace(/\s*\d+$/, '').trim());
}

const EVERY = ['Summary', 'River & reserve', 'Hydrological units', 'Runs & results', 'Dams', 'Compare runs', 'Scenarios', 'Allocations', 'Network', 'Crops & demand', 'Transfers', 'Data', 'Settings & calibration', 'Project', 'Applications', 'History'];

test.describe('1440×960', () => {
	test.use({ viewport: { width: 1440, height: 960 } });

	test('an owner hides two sections, keeps the choice, opens one from a link, and resets', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Own sections');
		const other = await createProject(page.request, 'Own sections, another catchment');
		await page.goto(`/projects/${project.id}`);
		await expect.poll(() => sectionNames(page)).toEqual(EVERY);
		await expect(menuButton(page)).toHaveAccessibleName('Choose sections');

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
		await expect(panel(page).getByRole('button', { name: 'Reset to default' })).toBeDisabled();
		await expectNoViolations(page);

		const saved = page.waitForResponse((r) => r.url().endsWith('/auth/me') && r.request().method() === 'PATCH');
		await panel(page).getByRole('checkbox', { name: 'Crops & demand' }).uncheck();
		await saved;
		const savedAgain = page.waitForResponse((r) => r.url().endsWith('/auth/me') && r.request().method() === 'PATCH');
		await panel(page).getByRole('checkbox', { name: 'History' }).uncheck();
		expect((await savedAgain).status()).toBe(200);

		const shorter = EVERY.filter((t) => t !== 'Crops & demand' && t !== 'History');
		await expect.poll(() => sectionNames(page)).toEqual(shorter);
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
		await expect.poll(() => sectionNames(page)).toEqual(shorter);
		await page.goto(`/projects/${other.id}`);
		await expect.poll(() => sectionNames(page)).toEqual(shorter);

		// A hidden section still opens from a link, and shows in its place while open.
		await page.goto(`/projects/${project.id}?tab=crops`);
		await expect(page.getByRole('heading', { level: 1, name: 'Crops & demand' })).toBeVisible();
		await expect(nav(page).getByRole('link', { name: 'Crops & demand' })).toHaveAttribute('aria-current', 'page');
		await expect.poll(() => sectionNames(page)).toEqual(EVERY.filter((t) => t !== 'History'));

		// "Hidden (2)" brings them back: one at a time, then all with Reset to default.
		await menuButton(page).click();
		await panel(page).getByRole('checkbox', { name: 'History' }).check();
		await expect(menuButton(page)).toHaveAccessibleName('Choose sections: Hidden (1)');
		await expect(nav(page).getByRole('link', { name: 'History' })).toBeVisible();
		await panel(page).getByRole('checkbox', { name: 'Transfers' }).uncheck();
		await expect(menuButton(page)).toHaveAccessibleName('Choose sections: Hidden (2)');
		const reset = page.waitForResponse((r) => r.url().endsWith('/auth/me') && r.request().method() === 'PATCH');
		await panel(page).getByRole('button', { name: 'Reset to default' }).click();
		await reset;
		await panel(page).getByRole('button', { name: 'Done' }).click();
		await expect(panel(page)).toBeHidden();
		await expect(menuButton(page)).toHaveAccessibleName('Choose sections');
		await page.reload();
		await expect.poll(() => sectionNames(page)).toEqual(EVERY);
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

		// Only the sections the role shows are offered: no model inputs, no Applications.
		await menuButton(v).click();
		await expect(panel(v).getByRole('checkbox', { name: 'Network' })).toHaveCount(0);
		await expect(panel(v).getByRole('checkbox', { name: 'Applications' })).toHaveCount(0);
		await panel(v).getByRole('checkbox', { name: 'Allocations' }).uncheck();
		await expect(nav(v).getByRole('link', { name: 'Allocations' })).toHaveCount(0);
		await expect(menuButton(v)).toHaveAccessibleName('Choose sections: Hidden (1)');

		// With the inputs shown, they join the menu, and one hidden stays hidden.
		await v.keyboard.press('Escape');
		await v.getByLabel('Show model inputs').check();
		await menuButton(v).click();
		await expect(panel(v).getByRole('checkbox', { name: 'Network' })).toBeChecked();
		await panel(v).getByRole('checkbox', { name: 'Transfers' }).uncheck();
		await expect(nav(v).getByRole('link', { name: 'Network' })).toBeVisible();
		await expect(nav(v).getByRole('link', { name: 'Transfers' })).toHaveCount(0);
		await expect(menuButton(v)).toHaveAccessibleName('Choose sections: Hidden (2)');
		// Turned off again, Transfers is out of what the role shows, so it isn't counted.
		await panel(v).getByRole('button', { name: 'Done' }).click();
		await v.getByLabel('Show model inputs').uncheck();
		await expect(menuButton(v)).toHaveAccessibleName('Choose sections: Hidden (1)');
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
		await expect(menuButton(page)).toHaveText('Choose sections');
		await menuButton(page).click();
		await panel(page).getByRole('checkbox', { name: 'Dams' }).uncheck();
		await expect(menuButton(page)).toHaveText('Choose sections: Hidden (1)');
		await expect(nav(page).getByRole('link', { name: 'Dams' })).toHaveCount(0);
		await expectNoViolations(page);
		// Escape closes only the dialog; the Sections menu it opened from stays open.
		await page.keyboard.press('Escape');
		await expect(panel(page)).toBeHidden();
		await expect(menuButton(page)).toBeFocused();
	});
});
