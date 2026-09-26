// The farmer surfaces' message catalogue (WP-2.5): every key is placed for
// the translator, Afrikaans keeps English's placeholders and bold markers,
// plural stems are whole, and nothing untranslated slips past the
// translation sheet (docs/i18n/af-translation-sheet.md).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { af } from './messages/af';
import { en, notes, sections, type MessageKey } from './messages/en';

const SHEET = readFileSync(new URL('../../../../docs/i18n/af-translation-sheet.md', import.meta.url), 'utf8');
const keys = Object.keys(en) as MessageKey[];
const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
const bolds = (s: string) => (s.match(/\*\*/g) ?? []).length;
const sectionOf = (key: string) => Object.keys(sections).some((p) => key === p || key.startsWith(`${p}.`));

describe('the English catalogue', () => {
	it('puts every key in a section of the translation sheet', () => {
		expect(keys.filter((k) => !sectionOf(k))).toEqual([]);
	});

	it('has notes only for real keys', () => {
		expect(Object.keys(notes).filter((k) => !(k in en))).toEqual([]);
	});

	it('pairs every bold marker', () => {
		expect(keys.filter((k) => bolds(en[k]) % 2 !== 0)).toEqual([]);
	});

	it('gives every plural stem both its .one and .other form', () => {
		const stems = new Set(keys.filter((k) => /\.(one|two|few|other)$/.test(k)).map((k) => k.replace(/\.(one|two|few|other)$/, '')));
		for (const s of stems) {
			expect(keys, s).toContain(`${s}.one`);
			expect(keys, s).toContain(`${s}.other`);
		}
	});
});

describe('the Afrikaans catalogue', () => {
	const translated = Object.entries(af) as [MessageKey, string][];

	it('has only English keys', () => {
		expect(translated.map(([k]) => k).filter((k) => !(k in en))).toEqual([]);
	});

	it('keeps each English placeholder and bold marker', () => {
		for (const [k, v] of translated) {
			expect(placeholders(v), k).toEqual(placeholders(en[k]));
			expect(bolds(v), k).toBe(bolds(en[k]));
		}
	});

	it('lists every key it has no translation for on the translation sheet, with the current English', () => {
		const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
		const missing = keys.filter((k) => af[k] == null && !SHEET.includes(`| \`${k}\` | ${cell(en[k])} |`));
		expect(missing, 'run pnpm gen:i18n:sheet').toEqual([]);
	});

	it('leaves translated keys off the sheet', () => {
		expect(translated.map(([k]) => k).filter((k) => SHEET.includes(`| \`${k}\` |`))).toEqual([]);
	});
});
