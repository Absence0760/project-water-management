// search_help (issue #610): a ranked keyword search over the app's help
// guides and glossary, from the generated index (../helpIndex.json,
// `pnpm gen:assistant:help`; the backend imports nothing from the frontend).
// No project data: it reads no database.
import { z } from 'zod';
import helpIndex from '../helpIndex.json' with { type: 'json' };
import { TOOL_NAMES, type AssistantTool } from '../types.js';
import { parseArgs, specOf } from './common.js';

export interface HelpIndexEntry {
	kind: 'guide' | 'glossary';
	id: string;
	title: string;
	aliases?: string[];
	url: string;
	summary?: string;
	text: string;
}

export const HELP_INDEX: readonly HelpIndexEntry[] = (helpIndex as { entries: HelpIndexEntry[] }).entries;

/** Results returned at most. */
export const MAX_HITS = 8;
/** Characters of an entry's text sent with a hit. */
export const SNIPPET_CHARS = 700;

const norm = (s: string) =>
	s
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase();

/** Words too common to rank by. */
const STOP = new Set('a an and are at be by do does for from how i in is it my of on or the to what when where which why with not no does my me this that'.split(' '));

/** The query's words: lower case, accents off, stop words and one-letter words dropped. */
export const queryWords = (q: string) => [...new Set(norm(q).split(/[^\p{L}\p{N}²³]+/u).filter((w) => w.length > 1 && !STOP.has(w)))];

const occurrences = (hay: string, w: string) => {
	let n = 0;
	for (let i = hay.indexOf(w); i >= 0 && n < 5; i = hay.indexOf(w, i + w.length)) n++;
	return n;
};

/** The text around the first word found, about SNIPPET_CHARS long. */
function snippet(text: string, words: readonly string[]): string {
	if (text.length <= SNIPPET_CHARS) return text;
	const lower = norm(text);
	const at = Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0), text.length);
	const start = at === text.length ? 0 : Math.max(0, at - 150);
	return `${start ? '…' : ''}${text.slice(start, start + SNIPPET_CHARS)}${start + SNIPPET_CHARS < text.length ? '…' : ''}`;
}

/**
 * Entries ranked by the query's words: a word in the title or an alias counts
 * 4, in the summary 2, each time in the text 1 (up to 5); an entry with every
 * word gets a bonus, a glossary term equal to the query more. Entries with no
 * word are left out; ties keep the help's own order.
 */
export function searchHelpIndex(query: string, limit = 5, index: readonly HelpIndexEntry[] = HELP_INDEX) {
	const words = queryWords(query);
	if (!words.length) return [];
	const q = norm(query).trim();
	const scored: { e: HelpIndexEntry; score: number; i: number }[] = [];
	index.forEach((e, i) => {
		const title = norm([e.title, ...(e.aliases ?? [])].join(' '));
		const summary = norm(e.summary ?? '');
		const text = norm(e.text);
		let score = 0;
		let hit = 0;
		for (const w of words) {
			const s = (title.includes(w) ? 4 : 0) + (summary.includes(w) ? 2 : 0) + occurrences(text, w);
			if (s) hit++;
			score += s;
		}
		if (!hit) return;
		if (hit === words.length) score += 3 * words.length;
		if (e.kind === 'glossary' && [e.title, ...(e.aliases ?? [])].some((t) => norm(t) === q)) score += 20;
		scored.push({ e, score, i });
	});
	return scored
		.sort((a, b) => b.score - a.score || a.i - b.i)
		.slice(0, limit)
		.map(({ e }) => ({ kind: e.kind, title: e.title, url: e.url, ...(e.summary ? { summary: e.summary } : {}), text: snippet(e.text, words) }));
}

const Args = z
	.object({
		query: z.string().trim().min(1).max(200).describe('Words to look for, e.g. "GR4J X1", "dam pass inflow", "calibration exclusions"'),
		limit: z.number().int().min(1).max(MAX_HITS).default(5).describe(`How many results (at most ${MAX_HITS})`)
	})
	.strict();

export const searchHelpTool: AssistantTool = {
	spec: specOf(
		TOOL_NAMES.searchHelp,
		"Search the app's help guides and glossary: how a screen or setting works, what a term means, how a figure is worked out. Returns the best matches with their help page path.",
		Args
	),
	label: 'Searching the help',
	async run(_ctx, args) {
		const a = parseArgs(Args, args);
		if (!a.ok) return a;
		const hits = searchHelpIndex(a.value.query, a.value.limit);
		return { ok: true, data: hits.length ? { hits } : { hits, note: 'nothing in the help matches; try other words' } };
	}
};
