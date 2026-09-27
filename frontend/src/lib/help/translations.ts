// The farmer glossary in each language (WP-2.5, issue #58; docs/ui.md
// § Language). A language's translations are content.<code>.ts (a two- or
// three-letter code, so content.test.ts is never one) exporting
// `HELP_<CODE>` (content.af.ts → HELP_AF), found by file, so a new language's
// glossary needs no line here. Loaded lazily: each is its own chunk, fetched
// only by a reader in that language.
import type { HelpTranslation } from './types';

export type { HelpTranslation } from './types';

const FILES = import.meta.glob<Record<string, Record<string, HelpTranslation>>>(['./content.[a-z][a-z].ts', './content.[a-z][a-z][a-z].ts']);

/** code → its glossary loader, e.g. af → content.af.ts's HELP_AF. */
const LOADERS: Partial<Record<string, () => Promise<Record<string, HelpTranslation>>>> = Object.fromEntries(
	Object.entries(FILES).map(([path, load]) => {
		const code = path.slice('./content.'.length, -'.ts'.length);
		return [code, () => load().then((m) => m[`HELP_${code.toUpperCase()}`] ?? {})];
	})
);

/** The languages that have a glossary file. */
export const helpLanguages = (): string[] => Object.keys(LOADERS);

/** A language's glossary translations, by entry id ({} for English, or a language with none yet). */
export async function helpTranslations(code: string): Promise<Record<string, HelpTranslation>> {
	return (await LOADERS[code]?.()) ?? {};
}
