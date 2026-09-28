// The farmer glossary in Afrikaans (WP-2.5): a translation must be of a
// farmer entry and stamped from the current English; a farmer entry without
// one must be on the translation sheet, so the translator sees it.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HELP } from './content';
import { FARMER_HELP } from './farmer';
import { HELP_AF } from './content.af';

const SHEET = readFileSync(new URL('../../../../docs/i18n/af-translation-sheet.md', import.meta.url), 'utf8');
const hash = (e: { term: string; short: string; long: string }) => createHash('sha256').update(`${e.term}\n${e.short}\n${e.long}`).digest('hex');
const farmer = HELP.filter((e) => e.category === 'farmer');

it('reads the farmer entries from farmer.ts, the module /farm/words and the translation sheet load', () => {
	expect(FARMER_HELP).toEqual(farmer);
});

describe('the Afrikaans farmer glossary', () => {
	it('translates only farmer entries', () => {
		const ids = new Set(farmer.map((e) => e.id));
		expect(Object.keys(HELP_AF).filter((id) => !ids.has(id))).toEqual([]);
	});

	it('is stamped from the current English (else re-check it and re-stamp; until then it is on the sheet again)', () => {
		const stale = farmer.filter((e) => HELP_AF[e.id] && HELP_AF[e.id]!.sourceHash !== hash(e)).map((e) => e.id);
		expect(stale).toEqual([]);
	});

	it('puts every farmer entry without a translation on the translation sheet', () => {
		const missing = farmer.filter((e) => !HELP_AF[e.id] && !SHEET.includes(`| \`help.${e.id}.long\` |`)).map((e) => e.id);
		expect(missing, 'run pnpm gen:i18n:sheet').toEqual([]);
	});
});
