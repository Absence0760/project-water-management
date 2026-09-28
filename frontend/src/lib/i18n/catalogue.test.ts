// The farmer surfaces' messages (WP-2.5): every message is read from the
// source by the translation sheet's extractor, placed in a section with its
// notes still attached, Afrikaans keeps English's placeholders and bold
// markers, and nothing untranslated or stale slips past the translation sheet
// (docs/i18n/af-translation-sheet.md).
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { extracted, type Extracted } from './fixtureCatalogue';
import { af } from './messages/af';
import { MESSAGE_COUNT, MESSAGE_IDS } from './messages/ids.generated';
import { PLURAL_CATEGORIES } from './msg';
import { NOTES, SECTIONS } from './sheet';

const SHEET = readFileSync(new URL('../../../../docs/i18n/af-translation-sheet.md', import.meta.url), 'utf8');
const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
const bolds = (s: string) => (s.match(/\*\*/g) ?? []).length;
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
/** A message's English, one entry per form: [row id, English]. */
const rows = (m: Extracted): [string, string][] =>
	m.kind === 'plural' ? PLURAL_CATEGORIES.filter((c) => m.forms![c] != null).map((c) => [`${m.id}.${c}`, m.forms![c]!]) : [[m.id, m.english!]];

let messages: Map<string, Extracted>;
let problems: string[];
beforeAll(async () => {
	({ messages, problems } = await extracted(Object.keys(SECTIONS)));
});

describe('the messages', () => {
	it('are all readable by the extractor, each in a known section', () => {
		expect(problems).toEqual([]);
		expect(messages.size).toBeGreaterThan(400);
	});

	it('match the generated id list (run pnpm gen:i18n:sheet)', () => {
		expect([...messages.keys()].sort()).toEqual([...MESSAGE_IDS]);
		expect(MESSAGE_COUNT).toBe(MESSAGE_IDS.length);
	});

	it('use every section the sheet describes', () => {
		const used = new Set([...messages.values()].map((m) => m.section));
		expect(Object.keys(SECTIONS).filter((s) => !used.has(s))).toEqual([]);
	});

	it('have notes only for English a message has (an edited message can’t leave its note behind)', () => {
		const english = new Set([...messages.values()].map((m) => (m.kind === 'plural' ? m.forms!.other : m.english!)));
		expect(Object.keys(NOTES).filter((e) => !english.has(e))).toEqual([]);
	});

	it('pair every bold marker', () => {
		expect([...messages.values()].flatMap(rows).filter(([, e]) => bolds(e) % 2 !== 0)).toEqual([]);
	});

	it('give every counted word its singular and plural', () => {
		for (const m of messages.values()) if (m.kind === 'plural') expect(Object.keys(m.forms!), m.forms!.other).toEqual(expect.arrayContaining(['one', 'other']));
	});
});

describe('the Afrikaans catalogue', () => {
	const translated = Object.entries(af);

	it('has only current messages’ ids: a translation made from English that has since changed is stale (pnpm check:i18n)', () => {
		expect(translated.map(([id]) => id).filter((id) => !messages.has(id))).toEqual([]);
	});

	it('has a string for a message and forms (with "other") for a counted word', () => {
		for (const [id, v] of translated) {
			const m = messages.get(id)!;
			if (m.kind === 'plural') expect(typeof v === 'object' && v.other != null, id).toBe(true);
			else expect(typeof v, id).toBe('string');
		}
	});

	it('keeps each English placeholder and bold marker', () => {
		for (const [id, v] of translated) {
			const m = messages.get(id)!;
			const english = m.kind === 'plural' ? m.forms!.other : m.english!;
			for (const words of typeof v === 'string' ? [v] : Object.values(v)) {
				expect(placeholders(words!), id).toEqual(placeholders(english));
				expect(bolds(words!), id).toBe(bolds(english));
			}
		}
	});

	it('lists every message it has no translation for on the translation sheet, with the current English', () => {
		const missing = [...messages.values()]
			.filter((m) => af[m.id] == null)
			.flatMap(rows)
			.filter(([id, e]) => !SHEET.includes(`| \`${id}\` | ${cell(e)} |`));
		expect(missing, 'run pnpm gen:i18n:sheet').toEqual([]);
	});

	it('leaves translated messages off the sheet', () => {
		expect(translated.map(([id]) => id).filter((id) => SHEET.includes(`| \`${id}`))).toEqual([]);
	});
});
