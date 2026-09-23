import type { Locator, Page } from '@playwright/test';
import { createProject, putModel, sampleModel } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

// Every sampled point inside the bubble hits the bubble itself: nothing (a
// sticky table header, a scroll container's edge) covers or clips it.
async function expectOnTop(page: Page, bubble: Locator) {
	const box = await bubble.boundingBox();
	expect(box).not.toBeNull();
	const vp = page.viewportSize()!;
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.y).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
	expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height);
	const covered = await bubble.evaluate((el) => {
		const r = el.getBoundingClientRect();
		const pts = [
			[r.left + 4, r.top + 4],
			[r.right - 4, r.top + 4],
			[r.left + 4, r.bottom - 4],
			[r.right - 4, r.bottom - 4],
			[r.left + r.width / 2, r.top + r.height / 2]
		];
		return pts.filter(([x, y]) => !el.contains(document.elementFromPoint(x, y)));
	});
	expect(covered).toEqual([]);
}

test('a help tip in the network table opens on top, unclipped, and closes on Escape or outside click', async ({
	page,
	owner
}) => {
	void owner;
	await page.setViewportSize({ width: 900, height: 700 });
	const project = await createProject(page.request, 'Help tips');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=network`);

	const tip = page.getByRole('columnheader', { name: /^Kind/ }).getByRole('button');
	const bubble = page.locator('.bubble:popover-open');

	await tip.click();
	await expect(tip).toHaveAttribute('aria-expanded', 'true');
	await expect(bubble).toBeVisible();
	await expect(bubble.getByRole('link', { name: 'More in the glossary' })).toBeVisible();
	await expectOnTop(page, bubble);

	await page.keyboard.press('Escape');
	await expect(bubble).toHaveCount(0);
	await expect(tip).toHaveAttribute('aria-expanded', 'false');
	await expect(tip).toBeFocused();

	await tip.click();
	await expect(bubble).toBeVisible();
	await page.getByRole('heading', { level: 1, name: 'Help tips' }).click();
	await expect(bubble).toHaveCount(0);
});
