// Afrikaans wording of the farmer emails (WP-2.5). Only reviewed text goes
// here: nothing is invented. A key with no entry is sent in English (and the
// email is marked lang="en"), and it must be on
// docs/i18n/af-translation-sheet.md, which is what the translator fills in.
// When the reviewed wording comes back, add it here and run
// `pnpm gen:i18n:sheet` to take it off the sheet.
//
// Only type imports: scripts/guards/i18n_sheet.mjs loads this file directly.
import type { MailKey } from './en.js';

export const af: Partial<Record<MailKey, string>> = {};
