// The active language and the message functions (WP-2.5; docs/ui.md
// § Language). No library, and no English catalogue: a message is its
// English, written where it is used (./msg.ts), and every other language is a
// catalogue from a message's id to its words, loaded on first use.
//
//   t('Your dam')                                  → 'Your dam' (or its Afrikaans)
//   t('You’re previewing {farm} as its farmer sees it', { farm: 'Vaalbank' })
//                                                  → '{farm}' filled in
//   t('Create account', {}, 'page title')          → a context, when the same
//                                                    English means two things
//   tn(DAYS, 3)                                    → 'days' (DAYS = plural({ one: 'day', other: 'days' }))
//   tRich('about **{pct}** of the water', { pct }) → a Rich sentence: **…** and
//                                                    { b } values come out bold
//   await setLocale('af')                          → switch (loads messages/af.ts once)
//   i18n.locale                                    → the chosen language
//   wordsLang()                                    → the language the words are in
//
// A message with no translation shows in English. `wordsLang()` stays 'en'
// until the chosen language's catalogue is complete, so the page never claims
// to be Afrikaans while it is mostly English (it feeds <html lang>, the plural
// rules and the date formats). Number formats follow the chosen language at
// once (the language table's decimal mark, a comma for af): see
// $lib/components/farm/format.ts.
//
// Every message must be on the translation sheet: `pnpm gen:i18n:sheet`
// extracts them from the t() / tRich() / msg() / plural() calls
// (scripts/guards/i18n_sheet.mjs) and writes their ids to
// messages/ids.generated.ts. Under test an unlisted message throws, so a
// message that reached t() some other way (a table without msg()) fails
// rather than never being translated.
//
// Components call these inside their templates: they read runes, so a
// language change re-renders what they show.
import { messageId, PLURAL_CATEGORIES, pluralId, type Msg, type Plural, type PluralCategory } from './msg';
import { MESSAGE_COUNT, MESSAGE_IDS } from './messages/ids.generated';
import type { Rich, RichPart } from './rich';

import { i18n, language, wordsLang, type Locale } from './state.svelte';
export * from './state.svelte';
export { msg, plural, type Msg, type Plural } from './msg';

/** A language's words, by message id: a string, or a counted word's forms. */
export type Catalogue = Record<string, string | Partial<Record<PluralCategory, string>>>;

/** An English message: a string literal written at the call, or a Msg from msg() (never an arbitrary string). */
export type English<S extends string> = S & (string extends S ? Msg : unknown);

/**
 * Each language's catalogue loader, found by file: messages/<code>.ts (a two-
 * or three-letter code, so ids.generated.ts is never one)
 * exporting `const <code>` (af.ts → af). A language in the table with no
 * catalogue file yet shows in English. Lazy: a catalogue is its own chunk.
 */
const LOADERS: Partial<Record<string, () => Promise<Catalogue>>> = Object.fromEntries(
	Object.entries(import.meta.glob<Record<string, Catalogue>>(['./messages/[a-z][a-z].ts', './messages/[a-z][a-z][a-z].ts'])).map(([path, load]) => {
		const code = path.slice('./messages/'.length, -'.ts'.length);
		return [code, () => load().then((m) => m[code] ?? {})];
	})
);

/** The languages that have a site catalogue file. */
export const catalogueLanguages = (): string[] => Object.keys(LOADERS);

/** The chosen language's catalogue ({} for English). Raw: replaced whole, never mutated. */
let catalogue = $state.raw<Catalogue>({});
/** The latest setLocale call, so an older, slower load can't win. */
let switching = 0;

/**
 * Every message has a translation in `c`. A count: the catalogue tests keep
 * af.ts free of ids that aren't a current message (a stale translation fails
 * them), so as many entries as messages means all of them.
 */
export const isComplete = (c: Catalogue) => Object.keys(c).length >= MESSAGE_COUNT;

/**
 * Switch language. The choice takes effect at once (numbers); the words
 * follow when the catalogue arrives. `supplied` replaces the lazy load
 * (tests, or a catalogue already in hand).
 */
export async function setLocale(locale: Locale, supplied?: Catalogue): Promise<void> {
	const mine = ++switching;
	i18n.locale = locale;
	if (locale === 'en') {
		catalogue = {};
		i18n.complete = true;
		return;
	}
	const load = LOADERS[locale];
	const loaded = supplied ?? (load ? await load() : {});
	if (mine !== switching) return;
	catalogue = loaded;
	i18n.complete = isComplete(loaded);
}

/**
 * A full stop straight after a value that already ends in one is dropped:
 * Afrikaans abbreviates months with a dot ("31 Des."), and a sentence ending
 * on one reads "…tot 31 Des." rather than "…tot 31 Des.." (issue #51).
 */
const joinStop = (value: string, after: string) => (value.endsWith('.') && after.startsWith('.') ? after.slice(1) : after);

/** `{name}` → vars.name. An unknown placeholder is left as written, so a typo shows rather than vanishing. */
export function fill(template: string, vars: Record<string, string | number> = {}): string {
	return template.replace(/\{(\w+)\}(\.?)/g, (whole, name: string, stop: string) => {
		if (!(name in vars)) return whole;
		const v = String(vars[name]);
		return v + joinStop(v, stop);
	});
}

let listed: Set<string> | undefined;
/** Dev and tests only (the build drops it, and MESSAGE_IDS with it): a message the sheet doesn't list is never translated. */
function checkListed(id: string, english: string): void {
	listed ??= new Set(MESSAGE_IDS);
	if (listed.has(id)) return;
	const problem = `i18n: "${english}" isn't on the translation sheet. Write it in a t() / tRich() / msg() / plural() call and run pnpm gen:i18n:sheet.`;
	if (import.meta.env.MODE === 'test') throw new Error(problem);
	console.warn(problem);
}

/** The ids already worked out, so each message is hashed once. */
const ids = new Map<string, string>();
function idOf(key: string, make: () => string): string {
	let id = ids.get(key);
	if (id === undefined) ids.set(key, (id = make()));
	return id;
}

function message(english: string, context?: string): string {
	if (!import.meta.env.DEV && i18n.locale === 'en') return english;
	const id = idOf(context ? `${context}\u0004${english}` : english, () => messageId(english, context));
	if (import.meta.env.DEV) checkListed(id, english);
	if (i18n.locale === 'en') return english;
	const own = catalogue[id];
	return typeof own === 'string' ? own : english;
}

export function t<S extends string>(english: English<S>, vars?: Record<string, string | number>, context?: string): string {
	return fill(message(english, context), vars);
}

const pluralRules = new Map<string, Intl.PluralRules>();
function category(n: number, ordinal: boolean): Intl.LDMLPluralRule {
	const k = `${wordsLang()}:${ordinal}`;
	let r = pluralRules.get(k);
	if (!r) pluralRules.set(k, (r = new Intl.PluralRules(language(wordsLang()).intl, { type: ordinal ? 'ordinal' : 'cardinal' })));
	return r.select(n);
}

/**
 * The form of a counted word for `n` (Intl.PluralRules in the words'
 * language), with `{n}` filled in. A form the translation or the English
 * lacks falls back to `other`. `ordinal` picks "1st / 2nd / 3rd" forms.
 */
export function tn(forms: Plural, n: number, vars: Record<string, string | number> = {}, ordinal = false): string {
	let words: Partial<Record<PluralCategory, string>> = forms;
	if (import.meta.env.DEV || i18n.locale !== 'en') {
		const id = idOf(`\u0005${PLURAL_CATEGORIES.map((c) => forms[c] ?? '').join('\u0005')}`, () => pluralId(forms));
		if (import.meta.env.DEV) checkListed(id, forms.other);
		const own = i18n.locale === 'en' ? undefined : catalogue[id];
		if (own && typeof own === 'object') words = own;
	}
	return fill(words[category(n, ordinal)] ?? words.other ?? forms.other, { n, ...vars });
}

export type RichVar = string | number | { b: string } | Rich;

/**
 * A Rich sentence ($lib/i18n/rich): `**…**` in the message comes out bold,
 * and so does a `{ b }` value; a Rich value is spliced in as it is. Adjacent
 * plain text is merged.
 */
export function tRich<S extends string>(english: English<S>, vars: Record<string, RichVar> = {}, context?: string): Rich {
	const out: Rich = [];
	const push = (p: RichPart) => {
		if (typeof p === 'string') {
			if (!p) return;
			const last = out[out.length - 1];
			if (typeof last === 'string') out[out.length - 1] = last + p;
			else out.push(p);
		} else if (p.b) out.push(p);
	};
	const text = (v: RichVar): string =>
		typeof v === 'string' || typeof v === 'number' ? String(v) : Array.isArray(v) ? v.map((p) => (typeof p === 'string' ? p : p.b)).join('') : v.b;
	message(english, context)
		.split(/\*\*(.+?)\*\*/)
		.forEach((segment, i) => {
			const bold = i % 2 === 1;
			const parts = segment.split(/\{(\w+)\}/);
			// The text of the value before each literal part, for joinStop.
			const before = (j: number) => (j > 0 && parts[j - 1]! in vars ? text(vars[parts[j - 1]!]!) : '');
			if (bold) {
				push({ b: parts.map((p, j) => (j % 2 ? (p in vars ? text(vars[p]!) : `{${p}}`) : joinStop(before(j), p))).join('') });
				return;
			}
			parts.forEach((p, j) => {
				if (j % 2 === 0) return push(joinStop(before(j), p));
				const v = vars[p];
				if (v === undefined) push(`{${p}}`);
				else if (typeof v === 'string' || typeof v === 'number') push(String(v));
				else if (Array.isArray(v)) v.forEach(push);
				else push(v);
			});
		});
	return out;
}

/** "A", "A and B", "A, B and C", in the words' language. */
export function joinAnd(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? '';
	// i18n-section: common
	return `${items.slice(0, -1).join(', ')} ${t('and')} ${items[items.length - 1]}`;
}
