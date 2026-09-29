// The help text's shapes. Type-only, so the modules that hold the text
// (tips.ts, articles.ts, farmer.ts) import nothing at run time: each stays
// its own chunk, and scripts/guards/i18n_sheet.mjs can load farmer.ts with
// Node's type stripping.

export type HelpCategory =
	| 'basics'
	| 'network'
	| 'farm'
	| 'crops'
	| 'transfers'
	| 'flow'
	| 'ewr'
	| 'data'
	| 'results'
	| 'fit'
	| 'farmer';

export interface HelpEntry {
	/** Stable anchor on its glossary topic's page (`/help/glossary/<topic>#<id>`, glossaryLinks.ts). Lowercase, hyphenated. */
	id: string;
	term: string;
	/** One sentence, ≤ 140 characters: what the HelpTip shows first. */
	short: string;
	/** Fuller explanation. Paragraphs separated by a blank line. */
	long: string;
	units?: string;
	category: HelpCategory;
	/** Other names people search for (abbreviations, workbook labels). */
	aliases?: string[];
	/** Form/result keys this entry explains (see tips.ts's header comment). */
	fields?: string[];
	/** Ids of related entries. */
	related?: string[];
	/**
	 * Where the concept comes from: a workbook sheet or a doc. For maintainers:
	 * the glossary doesn't show it (readers can't open the repo's docs).
	 */
	source: string;
	/**
	 * The countries (ISO 3166-1 alpha-2, e.g. 'ZA') an entry only applies in:
	 * a national dataset, law or method. Absent = applies anywhere. The
	 * glossary says so; hiding them outside those countries waits on country
	 * presets (international.md WP-I.4, WP-I.12).
	 */
	countries?: string[];
}

/** What a HelpTip shows and looks up by (tips.ts). */
export type HelpTipText = Pick<HelpEntry, 'id' | 'term' | 'short' | 'units' | 'category' | 'fields'>;

/** The rest of an entry, only the glossary and search read (articles.ts). */
export type HelpArticle = Pick<HelpEntry, 'long' | 'aliases' | 'related' | 'source' | 'countries'>;

/**
 * A farmer glossary entry in another language (content.<code>.ts, WP-2.5).
 * `sourceHash` is the SHA-256 (hex) of the English `term + "\n" + short +
 * "\n" + long` it was translated from, so a stale translation is caught.
 */
export interface HelpTranslation {
	term: string;
	short: string;
	long: string;
	sourceHash: string;
}
