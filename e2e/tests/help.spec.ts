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

	// "More in the glossary" lands on the term's entry.
	await tip.click();
	await bubble.getByRole('link', { name: 'More in the glossary' }).click();
	await expect(page).toHaveURL(/\/help\/glossary#element-farm$/);
	await expect(page.getByRole('article', { name: 'Farm element' })).toBeInViewport();
});

test('the help sidebar stays beside the glossary and follows the section being read', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/help/glossary');
	const nav = page.getByRole('navigation', { name: 'Help' });
	const topics = page.getByRole('main').getByRole('heading', { level: 2 });
	const first = (await topics.first().textContent())!.trim();
	const last = (await topics.last().textContent())!.trim();
	expect(first).not.toBe(last);

	await expect(nav.getByRole('link', { name: 'Glossary', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(nav.getByRole('link', { name: first, exact: true })).toHaveAttribute('aria-current', 'location');

	// Scroll to the end: the sidebar is still in view (its search box at the
	// top, the list scrolled within it), and marks the last topic, on screen.
	await page.keyboard.press('End');
	await expect(nav.getByRole('link', { name: last, exact: true })).toHaveAttribute('aria-current', 'location');
	await expect(nav.getByRole('link', { name: first, exact: true })).not.toHaveAttribute('aria-current', 'location');
	await expect(nav.getByRole('link', { name: last, exact: true })).toBeInViewport();
	const box = await page.getByRole('searchbox', { name: 'Search help' }).boundingBox();
	expect(box!.y).toBeGreaterThanOrEqual(0);
	expect(box!.y).toBeLessThan(200);

	// The current topic lists its terms, and a term link jumps to it.
	// (The Glossary item holds every topic, so the topic's own item is the innermost match.)
	const current = nav.getByRole('listitem').filter({ has: page.getByRole('link', { name: last, exact: true }) }).last();
	const term = current.getByRole('list').getByRole('link').first();
	const name = (await term.textContent())!.trim();
	await term.click();
	await expect(page.getByRole('article', { name })).toBeInViewport();
});

test('on a phone the help contents fold behind a button above the page', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 390, height: 800 });
	await page.goto('/help');
	const toggle = page.getByRole('button', { name: 'Help contents' });
	const nav = page.getByRole('navigation', { name: 'Help' });
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(nav).toBeHidden();
	const toggleBox = (await toggle.boundingBox())!;
	const h1Box = (await page.getByRole('heading', { level: 1 }).boundingBox())!;
	expect(toggleBox.y + toggleBox.height).toBeLessThanOrEqual(h1Box.y);

	await toggle.click();
	await expect(nav).toBeVisible();
	await nav.getByRole('link', { name: 'Add a transfer' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Add a transfer' })).toBeVisible();
	// Choosing a page folds the contents away again.
	await expect(nav).toBeHidden();
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('the catchment tour links each picture marker to its stop', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/help');
	await expect(page.getByRole('img', { name: /An illustrated catchment/ })).toBeVisible();
	const stops = page.getByRole('main').getByRole('list').filter({ has: page.getByRole('heading', { name: 'Rain falls on the catchment' }) });
	await expect(stops.getByRole('heading', { level: 3 })).toHaveCount(8);

	// The markers are the pointer shortcut (hidden from assistive tech: the list is the text).
	await page.locator('.marker', { hasText: '5' }).click();
	const irrigation = stops.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Crops are irrigated from the dams' }) });
	await expect(irrigation).toHaveClass(/\bon\b/);
	await expect(page.locator('.marker', { hasText: '5' })).toHaveClass(/\bon\b/);

	await irrigation.getByRole('link', { name: /Set up crops and irrigation demand/ }).click();
	await expect(page).toHaveURL(/\/help\/guides\/set-up-crops-and-demand$/);
});

test('a guide shows its diagrams and links into the glossary', async ({ page, owner }) => {
	void owner;
	await page.goto('/help');
	await page.getByRole('region', { name: 'Understand the model' }).getByRole('link', { name: 'How calibration works' }).click();

	await expect(page).toHaveURL(/\/help\/guides\/how-calibration-works$/);
	await expect(page.getByRole('heading', { level: 1, name: 'How calibration works' })).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Help' }).getByRole('link', { name: 'How calibration works' })).toHaveAttribute(
		'aria-current',
		'page'
	);
	await expect(page.getByRole('img', { name: /DDS perturbs fewer parameters/ })).toBeVisible();
	await expect(page.getByRole('img', { name: /dry to wet test fits on the four driest years/ })).toBeVisible();

	// "On this page" jumps to a section.
	await page.getByRole('navigation', { name: 'On this page' }).getByRole('link', { name: 'Validation: the honest measure' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Validation: the honest measure' })).toBeInViewport();

	// A term link lands on its glossary entry.
	await page.getByRole('region', { name: 'Terms in this guide' }).getByRole('link', { name: 'Fit record' }).click();
	await expect(page).toHaveURL(/\/help\/glossary#fit-record$/);
	await expect(page.getByRole('article', { name: 'Fit record' })).toBeInViewport();
});

test('help search finds guides and glossary terms as you type', async ({ page, owner }) => {
	void owner;
	await page.goto('/help/guides/how-gr4j-works');
	const box = page.getByRole('searchbox', { name: 'Search help' });
	await box.fill('transfer');
	await expect(page).toHaveURL(/\/help\/search\?q=transfer$/);
	await expect(box).toBeFocused();
	await expect(page.getByRole('status')).toContainText('match “transfer”');
	await expect(page.getByRole('region', { name: 'Guides' }).getByRole('link', { name: 'Add a transfer' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Glossary' }).getByRole('link', { name: 'Transfer', exact: true })).toBeVisible();

	await box.fill('zzzz');
	await expect(page.getByText('Nothing matches.')).toBeVisible();
});

test('an old /help#term link goes on to the glossary entry', async ({ page, owner }) => {
	void owner;
	await page.goto('/help#nse');
	await expect(page).toHaveURL(/\/help\/glossary#nse$/);
	await expect(page.getByRole('article', { name: /^NSE/ })).toBeInViewport();
});

test('an unknown guide says so and links back to help', async ({ page, owner }) => {
	void owner;
	await page.goto('/help/guides/no-such-guide');
	await expect(page.getByRole('heading', { level: 1, name: 'Guide not found' })).toBeVisible();
	await expect(page.getByRole('main').getByRole('link', { name: 'See all guides and the glossary' })).toBeVisible();
});
