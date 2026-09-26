// The active language and the message functions (WP-2.5; docs/ui.md
// § Language). No library: a flat catalogue per language, English bundled
// and every other language loaded on first use.
//
//   t('farm.dam.title')                        → 'Your dam'
//   t('farm.preview', { farm: 'Vaalbank' })     → '{farm}' filled in
//   tn('farm.n.day', 3)                         → 'days' (the plural form for 3)
//   tRich('farm.back.pumpLess', { pct })        → a Rich sentence: **…** and
//                                                 { b } values come out bold
//   await setLocale('af')                       → switch (loads af.ts once)
//   i18n.locale                                 → the chosen language
//   wordsLang()                                 → the language the words are in
//
// A key with no translation shows in English. `wordsLang()` stays 'en' until
// the chosen language's catalogue is complete, so the page never claims to be
// Afrikaans while it is mostly English (it feeds <html lang>, the plural
// rules and the date formats). Number formats follow the chosen language at
// once (a decimal comma for af): see $lib/components/farm/format.ts.
//
// Components call these inside their templates: they read runes, so a
// language change re-renders what they show.
import { en, type MessageKey } from './messages/en';
import type { Rich, RichPart } from './rich';

export type { MessageKey } from './messages/en';

export const LOCALES = ['en', 'af'] as const;
export type Locale = (typeof LOCALES)[number];

/** Each language's name in that language (fixed names, never translated). */
export const LANGUAGE_NAMES: Record<Locale, string> = { en: 'English', af: 'Afrikaans' };

export type Catalogue = Partial<Record<MessageKey, string>>;

/** A key's plural stem: 'farm.n.day' for 'farm.n.day.one' / 'farm.n.day.other'. */
export type PluralStem = { [K in MessageKey]: K extends `${infer S}.other` ? S : never }[MessageKey];

const LOADERS: Record<Exclude<Locale, 'en'>, () => Promise<Catalogue>> = {
	af: () => import('./messages/af').then((m) => m.af)
};

export const i18n = $state<{ locale: Locale; complete: boolean }>({ locale: 'en', complete: true });
/** The chosen language's catalogue ({} for English). Raw: replaced whole, never mutated. */
let catalogue = $state.raw<Catalogue>({});
/** The latest setLocale call, so an older, slower load can't win. */
let switching = 0;

export const isLocale = (v: unknown): v is Locale => (LOCALES as readonly unknown[]).includes(v);

/** Every English key has a translation in `c`. */
export const isComplete = (c: Catalogue) => (Object.keys(en) as MessageKey[]).every((k) => c[k] != null);

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
	const loaded = supplied ?? (await LOADERS[locale]());
	if (mine !== switching) return;
	catalogue = loaded;
	i18n.complete = isComplete(loaded);
}

/** The language the words on the page are in: the chosen one once its catalogue is complete, else English. */
export function wordsLang(): Locale {
	return i18n.locale !== 'en' && i18n.complete ? i18n.locale : 'en';
}

/** `{name}` → vars.name. An unknown placeholder is left as written, so a typo shows rather than vanishing. */
export function fill(template: string, vars: Record<string, string | number> = {}): string {
	return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

function message(key: MessageKey): string {
	const own = i18n.locale === 'en' ? undefined : catalogue[key];
	const s = own ?? en[key];
	if (s === undefined) {
		// Only reachable with a computed key; the type rules out a typo.
		if (import.meta.env?.DEV) throw new Error(`i18n: no message "${key}"`);
		return key;
	}
	return s;
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
	return fill(message(key), vars);
}

const pluralRules = new Map<string, Intl.PluralRules>();
function category(n: number, ordinal: boolean): Intl.LDMLPluralRule {
	const k = `${wordsLang()}:${ordinal}`;
	let r = pluralRules.get(k);
	if (!r) pluralRules.set(k, (r = new Intl.PluralRules(wordsLang() === 'af' ? 'af-ZA' : 'en-ZA', { type: ordinal ? 'ordinal' : 'cardinal' })));
	return r.select(n);
}

/**
 * The plural form of `stem` for `n` (Intl.PluralRules in the words'
 * language), with `{n}` filled in. A form the catalogue lacks falls back to
 * `.other`. `ordinal` picks "1st / 2nd / 3rd" forms.
 */
export function tn(stem: PluralStem, n: number, vars: Record<string, string | number> = {}, ordinal = false): string {
	const key = `${stem}.${category(n, ordinal)}` as MessageKey;
	const s = key in en ? message(key) : message(`${stem}.other` as MessageKey);
	return fill(s, { n, ...vars });
}

export type RichVar = string | number | { b: string } | Rich;

/**
 * A Rich sentence ($lib/i18n/rich): `**…**` in the message comes out bold,
 * and so does a `{ b }` value; a Rich value is spliced in as it is. Adjacent
 * plain text is merged.
 */
export function tRich(key: MessageKey, vars: Record<string, RichVar> = {}): Rich {
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
	message(key)
		.split(/\*\*(.+?)\*\*/)
		.forEach((segment, i) => {
			const bold = i % 2 === 1;
			const parts = segment.split(/\{(\w+)\}/);
			if (bold) {
				push({ b: parts.map((p, j) => (j % 2 ? (p in vars ? text(vars[p]!) : `{${p}}`) : p)).join('') });
				return;
			}
			parts.forEach((p, j) => {
				if (j % 2 === 0) return push(p);
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
	return `${items.slice(0, -1).join(', ')} ${t('common.and')} ${items[items.length - 1]}`;
}

// ---- Which language to start in -------------------------------------------

const STORAGE_KEY = 'wm.locale';

/** The language chosen on this device before signing in (null when none or storage is blocked). */
export function readStoredLocale(s: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): Locale | null {
	try {
		const v = s?.getItem(STORAGE_KEY);
		return isLocale(v) ? v : null;
	} catch {
		return null;
	}
}

export function storeLocale(locale: Locale, s: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): void {
	try {
		s?.setItem(STORAGE_KEY, locale);
	} catch {
		// Not kept: the choice still applies for this visit (and to the account, when signed in).
	}
}

/**
 * The account's language (app_user.locale) when signed in and chosen, else
 * this device's choice, else Afrikaans when it is the browser's first
 * language, else English.
 */
export function resolveLocale(
	accountLocale: string | null | undefined,
	stored: Locale | null,
	languages: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]
): Locale {
	if (isLocale(accountLocale)) return accountLocale;
	if (stored) return stored;
	return /^af\b/i.test(languages[0] ?? '') ? 'af' : 'en';
}
