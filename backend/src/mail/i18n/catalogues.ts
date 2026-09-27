// The email catalogue of every language but English (WP-2.5, issue #58;
// docs/ui.md § Adding a language): code → catalogue, one line per language.
// The one per-language line the backend needs, since a Lambda bundle can't
// find files by name; catalogues.test.ts fails when a language in the
// engine's table has no line here. English is en.ts, the source every key
// falls back to.
import { af } from './af.js';
import type { MailKey } from './en.js';

export type MailCatalogue = Partial<Record<MailKey, string>>;

export const CATALOGUES: Readonly<Record<string, MailCatalogue>> = { af };
