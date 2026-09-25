// Code-split components: each loader is a `() => import('./X.svelte')` that
// Vite turns into its own chunk. loadOnce memoises the import per loader, so a
// hover prefetch, the render that needs it and a later remount all share one
// request, and peek lets a remount render synchronously with no loading flash.
// A failed import (a network blip, or a deploy that removed the old chunk) is
// forgotten so the next attempt tries again.

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
