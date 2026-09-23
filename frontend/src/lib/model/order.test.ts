import { describe, expect, it } from 'vitest';
import { bySortOrder, moveTo, reorderSubset } from './order';

const items = (...ids: string[]) => ids.map((id, i) => ({ id, sortOrder: i }));
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe('bySortOrder', () => {
	it('sorts by sortOrder, stable, falling back to array position', () => {
		expect(ids(bySortOrder([{ id: 'a', sortOrder: 2 }, { id: 'b', sortOrder: 1 }, { id: 'c', sortOrder: 1 }]))).toEqual(['b', 'c', 'a']);
		expect(ids(bySortOrder([{ id: 'x' }, { id: 'y' }]))).toEqual(['x', 'y']);
	});
});

describe('moveTo', () => {
	it('moves and renumbers without mutating the input order', () => {
		const src = items('a', 'b', 'c', 'd');
		const out = moveTo(src, 3, 1);
		expect(ids(out)).toEqual(['a', 'd', 'b', 'c']);
		expect(out.map((x) => x.sortOrder)).toEqual([0, 1, 2, 3]);
		expect(ids(src)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('clamps and ignores a bad source index', () => {
		expect(ids(moveTo(items('a', 'b', 'c'), 0, 99))).toEqual(['b', 'c', 'a']);
		expect(ids(moveTo(items('a', 'b'), 5, 0))).toEqual(['a', 'b']);
	});
});

describe('reorderSubset', () => {
	// Gauges G1, G2 stay put while farms F1..F3 are reordered among their slots.
	const all = items('G1', 'F1', 'F2', 'G2', 'F3');
	const farms = ['F1', 'F2', 'F3'];

	it('moves a farm past a gauge without moving the gauge', () => {
		const out = reorderSubset(all, farms, 2, 0); // F3 to the top of the farms
		expect(ids(out)).toEqual(['G1', 'F3', 'F1', 'G2', 'F2']);
		expect(out.map((x) => x.sortOrder)).toEqual([0, 1, 2, 3, 4]);
	});

	it('moves down by one within the subset', () => {
		expect(ids(reorderSubset(all, farms, 1, 2))).toEqual(['G1', 'F1', 'F3', 'G2', 'F2']);
	});

	it('equals moveTo when the subset is everything', () => {
		const every = ids(all);
		expect(ids(reorderSubset(all, every, 4, 0))).toEqual(ids(moveTo(all, 4, 0)));
	});
});
