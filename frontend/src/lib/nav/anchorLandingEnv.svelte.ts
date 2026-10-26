// The browser side of nav/anchorLanding.ts followAnchors: which changes of the
// page's address count as "a link followed while the page is open".
//
// A `#…` typed, a same-page `#…` link or `location.hash =` fires `hashchange`.
// A link that changes the query as well (`?run=r2#res-notes` from Runs &
// results) does not: SvelteKit pushes the new entry itself, and since the tab
// stays mounted, its load-time landing doesn't run again either. So a click on
// such a link is noted, and once SvelteKit's page shows that address it counts
// as a change too. Only a click counts: a `goto` the page makes itself (a
// picked run, a filter written to the query) keeps the reader where they are.
import { page } from '$app/state';
import { queryHashLink, type LandingEnv } from './anchorLanding';

export function browserEnv(): LandingEnv {
	return {
		url: () => location,
		listen(onHash) {
			let traversal = false;
			let clicked: string | null = null;
			const pop = (e: PopStateEvent) => (traversal = e.state != null);
			const hash = () => {
				const t = traversal;
				traversal = false;
				onHash(t);
			};
			// Capturing: SvelteKit's own link handler, which runs before a bubbling one here, prevents the default.
			// A link something else cancels changes no address, so the note is never used (the next click replaces it).
			const click = (e: MouseEvent) => (clicked = queryHashLink(e, location));
			window.addEventListener('popstate', pop);
			window.addEventListener('hashchange', hash);
			document.addEventListener('click', click, true);
			const stopFollowing = $effect.root(() => {
				$effect(() => {
					const href = page.url.href;
					if (clicked && href === clicked) {
						clicked = null;
						onHash(false);
					}
				});
			});
			return () => {
				window.removeEventListener('popstate', pop);
				window.removeEventListener('hashchange', hash);
				document.removeEventListener('click', click, true);
				stopFollowing();
			};
		}
	};
}
