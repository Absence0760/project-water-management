import { describe, expect, it } from 'vitest';
import { coverageBins, coverageStats, daysBetween, holeBefore, mergePreview } from './coverage';

describe('coverageStats', () => {
	it('reports period, gaps and the mean of the days present', () => {
		const s = coverageStats({ startDate: '2021-10-01', values: [1, null, 3, null] }, 'flow_observed_m3s');
		expect(s).toEqual({
			startDate: '2021-10-01',
			endDate: '2021-10-04',
			days: 4,
			present: 2,
			missingPct: 50,
			meanDaily: 2,
			meanAnnualMm: null,
			lastValueDate: '2021-10-03'
		});
	});

	it('gives rainfall a mean annual total in mm/a', () => {
		const s = coverageStats({ startDate: '2020-01-01', values: [2, 2, null, 2] }, 'rain_catchment_mm');
		expect(s.meanAnnualMm).toBeCloseTo(730.5, 6);
	});

	it('gives a daily A-pan series a mean annual total too (issue #45)', () => {
		expect(coverageStats({ startDate: '2020-01-01', values: [4, 6] }, 'evap_apan_mm').meanAnnualMm).toBeCloseTo(1826.25, 6);
	});

	it('copes with an all-missing series', () => {
		const s = coverageStats({ startDate: '2020-01-01', values: [null, null] }, 'rain_chirps_mm');
		expect(s.present).toBe(0);
		expect(s.missingPct).toBe(100);
		expect(s.meanDaily).toBeNull();
		expect(s.meanAnnualMm).toBeNull();
		expect(s.lastValueDate).toBeNull();
	});
});

describe('coverageBins', () => {
	it('bins long records by calendar year', () => {
		// 2019-12-31 plus all of 2020 (366 days) plus 2021 (365) plus 2022 (365) = 1097 days.
		const values: (number | null)[] = new Array(1097).fill(1);
		for (let i = 1; i <= 183; i++) values[i] = null; // first half of 2020 missing
		const bins = coverageBins({ startDate: '2019-12-31', values });
		expect(bins.map((b) => b.from.slice(0, 4))).toEqual(['2019', '2020', '2021', '2022']);
		expect(bins[0]).toEqual({ from: '2019-12-31', to: '2019-12-31', frac: 1 });
		expect(bins[1]!.to).toBe('2020-12-31');
		expect(bins[1]!.frac).toBeCloseTo(183 / 366, 10);
		expect(bins[3]!.to).toBe('2022-12-31');
	});

	it('bins short records by month', () => {
		const bins = coverageBins({ startDate: '2021-10-30', values: [1, 1, null, 1] });
		expect(bins).toEqual([
			{ from: '2021-10-30', to: '2021-10-31', frac: 1 },
			{ from: '2021-11-01', to: '2021-11-02', frac: 0.5 }
		]);
	});

	it('is empty for an empty series', () => expect(coverageBins({ startDate: '2021-01-01', values: [] })).toEqual([]));
});

// The age words (agoText, once describeAge here) are $lib/format/age's: age.test.ts.
describe('daysBetween', () => {
	it('counts whole days between ISO dates', () => {
		expect(daysBetween('2025-03-31', '2025-04-12')).toBe(12);
	});
});

describe('mergePreview', () => {
	it('adds, changes and keeps days; blanks in the file never erase stored values', () => {
		const existing = { startDate: '2021-01-02', values: [10, 20, null, 40] };
		const incoming = { startDate: '2021-01-03', values: [20, 25, null, 50, 60] };
		const p = mergePreview(existing, incoming);
		expect(p.unchanged).toBe(1); // 01-03 = 20
		expect(p.added).toBe(3); // 01-04 was a gap; 01-06 and 01-07 extend
		expect(p.changed).toBe(0);
		expect(p.result).toEqual({ startDate: '2021-01-02', values: [10, 20, 25, 40, 50, 60] });
	});

	it('counts corrected readings as changed and extends backwards', () => {
		const p = mergePreview({ startDate: '2021-01-02', values: [1, 2] }, { startDate: '2021-01-01', values: [0, 9] });
		expect(p).toEqual({
			added: 1,
			changed: 1,
			changes: [{ date: '2021-01-02', from: 1, to: 9 }],
			unchanged: 0,
			result: { startDate: '2021-01-01', values: [0, 9, 2] }
		});
	});

	it('lists each overwritten day with its stored and new value, oldest first', () => {
		// 01-02 and 01-04 change; 01-03 is the same; 01-05 fills a gap and 01-06 is new, so neither is overwritten.
		const p = mergePreview({ startDate: '2021-01-01', values: [1, 2, 3, 4, null] }, { startDate: '2021-01-02', values: [5, 3, 9, 7, 8] });
		expect(p.changes).toEqual([
			{ date: '2021-01-02', from: 2, to: 5 },
			{ date: '2021-01-04', from: 4, to: 9 }
		]);
		expect({ changed: p.changed, added: p.added, unchanged: p.unchanged }).toEqual({ changed: 2, added: 2, unchanged: 1 });
	});

	it('leaves a gap as null between a stored series and a later file', () => {
		const p = mergePreview({ startDate: '2021-01-01', values: [1] }, { startDate: '2021-01-03', values: [3] });
		expect(p.result).toEqual({ startDate: '2021-01-01', values: [1, null, 3] });
	});

	it('treats a missing series as all new', () => {
		const p = mergePreview(null, { startDate: '2021-01-01', values: [1, null, 3] });
		expect(p).toEqual({ added: 2, changed: 0, changes: [], unchanged: 0, result: { startDate: '2021-01-01', values: [1, null, 3] } });
	});
});

describe('holeBefore', () => {
	it('counts the blank days between the last stored value and the file’s first day, across a month end', () => {
		expect(holeBefore('2025-01-07', '2025-01-10')).toEqual({ from: '2025-01-08', to: '2025-01-09', days: 2 });
		expect(holeBefore('2024-02-28', '2024-03-02')).toEqual({ from: '2024-02-29', to: '2024-03-01', days: 2 });
	});

	it('is null when the file starts the next day or overlaps', () => {
		expect(holeBefore('2025-01-07', '2025-01-08')).toBeNull();
		expect(holeBefore('2025-01-07', '2025-01-01')).toBeNull();
	});
});
