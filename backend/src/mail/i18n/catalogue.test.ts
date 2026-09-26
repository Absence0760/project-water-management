// The farmer emails' catalogue (WP-2.5): every key placed for the
// translator, Afrikaans keeps English's placeholders, and every untranslated
// key is on docs/i18n/af-translation-sheet.md with its current English.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { af } from './af.js';
import { en, notes, sections, type MailKey } from './en.js';

const SHEET = readFileSync(new URL('../../../../docs/i18n/af-translation-sheet.md', import.meta.url), 'utf8');
const keys = Object.keys(en) as MailKey[];
const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

describe('the email catalogue', () => {
	it('puts every key in a section of the translation sheet', () => {
		expect(keys.filter((k) => !Object.keys(sections).some((p) => k === p || k.startsWith(`${p}.`)))).toEqual([]);
		expect(Object.keys(notes).filter((k) => !(k in en))).toEqual([]);
	});

	it('has only English keys in Afrikaans, each keeping its placeholders', () => {
		for (const [k, v] of Object.entries(af)) {
			expect(k in en, k).toBe(true);
			expect(placeholders(v!), k).toEqual(placeholders(en[k as MailKey]));
		}
	});

	it('lists every key it has no Afrikaans for on the translation sheet, with the current English', () => {
		const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
		const missing = keys.filter((k) => af[k] == null && !SHEET.includes(`| \`${k}\` | ${cell(en[k])} |`));
		expect(missing, 'run pnpm gen:i18n:sheet').toEqual([]);
	});
});
