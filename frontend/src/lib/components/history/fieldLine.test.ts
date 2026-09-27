// The field history line's words and link (docs/ui.md § Field history).
import { afterEach, describe, expect, it } from 'vitest';
import { fieldHistoryHref, fieldHistoryText } from './fieldLine';

const f = { count: 3, lastAt: '2026-08-12T10:00:00.000Z', lastBy: 'Ann', change: '40% → 60%', filter: 'Hilltop: irrigation efficiency' };

describe('fieldHistoryText', () => {
	const tz = process.env.TZ;
	afterEach(() => {
		process.env.TZ = tz;
	});

	it('says how often, who last, when (the viewer’s day) and the values', () => {
		expect(fieldHistoryText(f)).toBe('Changed 3× · last by Ann, 12 Aug 2026: 40% → 60%');
	});

	it('dates by the viewer’s calendar day, not UTC', () => {
		// 23:30 UTC on the 12th is the 13th at UTC+14 and still the 12th at UTC-11.
		const late = { ...f, lastAt: '2026-08-12T23:30:00.000Z' };
		process.env.TZ = 'Pacific/Kiritimati';
		expect(fieldHistoryText(late)).toContain(', 13 Aug 2026:');
		process.env.TZ = 'Pacific/Pago_Pago';
		expect(fieldHistoryText(late)).toContain(', 12 Aug 2026:');
	});

	it('names a deleted account as such', () => {
		expect(fieldHistoryText({ ...f, lastBy: null, count: 1 })).toBe('Changed 1× · last by a deleted account, 12 Aug 2026: 40% → 60%');
	});
});

describe('fieldHistoryHref', () => {
	it('links to History filtered to model and settings changes, the words, and the unit when there is one', () => {
		const withUnit = new URLSearchParams(fieldHistoryHref(f, 'u-1').slice(1));
		expect(Object.fromEntries(withUnit)).toEqual({ tab: 'history', kind: 'revision', unit: 'u-1', q: 'Hilltop: irrigation efficiency' });
		expect(new URLSearchParams(fieldHistoryHref(f).slice(1)).has('unit')).toBe(false);
	});

	it('encodes the words, so a crop’s quotes or an ampersand stay in q', () => {
		const q = new URLSearchParams(fieldHistoryHref({ filter: '"Maize & beans" Kloof' }).slice(1)).get('q');
		expect(q).toBe('"Maize & beans" Kloof');
	});
});
