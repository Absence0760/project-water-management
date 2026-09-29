// The farmer's "Download my figures (CSV)" (farm view): the file as the API
// sends it, with the page's disclaimer line, in the farmer's language (cards.ts
// disclaimer()), as a leading `#` line, so the figures carry it once they
// leave the page (docs/legal/disclaimer-review.md § 3). The page adds it, not
// the API, because the translated words live in the frontend's catalogue.
//
// The same goes for the column names (issue #124): the API heads each column
// with its series key (`date,demand,supplied,…`, whole m³, the last year), and
// farmCsvForReader words them in the reader's language and lays the file out
// for the spreadsheet a farmer in that language opens it in: a language
// written with a decimal comma (af-ZA) gets `;` between cells, since Excel in
// that locale splits a comma-separated file into one column.
import { msg, type Msg } from '$lib/i18n/msg';

/** `csv` (with or without its UTF-8 BOM) with `# <note>` as its first line; the BOM stays first. */
export function withNoteLine(csv: string, note: string): string {
	const body = csv.startsWith('﻿') ? csv.slice(1) : csv;
	return `﻿# ${note.replace(/\s+/g, ' ').trim()}\r\n${body}`;
}

// i18n-section: farm.csv
/** The file's column names, by the API's header (`date`, then the farm's series keys, engine FARMER_SERIES_KEYS). */
export const FARM_CSV_COLUMNS: Readonly<Record<string, Msg>> = {
	date: msg('Date'),
	demand: msg('Water you needed (m³/day)'),
	supplied: msg('Water you received (m³/day)'),
	deficit: msg('Water you were short (m³/day)'),
	dam_storage: msg('Water in your dam (m³)'),
	spill: msg('Water that spilled from your dam (m³/day)'),
	transfer: msg('Water transferred in (+) or out (−) (m³/day)')
};

export interface FarmCsvWords {
	/** The disclaimer line (cards.ts disclaimer()). */
	note: string;
	/** A column's name in the reader's language: t(FARM_CSV_COLUMNS[key]). */
	column: (words: Msg) => string;
	/** The reader's language's decimal mark (engine language table). */
	decimalMark: '.' | ',';
}

/** One cell, quoted when it holds the separator, a quote or a line break. */
function cell(v: string, sep: string): string {
	return v.includes(sep) || /["\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * The API's farm CSV (farms/view.ts: a `date,<key>,…` header, then ISO dates
 * and plain numbers, no quoting) as the reader saves it: the disclaimer line
 * first, the header in their words (an unknown key stays as sent), and for a
 * decimal-comma language `;` between cells and `,` as the decimal mark. The
 * UTF-8 BOM stays first, so Excel reads "m³" and the Afrikaans letters.
 */
export function farmCsvForReader(csv: string, w: FarmCsvWords): string {
	const body = csv.startsWith('﻿') ? csv.slice(1) : csv;
	const comma = w.decimalMark === ',';
	const sep = comma ? ';' : ',';
	const lines = body.split('\r\n');
	const out = lines.map((line, i) => {
		if (line === '') return line;
		const cells = line.split(',');
		if (i === 0) return cells.map((k) => cell(k in FARM_CSV_COLUMNS ? w.column(FARM_CSV_COLUMNS[k]!) : k, sep)).join(sep);
		return comma ? cells.map((c) => c.replace('.', ',')).join(sep) : line;
	});
	return withNoteLine(out.join('\r\n'), w.note);
}
