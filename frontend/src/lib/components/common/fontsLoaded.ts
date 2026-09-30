// Text drawn or measured on a canvas uses whatever face has loaded at that
// moment and never changes afterwards: a chart drawn before the self-hosted
// Inter arrives keeps the fallback's glyphs, and a canvas measurement keeps the
// fallback's widths. DOM text needs none of this (the browser re-lays it out,
// and a ResizeObserver on it sees the new size). So a component that draws or
// measures text on a canvas calls onFontsLoaded and draws or measures again.

/** The part of a FontFaceSet this needs (document.fonts). */
export type FontLoads = Pick<FontFaceSet, 'addEventListener' | 'removeEventListener'>;

/**
 * Calls `onLoad` each time the page finishes loading fonts (the FontFaceSet's
 * `loadingdone`, which fires after every batch of font loads, including one
 * that started before this was called). Fonts that had already loaded need
 * no call: whatever measured them measured the final face. Returns a stop
 * function, for an $effect's cleanup.
 */
export function onFontsLoaded(onLoad: () => void, fonts: FontLoads | undefined = globalThis.document?.fonts): () => void {
	if (!fonts) return () => {};
	const loaded = () => onLoad();
	fonts.addEventListener('loadingdone', loaded);
	return () => fonts.removeEventListener('loadingdone', loaded);
}
