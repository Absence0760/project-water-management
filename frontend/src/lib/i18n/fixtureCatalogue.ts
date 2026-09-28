// Test support (never imported by the app): every message as the translation
// sheet's extractor reads it from the source (scripts/guards/i18n_extract.mjs),
// and a stand-in catalogue with every one of them translated, so tests can
// switch to a "complete" language. Stand-in words only, never shipped.
import type { Catalogue } from './locale.svelte';
import type { Plural } from './msg';

export interface Extracted {
	id: string;
	kind: 'text' | 'plural';
	english?: string;
	forms?: Plural;
	context?: string;
	section: string;
	uses: string[];
}

interface Extractor {
	extract: (opts?: { sections?: string[] }) => { messages: Map<string, Extracted>; problems: string[] };
}

export async function extracted(sections?: string[]) {
	// By URL, so svelte-check doesn't type-check the plain-JavaScript guard.
	const extractor = new URL('../../../../scripts/guards/i18n_extract.mjs', import.meta.url).href;
	const { extract } = (await import(/* @vite-ignore */ extractor)) as Extractor;
	return extract({ sections });
}

/** Every message, each word marked `[af] ` so a test sees which catalogue it came from. */
export async function markedCatalogue(): Promise<Catalogue> {
	const { messages } = await extracted();
	const mark = (s: string) => `[af] ${s}`;
	return Object.fromEntries(
		[...messages.values()].map((m) => [m.id, m.kind === 'plural' ? Object.fromEntries(Object.entries(m.forms!).map(([c, f]) => [c, mark(f)])) : mark(m.english!)])
	);
}
