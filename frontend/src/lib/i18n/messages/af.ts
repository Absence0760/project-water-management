// Afrikaans wording of the farmer surfaces (WP-2.5). Only reviewed text goes
// here: nothing is invented, because the words go to real farmers. A key with
// no entry shows in English, and it must be on
// docs/i18n/af-translation-sheet.md, the sheet the translator fills in
// (catalogue.test.ts). When reviewed wording comes back, add it here and run
// `pnpm gen:i18n:sheet` to take it off the sheet. An unknown key fails
// `pnpm check`.
//
// Loaded lazily (locale.svelte.ts), only for someone who picks Afrikaans.
// Only type imports: scripts/guards/i18n_sheet.mjs loads this file directly.
import type { MessageKey } from './en';

export const af: Partial<Record<MessageKey, string>> = {};
