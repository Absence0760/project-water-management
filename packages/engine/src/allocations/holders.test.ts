// Who holds the volumes in a total (issue #523 G, D3): the holders counted are those of the rows summed.
import { describe, expect, it } from 'vitest';
import { amountsWithin, holdersWithin, shownWithin, takesWithin, totalShown, waterYearWithin } from './holders';

describe('holdersWithin', () => {
	const rows = [
		{ holder: 1, volumeM3PerYear: 10, validFrom: '2005-10-01' },
		{ holder: 2, volumeM3PerYear: 10, validFrom: '2018-10-01', validTo: '2024-09-30' },
		{ holder: 2, volumeM3PerYear: 10 },
		{ holder: 3, volumeM3PerYear: 0 },
		{ holder: 4, volumeM3PerYear: 0, waterUse: '21b' },
		{ holder: 5, volumeM3PerYear: 10, validTo: '2000-01-01' }
	];

	it('counts a holder once, only for takes above 0 in force on some day of the span', () => {
		expect(holdersWithin(rows, '2016-10-01', '2017-09-30')).toBe(2);
		expect(holdersWithin(rows, '1999-01-01', '1999-12-31')).toBe(2);
		expect(takesWithin(rows[1]!, '2024-09-30', '2024-09-30')).toBe(true);
		expect(takesWithin(rows[1]!, '2024-10-01', '2025-09-30')).toBe(false);
		expect(takesWithin(rows[3]!, '2016-10-01', '2017-09-30')).toBe(false);
		expect(takesWithin(rows[4]!, '2016-10-01', '2017-09-30')).toBe(false);
	});

	it('shows a sum of none or of 5 or more holders, never of 1 to 4', () => {
		const even = (n: number) => new Array<number>(n).fill(10);
		expect([0, 1, 4, 5, 6].map((n) => totalShown(even(n)))).toEqual([true, false, false, true, true]);
		// A holder whose part is 0 isn't one.
		expect(totalShown([...even(4), 0])).toBe(false);
	});

	it('#523 O: withholds a sum one holder has more than 80 % of, or two more than 90 % (provisional)', () => {
		expect(totalShown([900_000, 1, 1, 1, 1])).toBe(false);
		expect(totalShown([80, 5, 5, 5, 5])).toBe(true);
		expect(totalShown([81, 5, 5, 5, 4])).toBe(false);
		expect(totalShown([60, 31, 3, 3, 3])).toBe(false);
		expect(totalShown([60, 30, 4, 3, 3])).toBe(true);
	});

	it('weighs each holder by days in force, so a row in force a day of the year is a day’s part of it (#523 M)', () => {
		const year = ['2021-10-01', '2022-09-30'] as const;
		const parts = amountsWithin(
			[{ holder: 'a', volumeM3PerYear: 365, validFrom: null }, ...['b', 'c', 'd', 'e'].map((h) => ({ holder: h, volumeM3PerYear: 365, validTo: '2021-10-02' }))],
			...year
		);
		expect([...parts.values()]).toEqual([365 * 365, 730, 730, 730, 730]);
		// Five holders, but one has nearly all of the year: withheld.
		expect(shownWithin([{ holder: 'a', volumeM3PerYear: 365 }, ...['b', 'c', 'd', 'e'].map((h) => ({ holder: h, volumeM3PerYear: 365, validTo: '2021-10-02' }))], ...year)).toBe(false);
	});
});

describe('waterYearWithin', () => {
	it('clips a water year to the run, and is null outside it', () => {
		expect(waterYearWithin(2016, '2016-10-01', '2019-09-30')).toEqual({ from: '2016-10-01', to: '2017-09-30' });
		expect(waterYearWithin(2016, '2017-01-15', '2017-03-01')).toEqual({ from: '2017-01-15', to: '2017-03-01' });
		expect(waterYearWithin(2020, '2016-10-01', '2019-09-30')).toBeNull();
	});
});
