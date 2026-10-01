// Settings › Drought restrictions (engine 1.54.0, WP-3.8, docs/ui.md §
// Drought restrictions): the model's restriction rule. Off by default;
// switching it on starts from the three-level template; an editor changes a
// cut, removes a level and adds a review date, the save stores the rule
// whole, a rule the engine refuses blocks the save, and switching it off
// saves null. A viewer reads the rule, disabled. Axe on the section at desktop
// and phone width, where the level cards stack with no sideways scroll.
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject } from '../support/api.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

async function savedRule(page: import('@playwright/test').Page, projectId: string): Promise<unknown> {
	const res = await page.request.get(`${API_URL}/projects/${projectId}`);
	expect(res.status()).toBe(200);
	const body = (await res.json()) as { project: { settings: { droughtRestriction?: unknown } } };
	return body.project.settings.droughtRestriction ?? null;
}

test('an editor switches drought restrictions on from the template, edits and saves the rule whole, a viewer reads it, and switching off saves null', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Drought restrictions');
	await page.goto(`/projects/${project.id}?tab=settings`);

	const section = page.getByRole('region', { name: /^Drought restrictions/ });
	const on = section.getByLabel('Apply drought restrictions in runs');
	await expect(on).not.toBeChecked();
	await expect(section.getByTestId('restriction-levels')).toHaveCount(0);

	// On: the template's three levels, reviewed on 1 October and 1 January, lifted on 1 May.
	await on.check();
	const levels = section.getByTestId('restriction-level');
	await expect(levels.locator('legend')).toHaveText(['Level 1', 'Level 2', 'Level 3']);
	await expect(section.getByTestId('restriction-template')).toBeVisible();
	await expect(section.getByLabel('Level 1: starts below, % of capacity')).toHaveValue('60');
	await expect(section.getByLabel('Level 1: cut on Crops (irrigation of the crop areas), %')).toHaveValue('20');
	await expect(section.getByTestId('restriction-words')).toContainText('reviewed 1 Oct, 1 Jan, lifted 1 May; Level 1 (below 60 %): crops 20 %');
	await expectNoViolations(page, { include: '#set-restrict' });
	// At phone width the cards stack, one level under the other, and nothing scrolls sideways.
	await page.setViewportSize({ width: 390, height: 844 });
	await section.scrollIntoViewIfNeeded();
	const [a, b] = [await levels.nth(0).boundingBox(), await levels.nth(1).boundingBox()];
	expect(b!.y).toBeGreaterThan(a!.y + a!.height - 1);
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page, { include: '#set-restrict' });
	await page.setViewportSize({ width: 1280, height: 900 });

	// A cut a deeper level undercuts blocks the save, with the engine's words.
	await section.getByLabel('Level 2: cut on Crops (irrigation of the crop areas), %').fill('10');
	await section.getByLabel('Level 2: cut on Crops (irrigation of the crop areas), %').blur();
	await expect(section.getByTestId('restriction-error')).toHaveText(/^Level 2: level 2 cuts crops less than level 1/);
	await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled();
	await section.getByLabel('Level 2: cut on Crops (irrigation of the crop areas), %').fill('45');
	await section.getByLabel('Level 2: cut on Crops (irrigation of the crop areas), %').blur();
	await expect(section.getByTestId('restriction-error')).toHaveCount(0);

	// Remove the deepest level, and add a third review date (1 February: the first month without one).
	await section.getByRole('button', { name: 'Remove the deepest level' }).click();
	await expect(levels.locator('legend')).toHaveText(['Level 1', 'Level 2']);
	await section.getByRole('button', { name: 'Add a review date' }).click();
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();

	expect(await savedRule(page, project.id)).toEqual({
		reviewDates: ['10-01', '01-01', '02-01'],
		liftDates: ['05-01'],
		levels: [
			{ label: 'Level 1', belowPct: 0.6, cuts: { crops: 0.2, irrigation: 0.2, domestic: 0.1, municipal: 0.1 } },
			{ label: 'Level 2', belowPct: 0.4, cuts: { crops: 0.45, irrigation: 0.4, domestic: 0.2, municipal: 0.2 } }
		]
	});
	await page.reload();
	await expect(on).toBeChecked();
	await expect(section.getByLabel('Level 2: cut on Crops (irrigation of the crop areas), %')).toHaveValue('45');

	// A viewer reads the rule but can't change it.
	const viewer = await signIn('Restriction viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=settings`);
	const seen = viewer.page.getByRole('region', { name: /^Drought restrictions/ });
	await expect(seen.getByTestId('restriction-words')).toContainText('Level 2 (below 40 %): crops 45 %');
	await expect(seen.getByLabel('Apply drought restrictions in runs')).toBeDisabled();
	await expect(seen.getByRole('button', { name: 'Add a deeper level' })).toHaveCount(0);

	// Off: the save sends null.
	await on.uncheck();
	await expect(section.getByTestId('restriction-levels')).toHaveCount(0);
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
	expect(await savedRule(page, project.id)).toBeNull();
});
