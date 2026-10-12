import { describe, expect, it } from 'vitest';
import { compareSeriesNames } from './seriesNames';

// The byte order of each name's UTF-8, as Postgres sorts COLLATE "C".
const bytewise = (a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

describe('compareSeriesNames (issue #523)', () => {
	it('sorts capitals before lower case, as byte order does, not as a linguistic collation does', () => {
		expect(compareSeriesNames('RAIN-B logger', 'average gauge')).toBe(-1);
		expect(compareSeriesNames('average gauge', 'RAIN-B logger')).toBe(1);
		expect(['average gauge', 'RAIN-B logger', 'Station 0021', '', '1 gauge'].sort(compareSeriesNames)).toEqual(['', '1 gauge', 'RAIN-B logger', 'Station 0021', 'average gauge']);
	});

	it('puts a non-ASCII letter after every ASCII one', () => {
		expect(compareSeriesNames('Zeta', 'Ärea')).toBe(-1);
		expect(['Ärea', 'Zeta', 'zeta'].sort(compareSeriesNames)).toEqual(['Zeta', 'zeta', 'Ärea']);
	});

	it('sorts a prefix first and equal names level', () => {
		expect(compareSeriesNames('Gauge', 'Gauge 2')).toBe(-1);
		expect(compareSeriesNames('Gauge 2', 'Gauge')).toBe(1);
		expect(compareSeriesNames('Gauge', 'Gauge')).toBe(0);
	});

	it('orders by code point where UTF-16 code units disagree with UTF-8 bytes', () => {
		// U+1F327 (a surrogate pair, 0xD83C…) against U+FF21: code units put the emoji first, UTF-8 after.
		expect('\u{1F327} rain' < 'Ａ rain').toBe(true);
		expect(compareSeriesNames('\u{1F327} rain', 'Ａ rain')).toBe(1);
	});

	it('agrees with the UTF-8 byte order on a mixed set', () => {
		const names = ['average gauge', 'RAIN-B logger', 'Ärea', 'Zeta', 'zeta', 'Ångström', 'é', 'é', '\u{1F327}', 'Ａ', '_x', '-x', ' x', 'x', 'X', '0', ''];
		for (const a of names) for (const b of names) expect(compareSeriesNames(a, b), `${a} vs ${b}`).toBe(Math.sign(bytewise(a, b)));
	});
});
