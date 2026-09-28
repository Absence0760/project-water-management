// Focus after a control removes itself (WCAG 2.4.3 Focus Order). "I
// understand" on the farm notice, "Accept the new terms" and the email
// banner's Dismiss each swap their own section out; the button that had focus
// is gone, and focus falls back to <body>, so a keyboard user starts again
// from the header and a screen reader says nothing about where they are. Once
// the new content is in, focus the page's title (the root layout's #main
// holds every page), or #main itself when the page is still loading and has
// no title yet. The sign-in pages do the same within their card
// (focusAuthTitle, layout/AuthCard.svelte).
import { tick } from 'svelte';

/** The element that should take focus: #main's first h1, else #main. */
export function pageStart(doc: Document = document): HTMLElement | null {
	const main = doc.getElementById('main');
	const title = (main ?? doc).querySelector<HTMLElement>('h1');
	return title ?? main;
}

/** After the state change has rendered, move focus to the page's start. */
export async function focusPageStart(): Promise<void> {
	await tick();
	const target = pageStart();
	if (!target) return;
	// A heading isn't focusable until it has a tabindex; -1 keeps it out of the Tab order.
	if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
	target.focus();
}
