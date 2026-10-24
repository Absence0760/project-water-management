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
// A lazily loaded section is still building when Back lands, and restored
// once, the place drifted as the rest arrived (scroll anchoring moved 600 px
// to 471 on the Dams page; SvelteKit 2, which restored once, left 231). So
// the place is held through lib/nav/scrollHold.ts, the one hold the #anchors
// use too, which yield to it, until the page settles or the reader takes
// over. It holds even when SvelteKit restored the place itself (a Back that
// resets): the same drift follows. e2e/tests/back-scroll.spec.ts pins it.
import { afterNavigate, beforeNavigate } from '$app/navigation';
import { expectBack, holdScroll } from './scrollHold';

type Scroll = { x: number; y: number };

/** Whether the window is away from the saved place (rounded to the pixel), so a restore has to move it. */
export function awayFrom(target: Scroll, now: Scroll): boolean {
	return Math.round(now.x) !== Math.round(target.x) || Math.round(now.y) !== Math.round(target.y);
}

/** Install the restore. Call once, during the root layout's init. */
export function installBackScroll(): void {
	let target: Scroll | null = null;
	beforeNavigate((nav) => {
		target = nav.type === 'popstate' ? (nav.to?.scroll ?? null) : null;
		expectBack(target !== null);
	});
	afterNavigate((nav) => {
		const to = nav.type === 'popstate' ? target : null;
		target = null;
		if (!to) return expectBack(false);
		holdScroll(
			() => {
				if (awayFrom(to, { x: scrollX, y: scrollY })) scrollTo(to.x, to.y);
			},
			{ back: true }
		);
	});
}
