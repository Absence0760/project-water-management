import { describe, expect, it } from 'vitest';
import { alignDaily, bandSpan, chartName, fmtCompact, isolatedIndices, panWindow, printScale } from './series';

describe('printScale', () => {
	it('lays a chart out twice as large on a 1× screen, so its canvas has 2 device pixels per CSS pixel', () => {
		expect(printScale(1)).toBe(2);
		expect(printScale(1.25)).toBeCloseTo(1.6);
	});

	it('leaves a chart as it is on a screen already at 2× or sharper', () => {
		expect(printScale(2)).toBe(1);
		expect(printScale(3)).toBe(1);
	});

	it('treats a missing or nonsense ratio as 1×', () => {
		expect(printScale(0)).toBe(2);
		expect(printScale(Number.NaN)).toBe(2);
	});
});

describe('alignDaily', () => {
	it('aligns series with different start dates onto a shared axis', () => {
		const { x, ys } = alignDaily([
			{ startDate: '2020-01-01', values: [1, 2] },
			{ startDate: '2020-01-02', values: [5, null, 7] }
		]);
		expect(x).toHaveLength(4);
		expect(x[1]! - x[0]!).toBe(86_400);
		expect(new Date(x[0]! * 1000).toISOString().slice(0, 10)).toBe('2020-01-01');
		expect(ys).toEqual([
			[1, 2, null, null],
			[null, 5, null, 7]
		]);
	});

	it('handles no series', () => {
		expect(alignDaily([])).toEqual({ x: [], ys: [] });
	});
});

describe('fmtCompact', () => {
	it.each([
		[30_000_000, '30M'],
		[2_500_000, '2.5M'],
		[250_000, '250k'],
		[1_500, '1.5k'],
		[120, '120'],
		[1.25, '1.3'],
		[0, '0'],
		[0.25, '0.25'],
		[-5_000_000, '-5M']
	])('%s → %s', (v, want) => expect(fmtCompact(v)).toBe(want));

	// A log axis's lower decades are written out, never as 1e-3 (issue #162).
	it.each([
		[0.001, '0.001'],
		[0.0001, '0.0001'],
		[0.00001, '0.00001'],
		[0.000001, '0.000001'],
		[0.005, '0.005'],
		[0.00025, '0.00025'],
		[0.0012345, '0.0012'],
		[-0.001, '-0.001']
	])('%s → %s (a decimal, not an exponent)', (v, want) => expect(fmtCompact(v)).toBe(want));

	it('keeps the exponent only below 1e-6, where a value is float noise, not a flow', () => {
		expect(fmtCompact(2e-9)).toBe('2e-9');
	});
});

describe('isolatedIndices', () => {
	it('marks a reading with a gap on both sides, including at either end', () => {
		expect(isolatedIndices([4, null, 2, null, null, 3])).toEqual([0, 2, 5]);
	});

	it('leaves runs of two or more to the line', () => {
		expect(isolatedIndices([1, 2, null, 3, 4, 5, null])).toEqual([]);
	});

	it('treats a zero as a reading, not a gap', () => {
		expect(isolatedIndices([null, 0, null, 0, 0])).toEqual([1]);
	});

	it('handles an empty or all-blank series', () => {
		expect(isolatedIndices([])).toEqual([]);
		expect(isolatedIndices([null, null])).toEqual([]);
	});
});

describe('panWindow', () => {
	it('moves the window by delta, keeping its width', () => {
		expect(panWindow(40, 60, -15, 0, 100)).toEqual({ min: 25, max: 45 });
		expect(panWindow(40, 60, 15, 0, 100)).toEqual({ min: 55, max: 75 });
	});

	it('stops at either end of the data instead of scrolling past it', () => {
		expect(panWindow(10, 30, -50, 0, 100)).toEqual({ min: 0, max: 20 });
		expect(panWindow(70, 90, 50, 0, 100)).toEqual({ min: 80, max: 100 });
	});

	it('shows the whole range when the window is as wide as the data', () => {
		expect(panWindow(0, 100, 30, 0, 100)).toEqual({ min: 0, max: 100 });
		expect(panWindow(-5, 120, 30, 0, 100)).toEqual({ min: 0, max: 100 });
	});
});

describe('bandSpan (the forecast band, WP-2.12)', () => {
	const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;
	const x = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'].map(day);

	it('covers from the start of its first day to the end of the data', () => {
		expect(bandSpan({ from: '2026-09-23' }, x)).toEqual({ start: day('2026-09-23'), end: day('2026-09-25') });
	});

	it('ends at the end of `to` when given, and is clipped to the data at both ends', () => {
		expect(bandSpan({ from: '2026-09-21', to: '2026-09-22' }, x)).toEqual({ start: day('2026-09-21'), end: day('2026-09-23') });
		expect(bandSpan({ from: '2026-09-01', to: '2026-12-31' }, x)).toEqual({ start: day('2026-09-20'), end: day('2026-09-25') });
	});

	it('is null when it misses the data, or there is none', () => {
		expect(bandSpan({ from: '2026-10-01' }, x)).toBeNull();
		expect(bandSpan({ from: '2026-09-01', to: '2026-09-10' }, x)).toBeNull();
		expect(bandSpan({ from: '2026-09-21' }, [])).toBeNull();
		expect(bandSpan({ from: 'not a date' }, x)).toBeNull();
	});
});

describe('chartName (a line chart’s accessible name)', () => {
	const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;
	const series = [{ label: 'Demand' }, { label: 'Supplied' }];

	it('names the title, the series, the unit and the dates a daily chart spans', () => {
		expect(chartName('Supply vs demand', series, 'm³/day', [day('2021-10-01'), day('2021-10-02'), day('2022-01-28')])).toBe(
			'Supply vs demand: line chart of Demand, Supplied, in m³/day, 1 Oct 2021 to 28 Jan 2022'
		);
	});

	it('names the x axis of an x–y chart, and leaves out a unit or span it hasn’t got', () => {
		expect(chartName('Storage–yield curve', [{ label: 'Yield' }], 'm³/day', null, 'Dam capacity (thousand m³)')).toBe(
			'Storage–yield curve: line chart of Yield, in m³/day, against Dam capacity (thousand m³)'
		);
		expect(chartName('File preview', [{ label: 'rain.csv' }], '', [])).toBe('File preview: line chart of rain.csv');
	});
});
