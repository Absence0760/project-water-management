// The farmer's "Download my figures (CSV)" (farm view): the file as the API
// sends it, with the page's disclaimer line, in the farmer's language (cards.ts
// disclaimer()), as a leading `#` line, so the figures carry it once they
// leave the page (docs/legal/disclaimer-review.md § 3). The page adds it, not
// the API, because the translated words live in the frontend's catalogue.

/** `csv` (with or without its UTF-8 BOM) with `# <note>` as its first line; the BOM stays first. */
export function withNoteLine(csv: string, note: string): string {
	const body = csv.startsWith('﻿') ? csv.slice(1) : csv;
	return `﻿# ${note.replace(/\s+/g, ' ').trim()}\r\n${body}`;
}
