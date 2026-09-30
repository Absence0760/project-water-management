// The field history line's words and link (docs/ui.md § Field history).
import { afterEach, describe, expect, it } from 'vitest';
import { compactMonths, fieldHistoryHref, fieldHistoryText } from './fieldLine';

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

describe('compactMonths', () => {
	const row = (vals: string[], unit = ' m³/day') => `${vals.join(', ')}${unit} (Oct–Sep)`;
	const winter = ['0', '0', '0', '0', '0', '0', '0', '800', '800', '800', '800', '12\u202f345.5'];

	it('reads a monthly row set or cleared as its range, or one value every month', () => {
		expect(compactMonths(`none → ${row(winter)}`)).toBe('none → by month: 0–12\u202f345.5 m³/day');
		expect(compactMonths(`${row(new Array(12).fill('300'))} → none`)).toBe('300 m³/day every month → none');
		expect(compactMonths(`the one diversion capacity → ${row(['0.0129', ...new Array(11).fill('800')])}`)).toBe('the one diversion capacity → by month: 0.0129–800 m³/day');
		// A row with no unit, and negative values, compare as numbers, not text.
		expect(compactMonths(`none → ${row(['-5', '10', '9', ...new Array(9).fill('2')], '')}`)).toBe('none → by month: -5–10');
	});

	it('leaves every other change as it is', () => {
		for (const c of ['40% → 60%', 'Oct 300 → 400, Nov 300 → 400 m³/day', 'changed in 5 months', '150\u202f000 m³ → 200\u202f000 m³', 'no → yes', row(['1', '2', '3'])])
			expect(compactMonths(c)).toBe(c);
	});

	it('reaches the history line', () => {
		expect(fieldHistoryText({ ...f, change: `none → ${row(new Array(12).fill('300'))}` })).toBe('Changed 3× · last by Ann, 12 Aug 2026: none → 300 m³/day every month');
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
