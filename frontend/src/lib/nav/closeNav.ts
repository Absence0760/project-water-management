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
// (closeSettled), and a link clicked in the gap is held and clicked again once it has landed
// (holdLinksWhileClosing), by which time its href is built from the settled URL.
import { tick } from 'svelte';

let pending: Promise<unknown> | null = null;
const ignore = () => {};

// `<html data-closing>` while a close's navigation is under way: set in the same task the sheet
// shuts, so whatever reads the URL to learn what is open (the e2e helpers) can wait it out.
function markClosing(on: boolean) {
	if (typeof document !== 'undefined') document.documentElement.toggleAttribute('data-closing', on);
}

/** Note the navigation that drops a closed sheet's parameter. Returns it, for the caller to `void`. */
export function trackClose<T>(nav: Promise<T>): Promise<T> {
	pending = nav;
	markClosing(true);
	const clear = () => {
		if (pending !== nav) return;
		pending = null;
		markClosing(false);
	};
	// Handled here only to clear the note: a failure still reaches whoever holds `nav`.
	nav.then(clear, clear);
	return nav;
}

/** Whether a close's navigation is still under way. */
export const closing = (): boolean => pending !== null;

/** Resolves once no close's navigation is under way (landed or failed) and the page has re-rendered. */
export async function closeSettled(): Promise<void> {
	while (pending) await pending.then(ignore, ignore);
	await tick();
}

/** The parts of a click the link hold reads (a MouseEvent in the browser). */
export interface LinkClick {
	target: EventTarget | null;
	defaultPrevented: boolean;
	button: number;
	metaKey: boolean;
	ctrlKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
	preventDefault(): void;
}

/** The link a click would follow inside the app, or null (a modified click, a new tab, a download, another site). */
export function followedLink(e: LinkClick, origin: string): HTMLAnchorElement | null {
	if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
	const el = e.target as Element | null;
	const a = typeof el?.closest === 'function' ? (el.closest('a[href]') as HTMLAnchorElement | null) : null;
	if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return null;
	return a.origin === origin ? a : null;
}

/**
 * While a close's navigation is under way, hold a click on an in-app link (SvelteKit leaves a
 * prevented click alone) and click the link again once it has landed. Returns the uninstaller.
 */
export function holdLinksWhileClosing(doc: Pick<Document, 'addEventListener' | 'removeEventListener'>, origin: string): () => void {
	const onclick = (e: Event) => {
		if (!pending) return;
		const a = followedLink(e as unknown as LinkClick, origin);
		if (!a) return;
		e.preventDefault();
		void closeSettled().then(() => {
			// Gone with the re-render (its row removed): nothing a person could click any more.
			if (a.isConnected) a.click();
		});
	};
	doc.addEventListener('click', onclick, true);
	return () => doc.removeEventListener('click', onclick, true);
}
