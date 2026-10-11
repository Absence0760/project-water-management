// Who holds the volumes in a total (issue #523 G, D3): the holders counted are those of the rows summed.
import { describe, expect, it } from 'vitest';
import { holdersWithin, takesWithin, totalShown, waterYearWithin } from './holders';

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
		expect([0, 1, 4, 5, 6].map(totalShown)).toEqual([true, false, false, true, true]);
	});
});

describe('waterYearWithin', () => {
	it('clips a water year to the run, and is null outside it', () => {
		expect(waterYearWithin(2016, '2016-10-01', '2019-09-30')).toEqual({ from: '2016-10-01', to: '2017-09-30' });
		expect(waterYearWithin(2016, '2017-01-15', '2017-03-01')).toEqual({ from: '2017-01-15', to: '2017-03-01' });
		expect(waterYearWithin(2020, '2016-10-01', '2019-09-30')).toBeNull();
	});
});
