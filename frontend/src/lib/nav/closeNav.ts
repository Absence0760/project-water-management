// The navigation that closes a URL-backed sheet or modal (the crop sheet's `crop=`, the
// node sheet's `edit=`, the grid modal's `grid=`, the team settings' `settings=`).
//
// Each of those mirrors its parameter into an open flag, and on Done, Esc or the ✕ shuts at
// once, then drops the parameter with a replacing goto that lands a moment later. An open
// started in that gap was built from the URL still naming the closed one, and SvelteKit keeps
// only the newest navigation, so the drop was abandoned: opening the same one again changed
// nothing (the flag only follows a change of parameter, and there was none), and opening
// another pushed over the entry still naming the closed one, so Back reopened it.
//
// So the close notes its navigation here (trackClose), an open made in code waits for it
// (closeSettled), and an opener link's onclick (openAfterClose) does the same for a plain
// click. A close is over when its navigation settles, when any navigation completes
// (installCloseNav's afterNavigate), or after FAILSAFE_MS at the latest, so nothing can stick.
import { tick } from 'svelte';
import { afterNavigate, goto } from '$app/navigation';

/** The longest an open waits for a close: a fail-safe for a navigation that never settles, not a wait anything relies on. */
export const FAILSAFE_MS = 2000;

interface Close {
	done: Promise<void>;
	finish: () => void;
}
let current: Close | null = null;

// `<html data-closing>` while a close is under way: set in the same task the sheet shuts, so
// whatever reads the URL to learn what is open (the e2e helpers) can wait it out.
function markClosing(on: boolean) {
	if (typeof document !== 'undefined') document.documentElement.toggleAttribute('data-closing', on);
}

/** Note the navigation that drops a closed sheet's parameter. Returns it, for the caller to `void`. */
export function trackClose<T>(nav: Promise<T>): Promise<T> {
	let resolve!: () => void;
	const close: Close = { done: new Promise<void>((r) => (resolve = r)), finish: () => {} };
	const timer = setTimeout(() => close.finish(), FAILSAFE_MS);
	close.finish = () => {
		clearTimeout(timer);
		resolve();
		if (current !== close) return;
		current = null;
		markClosing(false);
	};
	current = close;
	markClosing(true);
	// Handled here only to end the close: a failure still reaches whoever holds `nav`.
	nav.then(close.finish, close.finish);
	return nav;
}

/** Whether a close is under way. */
export const closing = (): boolean => current !== null;

/** A navigation completed: the URL is settled, so no close is under way any more. */
export function navigated(): void {
	current?.finish();
}

/** End any close when a navigation completes. Call once, during the root layout's init. */
export function installCloseNav(): void {
	afterNavigate(navigated);
}

/**
 * Resolves once no close is under way and the page has re-rendered. A close that starts while
 * it re-renders (an effect that ran on the settled URL) is waited for too, so the open that
 * follows never overtakes one.
 */
export async function closeSettled(): Promise<void> {
	do {
		while (current) await current.done;
		await tick();
	} while (current);
}

/** The parts of a click the guard reads (a MouseEvent in the browser). */
export interface LinkClick {
	defaultPrevented: boolean;
	button: number;
	metaKey: boolean;
	ctrlKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
}
/** The parts of a link the guard reads. */
export interface LinkTarget {
	href: string;
	target: string;
	hasAttribute(name: string): boolean;
}

/** Whether a click on `a` is a plain in-app follow: primary button, no modifier, no other target, no download, this site. */
export function followsInApp(e: LinkClick, a: LinkTarget, origin: string): boolean {
	if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
	if ((a.target && a.target !== '_self') || a.hasAttribute('download')) return false;
	return new URL(a.href, origin).origin === origin;
}

/**
 * onclick for a link that opens a URL-backed sheet or grid (it stays a link: middle-click and
 * Copy link work). A plain click while a close is under way waits for it, then goes to the
 * link's href as the settled page renders it (the same parameter on the settled URL); any
 * other click, or one with nothing closing, is left to SvelteKit. `also` is the link's own
 * handler, run once, first, either way.
 */
export function openAfterClose(also?: (e: MouseEvent) => void) {
	return (e: MouseEvent & { currentTarget: HTMLAnchorElement }) => {
		also?.(e);
		const a = e.currentTarget;
		if (!current || !followsInApp(e, a, location.origin)) return;
		e.preventDefault();
		// As SvelteKit follows the link: `data-sveltekit-noscroll` keeps the scroll and focus (reset: false).
		const reset = a.closest('[data-sveltekit-noscroll]') === null;
		void closeSettled().then(() => goto(a.href, { reset }));
	};
}
