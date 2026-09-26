// Afrikaans wording of the farmer surfaces (WP-2.5). Only reviewed text goes
// here: nothing is invented, because the words go to real farmers. A message
// with no entry shows in English, and it is on
// docs/i18n/af-translation-sheet.md, the sheet the translator fills in.
//
// Each entry is keyed by the message's id, the Id column of the sheet (a hash
// of the English, $lib/i18n/msg.ts), with the English in a comment above it:
//
//   // Your dam
//   '1a2b3c4d': 'Jou dam',
//   // day / days
//   '5e6f7a8b': { one: 'dag', other: 'dae' },
//
// When reviewed wording comes back, add it here and run `pnpm gen:i18n:sheet`
// to take it off the sheet. If the English later changes, its id changes: the
// old entry is stale (`pnpm check:i18n` and catalogue.test.ts fail) until it
// is translated again under the new id, so an outdated translation never
// shows for new English.
//
// Loaded lazily (locale.svelte.ts), only for someone who picks Afrikaans.
// Only type imports: scripts/guards/i18n_sheet.mjs loads this file directly.
import type { Catalogue } from '../locale.svelte';

export const af: Catalogue = {};
