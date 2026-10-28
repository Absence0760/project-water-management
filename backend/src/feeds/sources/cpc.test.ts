// NOAA CPC's ONI and AAO files (issue #620, sources/cpc.ts): the parsers on
// short files in CPC's layout (invented values), what they refuse, and the
// synthetic files FEED_SOURCE=fixtures serves.
import { describe, expect, it } from 'vitest';
import { FeedFormatError } from '../errors.js';
import { aaoFixtureText, aaoFixtureValue, fixtureThrough, oniFixtureText, oniFixtureValue, parseAao, parseOni } from './cpc.js';

const ONI = ` SEAS  YR   TOTAL   ANOM
  DJF 1950  25.01  -1.10
  JFM 1950  25.36  -0.90
  FMA 1950  26.10   0.20
`;
const AAO = ` 1979    1    0.2088
 1979    2   -1.3563
 1979    3    0.8992
`;

describe('parseOni', () => {
	it('keeps each season under its centre month (DJF → January of its year)', () => {
		expect(parseOni(ONI)).toEqual({ id: 'oni', firstMonth: '1950-01', values: [-1.1, -0.9, 0.2] });
	});

	it('refuses a file without its header, a row out of place, a gap, a value out of range, or a late start', () => {
		const bad = (t: string) => expect(() => parseOni(t)).toThrow(FeedFormatError);
		bad(ONI.replace('SEAS  YR   TOTAL   ANOM', 'SEASON YEAR ANOM'));
		bad(ONI.replace('JFM 1950', 'XYZ 1950'));
		bad(ONI.replace('  JFM 1950  25.36  -0.90\n', ''));
		bad(ONI.replace('-0.90', '-9.90'));
		bad(ONI.replace('-0.90', 'n/a'));
		bad(` SEAS  YR   TOTAL   ANOM\n  DJF 1990  25.01  -1.10\n`);
		bad(' SEAS  YR   TOTAL   ANOM\n');
	});
});

describe('parseAao', () => {
	it('reads one month a row', () => {
		expect(parseAao(AAO)).toEqual({ id: 'aao', firstMonth: '1979-01', values: [0.2088, -1.3563, 0.8992] });
	});

	it('refuses a month twice, a month 13, a value out of range, or a row that isn’t one', () => {
		const bad = (t: string) => expect(() => parseAao(t)).toThrow(FeedFormatError);
		bad(`${AAO} 1979    3    0.1\n`);
		bad(AAO.replace(' 1979    3', ' 1979   13'));
		bad(AAO.replace('0.8992', '12.5'));
		bad(`${AAO}<html>\n`);
	});
});

describe('the synthetic files (FEED_SOURCE=fixtures)', () => {
	it('run to the months CPC would have published by today, and parse back to the invented values', () => {
		const today = '2026-10-28';
		expect(fixtureThrough('oni', today)).toBe(2026 * 12 + 7);
		const oni = parseOni(oniFixtureText(today));
		expect(oni.firstMonth).toBe('1950-01');
		expect(oni.values.length).toBe((2026 - 1950) * 12 + 8); // through August 2026 (JAS)
		expect(oni.values.at(-1)).toBe(oniFixtureValue(2026, 8));
		const aao = parseAao(aaoFixtureText(today));
		expect(aao.firstMonth).toBe('1979-01');
		expect(aao.values.length).toBe((2026 - 1979) * 12 + 9); // through September 2026
		expect(aao.values.at(-1)).toBe(aaoFixtureValue(2026, 9));
		// Both swing through both signs.
		for (const s of [oni, aao]) {
			expect(Math.min(...(s.values as number[]))).toBeLessThan(-0.5);
			expect(Math.max(...(s.values as number[]))).toBeGreaterThan(0.5);
		}
	});
});
