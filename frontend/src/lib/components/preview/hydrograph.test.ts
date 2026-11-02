// The Preview dialog's mini hydrograph (PreviewHydrograph.svelte, roadmap WP-1.17): its series and the
// caption's count of the days the edits move the outlet's flow.
import { describe, expect, it } from 'vitest';
import { daysChanged, EDITED_LABEL, hydrographSeries, LAST_LABEL, OBSERVED_LABEL } from './hydrograph';

const line = (startDate: string, values: (number | null)[]) => ({ startDate, values });

describe('hydrographSeries', () => {
	it('draws the last run solid and the edits dashed over it, each in its own colour', () => {
		const s = hydrographSeries({ last: line('2020-01-01', [1, 2]), edited: line('2020-01-01', [1, 3]), observed: null });
		expect(s.map((x) => x.label)).toEqual([LAST_LABEL, EDITED_LABEL]);
		expect(s[0]).toMatchObject({ startDate: '2020-01-01', values: [1, 2], color: '--series-1' });
		expect(s[0]!.style).toBeUndefined();
		expect(s[1]).toMatchObject({ values: [1, 3], color: '--series-2', style: 'dashed' });
	});

	it('puts the observed record behind both, in the observed colour', () => {
		const s = hydrographSeries({ last: line('2020-01-01', [1]), edited: line('2020-01-01', [1]), observed: line('2020-01-01', [null]) });
		expect(s.map((x) => x.label)).toEqual([OBSERVED_LABEL, LAST_LABEL, EDITED_LABEL]);
		expect(s[0]).toMatchObject({ color: '--chart-obs', values: [null] });
	});
});

describe('daysChanged', () => {
	it('counts the days the flow moves past rounding, of the days both have', () => {
		expect(daysChanged(line('2020-01-01', [1, 2, null, 4]), line('2020-01-01', [1, 2.5, 3, 4 + 1e-9]))).toEqual({ changed: 1, compared: 3 });
	});

	it('matches days by date when the edits move the start', () => {
		// The edited run starts a day later: its first day is the last run's second.
		expect(daysChanged(line('2020-01-01', [1, 2, 3]), line('2020-01-02', [2, 4]))).toEqual({ changed: 1, compared: 2 });
		expect(daysChanged(line('2020-01-02', [2, 4]), line('2020-01-01', [1, 2, 3]))).toEqual({ changed: 1, compared: 2 });
	});

	it('reads no change as zero days', () => {
		expect(daysChanged(line('2020-01-01', [5, 5]), line('2020-01-01', [5, 5]))).toEqual({ changed: 0, compared: 2 });
	});
});
