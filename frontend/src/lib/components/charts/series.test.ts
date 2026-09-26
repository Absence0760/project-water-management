import { describe, expect, it } from 'vitest';
import { alignDaily, fmtCompact, isolatedIndices, panWindow, printScale } from './series';

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
		[0.001, '1e-3'],
		[-5_000_000, '-5M']
	])('%s → %s', (v, want) => expect(fmtCompact(v)).toBe(want));
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
