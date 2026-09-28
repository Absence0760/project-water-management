// Code-split components: each loader is a `() => import('./X.svelte')` that
// Vite turns into its own chunk. loadOnce memoises the import per loader, so a
// hover prefetch, the render that needs it and a later remount all share one
// request, and peek lets a remount render synchronously with no loading flash.
//
// A failed import (a network blip, or a deploy that removed the old chunk) is
// not kept, so a later call runs the loader again, but that almost never
// recovers: the browser records a module script that failed to fetch in the
// page's module map (HTML spec, "fetch a single module script") and fails
// every later import of that URL at once, for the life of the page. The one
// case a rerun helps is a chunk whose own CSS failed (Vite's preload helper
// rejects before importing the JS; the rerun imports it, unstyled). So
// callers offer a reload, never "Try again" (ChunkFailed.svelte), and never
// reload by themselves, which would loop if the chunk is really gone.
//
// A cache-busting retry isn't possible either: the loader's URL is the
// hashed file name Vite compiled into it, the chunk's own static imports
// (shared chunks, possibly the ones that failed) keep their URLs, and after a
// deploy the old hashed files are gone, so only a reload, which fetches the
// new index.html and its new chunk names, gets a working copy.

export type Loader<T> = () => Promise<{ default: T }>;

const done = new Map<Loader<unknown>, unknown>();
const inFlight = new Map<Loader<unknown>, Promise<unknown>>();

/** The loaded export, or undefined if the chunk hasn't arrived yet. */
export function peek<T>(load: Loader<T>): T | undefined {
	return done.get(load) as T | undefined;
}

/** Import once; concurrent and later callers share the same promise and result. */
export function loadOnce<T>(load: Loader<T>): Promise<T> {
	if (done.has(load)) return Promise.resolve(done.get(load) as T);
	let p = inFlight.get(load) as Promise<T> | undefined;
	if (!p) {
		p = load().then(
			(m) => {
				done.set(load, m.default);
				inFlight.delete(load);
				return m.default;
			},
			(e: unknown) => {
				inFlight.delete(load);
				throw e;
			}
		);
		inFlight.set(load, p);
	}
	return p;
}

/** Warm a chunk ahead of need (hover, focus). Errors surface on the real load. */
export function prefetch(load: Loader<unknown>): void {
	loadOnce(load).catch(() => {});
}
