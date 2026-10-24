// Back and Forward return the window to where it was on that history entry
// (ui-playbook § URL state: a pick pushes, "so Back returns to the pick
// before"). SvelteKit 2 restored the saved scroll on every Back/Forward.
// SvelteKit 3 restores it only between entries a resetting navigation
// separates: a run of `goto(…, { reset: false })` steps (every in-page pick,
// a tab arrow key) counts as one place, so Back from a dam whose chart the
// pick scrolled into view stayed at the chart. SvelteKit still records each
// entry's scroll and hands it to beforeNavigate as `nav.to.scroll` for a
// popstate; this puts the window there once the navigation lands.
//
// A section loads lazily, so when Back lands the page is still being built:
// restored into that half-built layout, the place drifts as the rest arrives
// (scroll anchoring moved 600 px to 471 on the Dams page; SvelteKit 2, which
// restored once, left it at 231). So, as a browser does while a page loads,
// the place is applied again each time the document resizes, until the
// reader's first scroll, key or touch, or the next navigation.
// e2e/tests/back-scroll.spec.ts pins it per page.
import { afterNavigate, beforeNavigate } from '$app/navigation';

type Scroll = { x: number; y: number };

/** Where a popstate navigation should leave the window, or null when it is already there. */
export function scrollToRestore(target: Scroll | null, now: Scroll): Scroll | null {
	if (!target) return null;
	return Math.round(now.x) === Math.round(target.x) && Math.round(now.y) === Math.round(target.y) ? null : target;
}

const GIVE_UP = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

/** Install the restore. Call once, during the root layout's init. */
export function installBackScroll(): void {
	let target: Scroll | null = null;
	let stop: (() => void) | null = null;
	beforeNavigate((nav) => {
		stop?.();
		target = nav.type === 'popstate' ? (nav.to?.scroll ?? null) : null;
	});
	afterNavigate((nav) => {
		const to = nav.type === 'popstate' ? scrollToRestore(target, { x: scrollX, y: scrollY }) : null;
		target = null;
		if (!to) return;
		scrollTo(to.x, to.y);
		// The page keeps building after the navigation lands: hold the place as it does, until the reader takes over.
		const grow = new ResizeObserver(() => {
			if (scrollToRestore(to, { x: scrollX, y: scrollY })) scrollTo(to.x, to.y);
		});
		const giveUp = () => stop?.();
		stop = () => {
			grow.disconnect();
			for (const e of GIVE_UP) removeEventListener(e, giveUp, true);
			stop = null;
		};
		grow.observe(document.documentElement);
		for (const e of GIVE_UP) addEventListener(e, giveUp, { capture: true, passive: true });
	});
}
