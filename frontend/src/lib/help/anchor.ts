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

/**
 * The heading a panel's anchor names: the element itself when it is a
 * heading, else the first h2, h3 or h4 inside it (a card's heading can be an
 * h4, as in a legend: Settings' Units without a station).
 */
export function anchorHeading(el: Element): HTMLElement | null {
	return el.matches('h1, h2, h3, h4') ? (el as HTMLElement) : el.querySelector<HTMLElement>('h2, h3, h4');
}

/** Focus the heading as an anchor's landing does: in the tab order from there (tabindex -1), without scrolling. */
export function focusHeading(heading: HTMLElement): void {
	if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
	focusAnchor(heading);
}

/** What landOnAnchor needs from the page; a test passes fakes. */
export interface LandEnv {
	find: (id: string) => Element | null;
	/**
	 * Calls `onChange` whenever the page's content changes, and `onReader` when the reader takes
	 * over (scrolls, types, touches, clicks, or follows another step or #hash); returns a stop function.
	 */
	watch: (onChange: () => void, onReader: () => void) => () => void;
	hold: (el: Element) => () => void;
	focus: (heading: HTMLElement) => void;
}

const READER_STEPS = [...READER_INPUT, 'popstate', 'hashchange'] as const;

function pageEnv(root: Node): LandEnv {
	return {
		find: (id) => document.getElementById(id),
		watch(onChange, onReader) {
			const mo = new MutationObserver(onChange);
			mo.observe(root, { childList: true, subtree: true });
			for (const e of READER_STEPS) window.addEventListener(e, onReader, { capture: true, passive: true });
			return () => {
				mo.disconnect();
				for (const e of READER_STEPS) window.removeEventListener(e, onReader, { capture: true });
			};
		},
		hold: (el) => holdAnchor(el),
		focus: focusHeading
	};
}

/**
 * Land on the panel `id` from a link into the page, where the panel or its
 * heading may be a lazy chunk drawn after the page mounts: once the panel is
 * on the page, scroll there and hold it while the page settles (holdAnchor),
 * and once its heading is drawn (anchorHeading), focus it. Waits for each
 * with one observer of `root`'s content, until the reader takes over (then a
 * late chunk neither moves the page nor takes the focus). Returns the stop
 * function: it ends the wait and releases the hold (call it when the page goes).
 */
export function landOnAnchor(id: string, root: Node = document.body, env: LandEnv = pageEnv(root)): () => void {
	let release = () => {};
	let el: Element | null = null;
	const step = (): boolean => {
		if (!el) {
			el = env.find(id);
			if (!el) return false;
			release = env.hold(el);
		}
		const heading = anchorHeading(el);
		if (!heading) return false;
		env.focus(heading);
		return true;
	};
	if (step()) return () => release();
	let waiting = true;
	let stopWatching: (() => void) | undefined;
	stopWatching = env.watch(
		() => {
			if (waiting && step()) end();
		},
		() => end()
	);
	if (!waiting) stopWatching();
	function end() {
		waiting = false;
		stopWatching?.();
	}
	return () => {
		end();
		release();
	};
}
