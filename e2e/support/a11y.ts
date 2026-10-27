// The axe-core WCAG 2.2 A/AA scan every spec shares (a11y.spec.ts, and the
// feature specs that scan their own screens). Always go through it rather
// than a bare AxeBuilder, so every scan gets the fast mode below. axe finds
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
 *
 * The scan runs axe.run() in the page (legacy mode) and keeps node details
 * for violations only (resultTypes). The default mode runs axe.runPartial()
 * per frame, then opens a second, blank page to merge the partial results,
 * which serialises every node of every passing rule across the protocol:
 * on the 3,000-element glossary a scan took 5.5 s that way and 2.3 s this way
 * (the teams list 0.36 s → 0.18 s), enough to push a test with several scans
 * past the 30 s budget on a loaded machine. What legacy mode gives up is
 * cross-origin frame testing, and the app has no frames, so this refuses a
 * page that has one rather than scan it partially.
 */
export interface ScanScope {
	/** axe tags to run (default WCAG_TAGS). */
	tags?: string[];
	/** Named axe rules to run instead of tags. */
	rules?: string[];
	/** Scan only this part of the page (a CSS selector). Default: the open modal dialog if there is one, else the page. */
	include?: string;
}

/**
 * A modal <dialog> (showModal) makes the rest of the page inert, and axe then
 * scans only the dialog. axe-core guesses modality by probing just outside the
 * dialog, which a dialog filling the viewport (a sheet on a phone) defeats: it
 * then scans the inert map behind the sheet too, and a marker that happens to
 * sit under the sheet's buttons reads as an obscured target (issue #523). So a
 * scan with no `include` of its own covers the open modal dialog when the
 * browser says one is open (`:modal`), as axe does when its guess works.
 */
const MODAL = 'dialog:modal';

export async function expectNoViolations(page: Page, scope: ScanScope = {}) {
	expect(await violations(page, scope)).toEqual([]);
}

/** The scan behind expectNoViolations: each violation, with up to five of its nodes. */
export async function violations(page: Page, { tags = WCAG_TAGS, rules, include }: ScanScope = {}) {
	expect(page.frames(), 'the page has a frame: scan it with the default (runPartial) mode instead').toHaveLength(1);
	// To the top, and still there two frames later: a smooth scroll still running (a pick that brings a chart into
	// view, data-page.spec.ts) takes one more step after an instant scrollTo, which left the page a few pixels down
	// (40 on a loaded CI runner) and the header's guide link under the sticky app header.
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					new Promise<number>((done) => {
						window.scrollTo({ top: 0, behavior: 'instant' });
						requestAnimationFrame(() => requestAnimationFrame(() => done(window.scrollY)));
					})
			)
		)
		.toBe(0);
	// options() replaces the whole option object, so it goes before withTags()/withRules().
	const builder = new AxeBuilder({ page }).options({ resultTypes: ['violations'] }).setLegacyMode();
	if (rules) builder.withRules(rules);
	else builder.withTags(tags);
	const scope = include ?? ((await page.locator(MODAL).count()) > 0 ? MODAL : undefined);
	if (scope) builder.include(scope);
	const results = await builder.analyze();
	return results.violations.map((v) => ({
		id: v.id,
		impact: v.impact,
		help: v.help,
		nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5)
	}));
}
