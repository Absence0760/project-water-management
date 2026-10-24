// Landing on a #term link: a glossary topic (/help/glossary/<topic>#<id>) and the farm
// words page (/farm/words#<id>) scroll the linked entry to the top once the
// SPA has rendered it, and the Runs tab (and EWR) do the same for a #res-* panel
// once the run's results are in (the portfolio's "farms short this week"). One scroll isn't enough: the page is still settling
// then. The heading font (font-display: swap) lands later and re-flows
// everything above the entry, which pushed it out of view under load (the
// help.spec.ts "/help#term" flake). So the entry is held in place: scrolled
// again when the fonts are ready and whenever the page's height changes,
// through the one scroll hold (lib/nav/scrollHold.ts: until the reader scrolls
// themselves, the page settles, another step or #hash, or the caller releases
// it), which also makes an anchor yield to Back returning the reader's place.
import { anchorYields, holdScroll, READER_INPUT, type HoldEnv } from '#lib/nav/scrollHold.js';

/**
 * The id a URL's #hash names, decoded; '' for no hash or one that isn't
 * valid percent-encoding (a hand-typed #%E0 would make decodeURIComponent
 * throw inside the page's effect).
 */
export function hashId(hash: string): string {
	try {
		return decodeURIComponent(hash.replace(/^#/, ''));
	} catch {
		return '';
	}
}

/** What holdAnchor needs from the browser; a test passes fakes (lib/nav/scrollHold.ts HoldEnv). */
export type AnchorEnv = HoldEnv;

export { READER_INPUT };

/**
 * Scroll `el` to the top of the view and keep it there while the page
 * settles (lib/nav/scrollHold.ts says when that ends). Returns the release
 * function (idempotent). While Back is returning the window to where the
 * reader was, the anchor yields: nothing scrolls, and the release is a no-op.
 */
export function holdAnchor(el: Pick<Element, 'scrollIntoView'>, env?: AnchorEnv): () => void {
	return holdScroll(() => el.scrollIntoView({ block: 'start' }), { env }) ?? (() => {});
}

/** Give the anchored panel's heading the focus, without scrolling; not while Back restores the reader's place (it would sit off screen). */
export function focusAnchor(heading: HTMLElement): void {
	if (!anchorYields()) heading.focus({ preventScroll: true });
}
