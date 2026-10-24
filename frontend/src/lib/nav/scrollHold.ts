// Holding the window at a place while the page settles, one hold at a time.
//
// Two things put the window somewhere and then keep it there while lazily
// loaded parts, charts and late fonts re-flow the page: landing on a #anchor
// (lib/help/anchor.ts holdAnchor) and Back/Forward returning to where the
// reader was (lib/nav/backScroll.ts). Each used to hold on its own, so on a
// Back to an entry with a #panel they fought every frame. Here a newer hold
// replaces the older, and an anchor yields to a Back restore: Back returns to
// where the reader was, as a browser's own Back does, and the anchor neither
// lands nor takes the focus (its heading would sit off screen, and the next
// Tab would jump the page to it).
//
// A hold ends when the reader scrolls, types, touches or clicks; at the next
// Back, Forward or #hash change; when the page has kept its size for
// SETTLE_MS (once the fonts are in, whose swap re-flows the page late); or
// when its owner releases it. Without the settle, a hold no input ended
// (screen-reader swipes send none) put the window back on any later resize:
// a status poll, a fold opening, a run finishing.

/** The reader taking over the scroll position. */
export const READER_INPUT = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
/** A hold also ends on another history step or #hash. */
const STEP = ['popstate', 'hashchange'] as const;
/** How long the page keeps its size before a hold counts it settled. */
export const SETTLE_MS = 1000;

/** What a hold needs from the browser; a test passes fakes. */
export interface HoldEnv {
	/** Where the reader's input and the history events arrive. */
	target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
	/** Resolves when the page's fonts have loaded (document.fonts.ready). */
	fontsReady?: Promise<unknown>;
	/** Calls `onChange` whenever the page's layout size changes; returns a stop function. */
	watchLayout: (onChange: () => void) => () => void;
	/** Calls `fn` after `ms`; returns a cancel function. */
	after?: (ms: number, fn: () => void) => () => void;
}

function browserEnv(): HoldEnv {
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

const later = (ms: number, fn: () => void) => {
	const t = setTimeout(fn, ms);
	return () => clearTimeout(t);
};

let current: { release: () => void; back: boolean } | null = null;
let backPending = false;

/** A Back/Forward restore is on its way (beforeNavigate) or over without one (false). */
export function expectBack(on: boolean): void {
	backPending = on;
}

/** Whether an anchor should yield: a Back restore is on its way or holding. */
export function anchorYields(): boolean {
	return backPending || current?.back === true;
}

/**
 * Hold the window: call `align` now, when the fonts are in and whenever the
 * page's size changes, until the hold ends (header). `back` marks a Back
 * restore. An anchor's hold (`back` false) is refused while a Back restore is
 * on its way or holding: the result is null then. Otherwise returns the
 * release function (idempotent), and any older hold is released.
 */
export function holdScroll(align: () => void, { env = browserEnv(), back = false }: { env?: HoldEnv; back?: boolean } = {}): (() => void) | null {
	if (!back && anchorYields()) return null;
	current?.release();
	if (back) backPending = false;
	const after = env.after ?? later;
	let held = true;
	let fontsIn = !env.fontsReady;
	let cancelSettle = () => {};
	const settle = () => {
		cancelSettle();
		if (fontsIn) cancelSettle = after(SETTLE_MS, release);
	};
	const onLayout = () => {
		if (!held) return;
		align();
		settle();
	};
	const stopWatching = env.watchLayout(onLayout);
	const release = () => {
		if (!held) return;
		held = false;
		stopWatching();
		cancelSettle();
		for (const type of [...READER_INPUT, ...STEP]) env.target.removeEventListener(type, release, true);
		if (current?.release === release) current = null;
	};
	for (const type of [...READER_INPUT, ...STEP]) env.target.addEventListener(type, release, { capture: true, passive: true });
	current = { release, back };
	align();
	settle();
	env.fontsReady?.then(
		() => {
			fontsIn = true;
			onLayout();
		},
		() => {
			fontsIn = true;
			settle();
		}
	);
	return release;
}
