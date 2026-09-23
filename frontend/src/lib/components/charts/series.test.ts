import { describe, expect, it } from 'vitest';
import { alignDaily } from './series';

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
