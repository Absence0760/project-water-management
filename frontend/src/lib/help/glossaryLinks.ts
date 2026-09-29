// Where a glossary entry lives: one page per topic (issue #162),
// /help/glossary/<topic>#<id>. Type-only imports, so a HelpTip can link to
// its entry without loading the glossary's text (content.test.ts).
//
// The slugs are part of the URL: renaming one breaks bookmarks, so add a
// redirect (glossary/[topic]/+page.svelte) if one ever has to change. A link
// to an entry under the wrong topic, or to the old one-page glossary
// (/help/glossary#<id>, /help#<id>), goes on to the right page.

import type { HelpCategory } from './types';

export const TOPIC_SLUGS: Record<HelpCategory, string> = {
	basics: 'basics',
	network: 'network',
	farm: 'units-and-dams',
	crops: 'crops',
	transfers: 'transfers',
	flow: 'natural-flow',
	ewr: 'ewr',
	data: 'input-data',
	results: 'results',
	fit: 'goodness-of-fit',
	farmer: 'farm-page-words',
};

/** A topic's page, without the app's base path: `/help/glossary/<slug>`. */
export const topicPath = (category: HelpCategory) =>
	`/help/glossary/${TOPIC_SLUGS[category]}`;

/** The topic a slug names, or undefined. */
export function topicForSlug(slug: string): HelpCategory | undefined {
	return (Object.keys(TOPIC_SLUGS) as HelpCategory[]).find(
		(c) => TOPIC_SLUGS[c] === slug,
	);
}

/** An entry's place in the glossary, without the app's base path: `/help/glossary/<slug>#<id>`. */
export const glossaryPath = (entry: { id: string; category: HelpCategory }) =>
	`${topicPath(entry.category)}#${entry.id}`;
