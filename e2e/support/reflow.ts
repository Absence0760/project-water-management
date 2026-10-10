// Reflow checks the layout specs share (WCAG 2.2 SC 1.4.10, issue #38; the
// Afrikaans layouts, issue #49).
import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The page's scroll width, plus every element that pokes past the viewport's
 * right edge without a scrolling (or clipping) ancestor to hold it, so a
 * failure names the culprit rather than just a number.
 */
export async function sidewaysOverflow(page: Page) {
	return page.evaluate(() => {
		const root = document.documentElement;
		const edge = root.clientWidth;
		const held = (el: Element) => {
			for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
				const ox = getComputedStyle(p).overflowX;
				if (ox !== 'visible') return true;
			}
			return false;
		};
		const culprits = [...document.body.querySelectorAll('*')]
			.filter((el) => {
				const r = el.getBoundingClientRect();
				return r.width > 0 && r.right > edge + 0.5 && !held(el);
			})
			.map((el) => {
				const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
				return `${el.tagName.toLowerCase()}${cls} right=${Math.round(el.getBoundingClientRect().right)}`;
			});
		return { scrollWidth: root.scrollWidth, clientWidth: edge, culprits };
	});
}

/**
 * Resize the viewport and wait until the page has rendered at the new size.
 * The browser re-evaluates media queries in its next rendering update (HTML
 * "update the rendering"), not when a script reads layout, so a box read
 * straight after setViewportSize can still come from the old width's layout:
 * the help page at 390 px measured with its 900 px sidebar column still there.
 * Two animation frames guarantee that update has run.
 */
export async function resizeTo(page: Page, size: { width: number; height: number }) {
	await page.setViewportSize(size);
	await layoutSettled(page);
}

/**
 * Wait until the page's text is in its final fonts and every layout that
 * follows them has run: the web fonts loaded (document.fonts.ready), then two
 * animation frames, so the browser's rendering update and the ResizeObservers
 * it fires (a fit re-measuring its links, SectionNav) have run and their state
 * has reached the DOM. A check that reads boxes once waits for this first:
 * before Inter lands the text is in a fallback of other widths.
 */
export async function layoutSettled(page: Page) {
	await page.evaluate(async () => {
		await document.fonts.ready;
		await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
	});
}

export async function expectNoSidewaysScroll(page: Page) {
	const o = await sidewaysOverflow(page);
	expect(o.culprits, `page is ${o.scrollWidth}px wide in a ${o.clientWidth}px viewport`).toEqual([]);
	expect(o.scrollWidth).toBeLessThanOrEqual(o.clientWidth);
}

/**
 * Text cut off inside its own box: an element that clips (overflow hidden or
 * clip) whose content is wider than it, so part of a word never shows. Boxes
 * that scroll (a wide table) are fine, and so is visually hidden text (the
 * 1 px screen-reader-only boxes).
 */
export async function clippedText(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		[...document.body.querySelectorAll('*')]
			.filter((el) => {
				const ox = getComputedStyle(el).overflowX;
				return (ox === 'hidden' || ox === 'clip') && el.clientWidth > 1 && el.clientHeight > 1 && el.scrollWidth > el.clientWidth + 1 && (el.textContent ?? '').trim() !== '';
			})
			.map((el) => `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 60)}" ${el.scrollWidth}>${el.clientWidth}`)
	);
}

/**
 * `upper` ends above where `lower` starts, on the page as drawn: a grid's
 * actions above its first row (issue #463), not under a long table. Compared
 * in DOM order too, so the keyboard reaches the actions before the rows.
 */
export async function expectAbove(upper: Locator, lower: Locator) {
	await expect(upper).toBeVisible();
	await expect(lower).toBeVisible();
	const a = (await upper.boundingBox())!;
	const b = (await lower.boundingBox())!;
	expect(a.y + a.height, 'ends above the other starts').toBeLessThanOrEqual(b.y + 1);
	const before = await upper.evaluate((el, other) => !!(el.compareDocumentPosition(other!) & Node.DOCUMENT_POSITION_FOLLOWING), await lower.elementHandle());
	expect(before, 'comes first in the focus order').toBe(true);
}
