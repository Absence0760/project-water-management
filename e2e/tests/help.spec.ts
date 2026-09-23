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
		const pts: [number, number][] = [
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

test('the help contents stay on screen beside the text and follow the section being read', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/help');
	const toc = page.getByRole('navigation', { name: 'Topics' });
	const topics = page.getByRole('heading', { level: 2 });
	const first = (await topics.first().textContent())!.trim();
	const last = (await topics.last().textContent())!.trim();
	expect(first).not.toBe(last);

	await expect(toc.getByRole('link', { name: first, exact: true })).toHaveAttribute('aria-current', 'location');

	// Scroll to the end: the contents are still in view, and mark the last topic.
	await page.keyboard.press('End');
	await expect(toc.getByRole('link', { name: last, exact: true })).toHaveAttribute('aria-current', 'location');
	await expect(toc.getByRole('link', { name: first, exact: true })).not.toHaveAttribute('aria-current', 'location');
	const box = await toc.boundingBox();
	expect(box!.y).toBeGreaterThanOrEqual(0);
	expect(box!.y).toBeLessThan(200);

	// The current topic lists its terms, and a term link jumps to it.
	const term = toc.getByRole('list').getByRole('list').getByRole('link').first();
	const name = (await term.textContent())!.trim();
	await term.click();
	await expect(page.getByRole('article', { name })).toBeInViewport();
});

test('on a phone the help topics sit above the text, without a sidebar', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 390, height: 800 });
	await page.goto('/help');
	const toc = page.getByRole('navigation', { name: 'Topics' });
	const firstTopic = page.getByRole('heading', { level: 2 }).first();
	const tocBox = (await toc.boundingBox())!;
	const headBox = (await firstTopic.boundingBox())!;
	expect(tocBox.y + tocBox.height).toBeLessThanOrEqual(headBox.y);
	await page.keyboard.press('End');
	await expect(toc).not.toBeInViewport();
});
