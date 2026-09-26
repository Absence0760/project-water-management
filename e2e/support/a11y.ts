// The axe-core WCAG 2.2 A/AA scan the a11y specs share (a11y.spec.ts, and
// the pages with specs of their own, such as the printable report). axe finds
// a subset of problems, but anything it does flag must stay fixed: fix it at
// the source, never by disabling a rule.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

/**
 * Scans the whole page from the top. axe's target-size rule counts a control
 * scrolled under the sticky app header as obscured, so a scan made wherever
 * the last click left the page depends on the scroll position rather than on
 * the controls (focused controls clear the header through scroll-padding-top).
 */
export async function expectNoViolations(page: Page) {
	await page.evaluate(() => window.scrollTo(0, 0));
	const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
	const report = violations.map((v) => ({
		id: v.id,
		impact: v.impact,
		help: v.help,
		nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5)
	}));
	expect(report).toEqual([]);
}
