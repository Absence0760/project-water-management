import { describe, expect, it } from 'vitest';
import { alignDaily, fmtCompact } from './series';

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
