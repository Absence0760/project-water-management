// The app's base path as a string ('' at the site root, else '/x'), for the
// code that needs the prefix itself rather than a link: stripping it from a
// pathname (`page.url.pathname.slice(basePath().length)`), the pure helpers
// that take it (farmHref, wordsHref, routeAccess…), and a path a helper already
// built with its leading '/' (`${basePath()}${glossaryPath(e)}`).
//
// SvelteKit 3 removed `base` from $app/paths in favour of resolve() and
// asset(); a link to a route is `resolve('projects/x')`. resolve('') is the
// base followed by '/', so this is that less the slash. A function, not a
// constant: while prerendering (the /welcome pages) the base is relative to
// the page being rendered ('.' or '..'), as `base` was.
import { resolve } from '$app/paths';

export function basePath(): string {
	return resolve('').slice(0, -1);
}
