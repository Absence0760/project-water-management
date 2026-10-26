// A fold's visible action word is part of its summary's accessible name
// (issue #586 R4-I, WCAG 2.5.3 Label in Name): common/Fold.svelte had it
// aria-hidden, so a voice-control user who said "click Change the limits"
// reached nothing. The word ends the name, so the name still starts with the
// group it opens: "Change…" while closed, "Hide" while open, "Show" for a
// viewer, who can change nothing inside. Shown on Model settings → Data
// quality's limits.
import type { Page } from '@playwright/test';
import { addMember, createProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openFold } from '../support/settings.ts';

const LINE = 'gauge/logger 66.7–150 % · outliers × 5 / × 10 · flat stretches 5–90 days · zero runs 60 wet-season days · low vs CHIRPS below 50 %';

async function limits(page: Page, projectId: string) {
	await page.goto(`/projects/${projectId}?tab=settings#set-quality`);
	const panel = page.getByTestId('data-quality-settings');
	const fold = panel.getByTestId('quality-limits');
	await expect(fold).toBeVisible();
	return { panel, fold, summary: fold.locator(':scope > summary') };
}

test('a fold’s summary is named with its visible action word: Change the limits, then Hide, and Show for a viewer', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Fold names');
	const { panel, fold, summary } = await limits(page, project.id);

	await expect(fold).not.toHaveAttribute('open');
	await expect(summary.locator('.fold-change')).toHaveText('Change the limits');
	await expect(summary).toHaveAccessibleName(`Default limits: ${LINE} Change the limits`);

	await openFold(panel, 'quality-limits');
	await expect(summary.locator('.fold-change')).toHaveText('Hide');
	await expect(summary).toHaveAccessibleName(`Default limits: ${LINE} Hide`);

	const viewer = await signIn('Fold names viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const seen = await limits(viewer.page, project.id);
	await expect(seen.summary.locator('.fold-change')).toHaveText('Show');
	await expect(seen.summary).toHaveAccessibleName(`Default limits: ${LINE} Show`);
});
