// A workspace page's #anchor landing, shared by Settings, Runs & results, Data,
// Project, Calibration and the Summary (issue #586). A link into the page, on load or followed while the
// page is open (a `#…` typed in the address bar, a link to the same page, a
// `location.hash =`), either goes on to a panel that moved (anchorMoves.ts,
// replacing the history entry so Back skips it) or lands on the panel: the
// page's own `land`, usually help/anchor.ts landOnAnchor, which waits for a
// lazy panel, holds it in view while the page settles and focuses its heading.
//
// Only the hash changes for a link followed on the page, so SvelteKit mounts
// nothing and the landing that ran on load would not run again (finding R2-D):
// this listens for `hashchange`. Back and Forward between two entries the app
// has seen keep the place they return to (nav/backScroll.ts, ui-playbook § URL
// state) rather than land: their `popstate` carries the entry's state, where a
// new fragment entry (typed or followed) has none. A link that changes the
// query too fires no `hashchange`; anchorLandingEnv.svelte.ts follows those.
import type { TabId } from '#lib/workspace/tabs.js';
import { anchorForward } from './anchorMoves';
import { hashId } from '#lib/help/anchor.js';
import { browserEnv } from './anchorLandingEnv.svelte';

/** What followAnchors needs from the browser; a test passes fakes. */
export interface LandingEnv {
	/** The page's URL now. */
	url: () => Pick<URL, 'pathname' | 'search' | 'hash'>;
	/** Calls `onHash` on each hash change, told whether it was Back or Forward to a known entry; returns a stop function. */
	listen: (onHash: (traversal: boolean) => void) => () => void;
}

export interface AnchorLanding {
	/** The page, for anchorForward's table. */
	page: TabId;
	/** Land on the panel `id` (decoded, never ''), or do nothing for an id that isn't this page's; returns a stop function. */
	land: (id: string) => (() => void) | void;
	/** Go to a moved panel's new address, replacing this history entry (SvelteKit's `goto(href, { replace: true, reset: false })`). */
	forward: (href: string) => void;
	/** Values for the parameters a moved panel's row keeps that the link lacks (anchorForward `fill`): the Summary passes the run it shows. */
	fill?: () => Readonly<Record<string, string | null | undefined>>;
	/** Land on load too (default). Runs & results lands once the run is drawn, so it lands itself then, and here only on a change. */
	onLoad?: boolean;
	env?: LandingEnv;
}

/** The parts of a click queryHashLink reads (a MouseEvent; a fake in tests). */
export type LinkClick = Pick<MouseEvent, 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'> & { target: EventTarget | null };

/** The same-page address with another query and a #fragment that the click follows, or null. */
export function queryHashLink(e: LinkClick, here: Pick<URL, 'origin' | 'pathname' | 'search'>): string | null {
	if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
	const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null | undefined;
	if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return null;
	const to = new URL(a.href, here.origin);
	if (to.origin !== here.origin || to.pathname !== here.pathname || to.search === here.search || to.hash.length < 2) return null;
	return to.href;
}

/**
 * Follow the page's #anchor, on load and on every hash change: forward a moved panel's link, or
 * else land on the panel (not on load when `onLoad` is false, nor on Back or Forward), ending the
 * landing before. Returns the stop function (call it when the page goes): it ends the landing and stops
 * listening. When the load forwards, nothing more is followed here (the page is going).
 */
export function followAnchors({ page, land, forward, fill, onLoad = true, env = browserEnv() }: AnchorLanding): () => void {
	let stopLanding: () => void = () => {};
	/** Forward a moved panel's link (true), else land on the panel unless `landHere` is false. */
	const follow = (landHere: boolean): boolean => {
		stopLanding();
		stopLanding = () => {};
		const url = env.url();
		const to = anchorForward(page, url, undefined, fill?.());
		if (to) {
			forward(to);
			return true;
		}
		const id = hashId(url.hash);
		if (id && landHere) stopLanding = land(id) ?? (() => {});
		return false;
	};
	if (follow(onLoad)) return () => {};
	const stopListening = env.listen((traversal) => void follow(!traversal));
	return () => {
		stopListening();
		stopLanding();
	};
}
