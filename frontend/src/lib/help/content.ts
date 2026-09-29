// Contextual help and glossary: the /help pages' whole entries, joined from
// the modules that hold the text.
//
//   tips.ts      term, short text, units, field keys: what a <HelpTip> shows.
//                HelpTip loads that module alone (~11 KB gzip), never this one.
//   articles.ts  the fuller text, other names, related ids and source, by id;
//                articles-data.ts the same for the "Input data" topic (its own chunk).
//   farmer.ts    the farm view's words, whole (/farm/words loads only those).
//
// Every /help page loads this (the help sidebar lists the glossary's terms),
// so the /help pages get every entry; nothing outside /help imports it.

import { ARTICLES as TOPIC_ARTICLES } from './articles';
import { DATA_ARTICLES } from './articles-data';
import { FARMER_HELP } from './farmer';
import { TIPS, tipFor } from './tips';
import type { HelpCategory, HelpEntry } from './types';

export type { HelpArticle, HelpCategory, HelpEntry, HelpTipText } from './types';
export { helpFieldKeys } from './tips';

export const CATEGORY_TITLES: Record<HelpCategory, string> = {
	basics: 'Basics',
	network: 'Network',
	farm: 'Hydrological units and dams',
	crops: 'Crops and irrigation demand',
	transfers: 'Transfers',
	flow: 'Natural flow and calibration',
	ewr: 'Environmental water requirement',
	data: 'Input data',
	results: 'Run results',
	fit: 'Goodness of fit',
	farmer: 'Words on your hydrological unit page'
};

/** Every article by id: articles.ts and the "Input data" topic's (articles-data.ts). */
export const ARTICLES = { ...TOPIC_ARTICLES, ...DATA_ARTICLES };

const regions = new Intl.DisplayNames(['en'], { type: 'region' });

/** An entry's countries by name ("South Africa"), for the glossary. */
export const countryNames = (codes: readonly string[]) => codes.map((c) => regions.of(c) ?? c).join(', ');

/** Every entry, in glossary order: the tips' order, then the farmer words. */
export const HELP: HelpEntry[] = [
	...TIPS.map((tip): HelpEntry => {
		const article = ARTICLES[tip.id];
		if (!article) throw new Error(`help: tip ${tip.id} has no article (articles.ts)`);
		return { ...tip, ...article };
	}),
	...FARMER_HELP
];

// ---------------------------------------------------------------------------
// Lookup and search
// ---------------------------------------------------------------------------

const byId = new Map(HELP.map((e) => [e.id, e]));

/** Entry for a field key (`node.damCapacityM3`) or an entry id (`ewr`). */
export function helpFor(key: string): HelpEntry | undefined {
	const tip = tipFor(key);
	return byId.get(tip ? tip.id : key);
}

const norm = (s: string) =>
	s
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase();

/**
 * Entries matching every word of `query`, best first: term/alias matches
 * before text matches. Empty query → all entries in glossary order.
 */
export function searchHelp(query: string, entries: readonly HelpEntry[] = HELP): HelpEntry[] {
	const words = norm(query).split(/\s+/).filter(Boolean);
	if (!words.length) return [...entries];
	const scored: { e: HelpEntry; score: number; i: number }[] = [];
	entries.forEach((e, i) => {
		const title = norm([e.term, ...(e.aliases ?? [])].join(' '));
		const body = norm([e.short, e.long, e.units ?? ''].join(' '));
		let score = 0;
		for (const w of words) {
			if (title.includes(w)) score += 3;
			else if (body.includes(w)) score += 1;
			else return;
		}
		if (norm(e.term).startsWith(words.join(' '))) score += 5;
		scored.push({ e, score, i });
	});
	return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((s) => s.e);
}
