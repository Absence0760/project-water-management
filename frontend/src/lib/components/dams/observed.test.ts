// Dams → Seen from space (./observed.ts, issue #604 R5-B): the fold's line,
// the summary, the match notes, the chart's series and flag lanes, and the
// table of views. Dates, so under a skewed TZ (CLAUDE.md rule 7): UTC+14
// would move a local-midnight date a day.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ObservedDam, ObservedPoint } from '#lib/api/types.js';
import { fullAreaWords, matchNotes, OBSERVED_LANE_COLOR, observedChartSeries, observedFor, observedLanes, observedLine, summaryWords, viewRows } from './observed';

let tz: string | undefined;
beforeAll(() => {
	tz = process.env.TZ;
	process.env.TZ = 'Pacific/Kiritimati';
});
afterAll(() => {
	process.env.TZ = tz;
});

const sp = (s: string | null | undefined) => s?.replace(/[  ]/g, ' ');

const point = (date: string, wetAreaM2: number, more: Partial<ObservedPoint> = {}): ObservedPoint => ({
	date,
	source: 'wofs',
	wetAreaM2,
	pctObserved: 100,
	modelledAreaM2: 30_000,
	compared: true,
	skip: null,
	seenFull: false,
	seenEmpty: false,
	modelFull: false,
	modelEmpty: false,
	mismatch: null,
	...more
});

const dam = (points: ObservedPoint[], more: Partial<ObservedDam> = {}): ObservedDam => {
	const c = points.filter((p) => p.compared);
	return {
		nodeId: 'n1',
		features: [{ id: 'f1', name: 'Bo-dam', nodeId: 'n1', match: { status: 'matched', damShare: 0.9, waterbodyShare: 0.95 } }],
		fullArea: { areaM2: 40_000, from: 'entered' },
		inRun: true,
		points,
		summary: {
			compared: c.length,
			skipped: points.length - c.length,
			biasPctOfFull: c.length ? 6.2 : null,
			withinShare: c.length ? 0.75 : null,
			seenFull: c.filter((p) => p.seenFull).length,
			seenEmpty: c.filter((p) => p.seenEmpty).length,
			mismatches: c.filter((p) => p.mismatch).length,
			latestClear: points.length ? { date: points.at(-1)!.date, source: 'wofs', wetAreaM2: points.at(-1)!.wetAreaM2, pctObserved: 100 } : null
		},
		...more
	};
};

describe('observedLine', () => {
	it('says how many clear views were compared, how many disagree and how many agree within 10 %', () => {
		const d = dam([point('2022-01-05', 25_000), point('2022-01-21', 39_000, { seenFull: true, mismatch: 'seen-full' }), point('2022-02-06', 1, { compared: false, skip: 'partly-seen' })]);
		expect(observedLine(d, false, null, 0.1)).toBe('2 clear views compared · 1 disagrees · 75% within ±10%');
		expect(observedLine(dam([point('2022-01-05', 25_000)]), false, null, 0.1)).toBe('1 clear view compared · none disagree · 75% within ±10%');
		// The threshold is the API's, not a fixed 10 %.
		expect(observedLine(dam([point('2022-01-05', 25_000)]), false, null, 0.15)).toBe('1 clear view compared · none disagree · 75% within ±15%');
	});

	it('says why there is nothing: loading, a failure, no outline, no views, none compared', () => {
		expect(observedLine(null, true, null, 0.1)).toBe('loading…');
		expect(observedLine(null, false, 'boom', 0.1)).toBe('couldn’t be loaded');
		expect(observedLine(null, false, null, 0.1)).toBe('no outline of this dam on the map');
		expect(observedLine(dam([]), false, null, 0.1)).toBe('no satellite views yet');
		expect(observedLine(dam([point('2022-03-01', 5, { compared: false, skip: 'no-run' })]), false, null, 0.1)).toBe('none compared · latest clear view 1 Mar 2022');
	});
});

describe('the words beside the chart', () => {
	it('summarises the compared views: the span, the bias in words, the share within, the flags', () => {
		const d = dam([point('2022-01-05', 25_000, { seenEmpty: false }), point('2022-01-21', 39_000, { seenFull: true })]);
		expect(sp(summaryWords(d, 0.1))).toBe(
			'2 clear views from 5 Jan 2022 to 21 Jan 2022: on average the model has 6% of the full area more water surface than the satellite saw; within ±10% of the full area on 75% of them. Seen full 1 time.'
		);
		expect(summaryWords(dam([point('2022-01-05', 1, { compared: false, skip: 'no-run' })]), 0.1)).toBeNull();
		expect(sp(summaryWords({ ...d, summary: { ...d.summary, biasPctOfFull: -0.2 } }, 0.1))).toContain(': the model and the satellite agree on average;');
	});

	it('names where the full area comes from', () => {
		expect(sp(fullAreaWords(dam([])))).toBe('Full area 4.00 ha, as entered.');
		expect(sp(fullAreaWords(dam([], { fullArea: { areaM2: 250_000, from: 'survey' } })))).toBe('Full area 25.0 ha, the top of its survey curve.');
		expect(fullAreaWords(dam([], { fullArea: null }))).toBeNull();
	});

	it('says which outlines Waterbodies merged, missed or hasn’t matched yet, and nothing for a matched one', () => {
		const d = dam([], {
			features: [
				{ id: 'a', name: 'A', nodeId: 'n1', match: { status: 'matched', damShare: 1, waterbodyShare: 1 } },
				{ id: 'b', name: 'B', nodeId: 'n1', match: { status: 'merged', damShare: 1, waterbodyShare: 0.4 } },
				{ id: 'c', name: '', nodeId: 'n1', match: { status: 'none', damShare: null, waterbodyShare: null } },
				{ id: 'd', name: 'D', nodeId: 'n1', match: null }
			]
		});
		expect(matchNotes(d)).toEqual([
			'“B” is merged with a neighbouring water body in DE Africa Waterbodies, so only WOfS views of its own outline are compared.',
			'An unnamed dam outline has no DE Africa Waterbodies polygon (too small, or not mapped): only WOfS views of its own outline.',
			'“D” hasn’t been matched to DE Africa Waterbodies yet: only WOfS views of its own outline are compared.'
		]);
	});
});

describe('the chart', () => {
	it('draws the modelled area, the compared and other views on one daily axis in hectares, and the full area dashed', () => {
		const d = dam([point('2022-01-02', 20_000), point('2022-01-04', 10_000, { compared: false, skip: 'partly-seen' })]);
		const s = observedChartSeries(d, { startDate: '2022-01-01', values: [30_000, 31_000, null, 32_000] });
		expect(s.map((x) => [x.label, x.style ?? 'line', x.startDate, x.values, x.hidden ?? false])).toEqual([
			['Modelled area', 'line', '2022-01-01', [3, 3.1, null, 3.2], false],
			['Seen from space', 'points', '2022-01-01', [null, 2, null, null], false],
			['Seen, not compared', 'points', '2022-01-01', [null, null, null, 1], true],
			['Full area', 'dashed', '2022-01-01', [4, 4, 4, 4], false]
		]);
		// Sparse views read better as larger dots than a line's 3 px: the compared ones larger than the rest.
		expect(s.map((x) => x.pointSize)).toEqual([undefined, 8, 6, undefined]);
	});

	it('pairs each view with its own day, at the run’s first and last day, whatever the zone', () => {
		// A run of three days: a view on the first and on the last land on their own index, not a day either side.
		const d = dam([point('2022-01-01', 10_000), point('2022-01-03', 20_000)]);
		const s = observedChartSeries(d, { startDate: '2022-01-01', values: [30_000, 31_000, 32_000] });
		expect(s.find((x) => x.label === 'Seen from space')!.values).toEqual([1, null, 2]);
		// A view a day after the run's end widens the axis by exactly that day.
		const late = observedChartSeries(dam([point('2022-01-04', 10_000)]), { startDate: '2022-01-01', values: [30_000, 31_000, 32_000] });
		expect(late.find((x) => x.label === 'Seen from space')!.values).toEqual([null, null, null, 1]);
		expect(late.find((x) => x.label === 'Modelled area')!.values).toEqual([3, 3.1, 3.2]);
	});

	it('ends a forecast run’s modelled area before its forecast, and keeps the views', () => {
		const d = dam([point('2022-01-02', 20_000)]);
		const s = observedChartSeries(d, { startDate: '2022-01-01', values: [30_000, 31_000, 32_000, 33_000] }, '2022-01-03');
		expect(s.find((x) => x.label === 'Modelled area')!.values).toEqual([3, 3.1]);
		expect(s.find((x) => x.label === 'Seen from space')!.values).toEqual([null, 2]);
		// No forecast: the whole series.
		expect(observedChartSeries(d, { startDate: '2022-01-01', values: [30_000, 31_000, 32_000] }, null).find((x) => x.label === 'Modelled area')!.values).toEqual([3, 3.1, 3.2]);
	});

	it('draws the views alone with no run, and nothing with neither', () => {
		const s = observedChartSeries(dam([point('2022-01-02', 20_000, { compared: false, skip: 'no-run' })], { fullArea: null }), null);
		expect(s.map((x) => [x.label, x.values])).toEqual([['Seen, not compared', [1 * 2]]]);
		expect(observedChartSeries(dam([], { fullArea: null }), null)).toEqual([]);
	});

	it('marks the flags as lanes, each a day, only the ones there are', () => {
		const d = dam([point('2022-01-02', 39_000, { seenFull: true }), point('2022-01-03', 100, { seenEmpty: true, mismatch: 'seen-empty' }), point('2022-01-04', 100, { compared: false, skip: 'partly-seen', seenEmpty: true })]);
		expect(observedLanes(d).map((l) => [l.label, l.color, l.ranges])).toEqual([
			['Disagree', OBSERVED_LANE_COLOR.disagree, [{ start: '2022-01-03', end: '2022-01-03' }]],
			['Seen full', OBSERVED_LANE_COLOR.seenFull, [{ start: '2022-01-02', end: '2022-01-02' }]],
			['Seen empty', OBSERVED_LANE_COLOR.seenEmpty, [{ start: '2022-01-03', end: '2022-01-03' }]]
		]);
		expect(observedLanes(dam([point('2022-01-02', 20_000)]))).toEqual([]);
	});
});

describe('the table of views', () => {
	it('lists them newest first, with the difference and flags, or why one wasn’t compared', () => {
		const d = dam([point('2022-01-02', 20_000, { source: 'waterbodies' }), point('2022-01-03', 100, { seenEmpty: true, mismatch: 'seen-empty' }), point('2022-01-04', 100, { compared: false, skip: 'partly-seen', pctObserved: 40, modelledAreaM2: null })]);
		expect(viewRows(d).map((r) => [r.date, r.source, sp(r.seen), r.clear, sp(r.modelled), sp(r.note), r.mismatch])).toEqual([
			['4 Jan 2022', 'WOfS, inside the dam’s outline', '0.01 ha', '40%', '–', 'Not compared: partly seen (cloud or shadow)', false],
			['3 Jan 2022', 'WOfS, inside the dam’s outline', '0.01 ha', '100%', '3.00 ha', 'Model +2.99 ha; Disagree: satellite empty, model holds water; seen empty', true],
			['2 Jan 2022', 'DE Africa Waterbodies', '2.00 ha', '100%', '3.00 ha', 'Model +1.00 ha', false]
		]);
	});

	it('names the Sentinel sources the table allows since 277 (issue #624), as their own outline views', () => {
		const d = dam([point('2022-01-05', 100, { source: 's2' }), point('2022-01-06', 100, { source: 's1' })]);
		expect(viewRows(d).map((r) => r.source)).toEqual(['Sentinel-1 radar, inside the dam’s outline', 'Sentinel-2, inside the dam’s outline']);
	});
});

describe('observedFor', () => {
	it('finds the unit’s entry, or null', () => {
		const d = dam([]);
		const data = { attribution: 'x', thresholds: { minPctObserved: 90, fullShare: 0.95, emptyShare: 0.05, pixelM2: 900, clearlyNotFull: 0.8, clearlyWet: 0.2, withinShare: 0.1 }, run: null, dams: [d] };
		expect(observedFor(data, 'n1')).toBe(d);
		expect(observedFor(data, 'n2')).toBeNull();
		expect(observedFor(null, 'n1')).toBeNull();
	});
});
