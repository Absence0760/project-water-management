// Waiting for a page's stylesheets before it renders (the root layout's
// onNavigate). SvelteKit calls each route node's loader twice per client
// navigation (a warm-up in load_route, then the real call in load_node), and
// Vite's preload helper awaits a chunk's CSS only on the first call: the
// second finds the stylesheet in its `seen` map and returns at once. So when
// a page's CSS is slower than its JavaScript (a loaded machine, a slow link),
// the page rendered unstyled for a moment, and anything measured then was
// wrong: a glossary #term scroll landed thousands of pixels past the entry
// (docs/followups.md). By the time onNavigate runs, the loaders have already
// added the page's <link rel="stylesheet">, so waiting for every link still
// without a sheet covers it.

/** How long a navigation waits for a stylesheet that never reports back, before rendering anyway. */
export const STYLESHEET_WAIT_CAP_MS = 10_000;

/** A stylesheet link still downloading: no sheet yet (a disabled link never gets one). */
const pending = (l: HTMLLinkElement) => !l.sheet && !l.disabled;

/**
 * Resolves once every `<link rel="stylesheet">` in the document has loaded or
 * failed (either way the page can render: a failed sheet will not arrive
 * later). A link that fires neither within STYLESHEET_WAIT_CAP_MS is an
 * error, logged with its address, and the page renders without it rather than
 * the navigation hanging.
 */
export function stylesheetsReady(
	doc: Pick<Document, 'querySelectorAll'> = document,
	capMs = STYLESHEET_WAIT_CAP_MS,
	log: (message: string) => void = console.error
): Promise<void> {
	const waiting = new Set([...doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].filter(pending));
	if (!waiting.size) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			log(`Stylesheets still loading after ${capMs} ms; rendering without them: ${[...waiting].map((l) => l.href).join(', ')}`);
			resolve();
		}, capMs);
		const done = (l: HTMLLinkElement) => {
			waiting.delete(l);
			if (waiting.size) return;
			clearTimeout(timer);
			resolve();
		};
		for (const l of waiting) {
			l.addEventListener('load', () => done(l), { once: true });
			l.addEventListener('error', () => done(l), { once: true });
		}
	});
}
