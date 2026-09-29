// Landing on a #term link: a glossary topic (/help/glossary/<topic>#<id>) and the farm
// words page (/farm/words#<id>) scroll the linked entry to the top once the
// SPA has rendered it, and the Runs tab (and River & reserve) do the same for a #res-* panel
// once the run's results are in (the portfolio's "farms short this week"). One scroll isn't enough: the page is still settling
// then. The heading font (font-display: swap) lands later and re-flows
// everything above the entry, which pushed it out of view under load (the
// help.spec.ts "/help#term" flake). So the entry is held in place: scrolled
// again when the fonts are ready and whenever the page's height changes,
// until the reader does anything that scrolls themselves (wheel, touch, key,
// pointer), or the caller releases it (another hash, leaving the page).

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

/** What holdAnchor needs from the browser; a test passes fakes. */
export interface AnchorEnv {
	/** Where the reader's own input arrives. */
	target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
	/** Resolves when the page's fonts have loaded (document.fonts.ready). */
	fontsReady?: Promise<unknown>;
	/** Calls `onChange` whenever the page's layout size changes; returns a stop function. */
	watchLayout: (onChange: () => void) => () => void;
}

/** The reader taking over the scroll position. */
export const READER_INPUT = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

function browserEnv(): AnchorEnv {
	return {
		target: window,
		fontsReady: document.fonts?.ready,
		watchLayout(onChange) {
			if (typeof ResizeObserver === 'undefined') return () => {};
			const ro = new ResizeObserver(onChange);
			ro.observe(document.body);
			return () => ro.disconnect();
		}
	};
}

/**
 * Scroll `el` to the top of the view and keep it there while the page
 * settles. Returns the release function (idempotent).
 */
export function holdAnchor(el: Pick<Element, 'scrollIntoView'>, env: AnchorEnv = browserEnv()): () => void {
	let held = true;
	const align = () => {
		if (held) el.scrollIntoView({ block: 'start' });
	};
	const stopWatching = env.watchLayout(align);
	const release = () => {
		if (!held) return;
		held = false;
		stopWatching();
		for (const type of READER_INPUT) env.target.removeEventListener(type, release, true);
	};
	for (const type of READER_INPUT) env.target.addEventListener(type, release, { capture: true, passive: true });
	align();
	env.fontsReady?.then(align, () => {});
	return release;
}
