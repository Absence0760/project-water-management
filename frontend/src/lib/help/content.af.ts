// Afrikaans versions of the farmer glossary entries (farmer.ts, category
// 'farmer'; shown on /farm/words), WP-2.5. Only reviewed text goes here.
//
// `sourceHash` is the SHA-256 (hex) of the English `term + "\n" + short +
// "\n" + long` the translation was made from. content.af.test.ts fails when
// the English has changed since (the translation is stale), when an entry
// isn't a farmer entry, and when a farmer entry has neither a translation nor
// a row on docs/i18n/af-translation-sheet.md. An entry without a translation
// shows in English (marked lang="en"). Once the translator has re-checked a
// stale entry, `pnpm gen:i18n:stamp <id>` writes the current English's hash
// here and rewrites the sheet; `pnpm check:i18n` lists the stale ones.
//
// Only type imports: scripts/guards/i18n_sheet.mjs loads this file directly.

export interface HelpTranslation {
	term: string;
	short: string;
	long: string;
	sourceHash: string;
}

export const HELP_AF: Record<string, HelpTranslation> = {};
