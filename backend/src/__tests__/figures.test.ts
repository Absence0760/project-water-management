import { describe, expect, it } from 'vitest';
import { figuresAt, holdsFigure } from './figures.js';

// The canary sweep's figure check (#523 G1c): what it must catch, and what it must not mistake for a volume.
describe('holdsFigure', () => {
	const V = 987_654_321;
	const json = (x: unknown) => JSON.stringify(x);

	it('the volume itself, of either sign, as a number or a token (grouped or not)', () => {
		expect(holdsFigure(json({ a: V }), V)).toBe(true);
		expect(holdsFigure(json({ a: -V }), V)).toBe(true);
		expect(holdsFigure(json({ a: V + 0.4 }), V)).toBe(true);
		for (const s of ['987654321', '987 654 321', '987,654,321', "987'654'321", '987 654 321', '-987 654 321 m³', 'used 987654321m3']) expect(holdsFigure(json({ s }), V), s).toBe(true);
	});

	it('its shares by closeness, of either sign: megalitres, a day (365 or 366, m³ or ML), a second, a partial year', () => {
		for (const n of [V / 1000, V / 365, V / 366, V / 365 / 1000, V / 366 / 1000, V / 31_536_000, -V / 365, -V / 366]) expect(holdsFigure(json({ n }), V), String(n)).toBe(true);
		// Rounded to 6 or more significant digits, as a number or in words.
		expect(holdsFigure(json({ n: Math.round(V / 366) }), V)).toBe(true);
		expect(holdsFigure(json({ n: Number((V / 365).toFixed(1)) }), V)).toBe(true);
		expect(holdsFigure(json({ s: 'a day: -2 705 902.25 m³' }), V)).toBe(true);
		expect(holdsFigure(json({ n: (V * 35) / 365 }), V, { partialDays: [35] })).toBe(true);
		expect(holdsFigure(json({ n: (V * 35) / 365 }), V)).toBe(false);
		// A sum of daily shares carries float noise far below the tolerance.
		expect(holdsFigure(json({ n: Array.from({ length: 35 }, () => V / 365).reduce((s, x) => s + x, 0) }), V, { partialDays: [35] })).toBe(true);
	});

	it('small volumes: their daily shares count by closeness too (not only from 365 000 m³ up)', () => {
		const small = 123_457;
		expect(holdsFigure(json({ n: small / 365 }), small)).toBe(true);
		expect(holdsFigure(json({ n: -small / 366 }), small)).toBe(true);
		// Rounded shorter than 6 digits: too short to tell from any other number.
		expect(holdsFigure(json({ n: Number((small / 365).toFixed(2)) }), small)).toBe(false);
	});

	it('not: near misses, uuids, hex runs, dates, or anything under an id key', () => {
		expect(holdsFigure(json({ a: V + 1, b: V / 365 + 1, c: V / 1000 + 1 }), V)).toBe(false);
		expect(holdsFigure(json({ s: '987654321-0000-4000-8000-000000000000' }), V)).toBe(false);
		expect(holdsFigure(json({ s: 'b0e8a1c2-2705-4902-8000-987654321000' }), V)).toBe(false);
		expect(holdsFigure(json({ s: 'sha 9876543210abcdef987654321' }), V)).toBe(false);
		expect(holdsFigure(json({ s: '2021-10-01T00:00:00.000Z' }), 20_211_001)).toBe(false);
		for (const k of ['id', 'nodeId', 'runIds', 'job_id', 'manifestSha256', 'hash']) expect(holdsFigure(json({ [k]: V }), V), k).toBe(false);
		// Positive control: the same number under another key.
		expect(holdsFigure(json({ volume: V }), V)).toBe(true);
	});

	it('a non-JSON answer (CSV, text) is read as one string; each match says where', () => {
		expect(holdsFigure('date,demand\n2021-10-01,2705902.25\n', V)).toBe(true);
		expect(holdsFigure('date,demand\n2021-10-01,12.5\n', V)).toBe(false);
		expect(figuresAt(json({ farms: [{ volume: -V }] }), V)).toEqual([`$.farms[0].volume = ${-V}`]);
	});
});
