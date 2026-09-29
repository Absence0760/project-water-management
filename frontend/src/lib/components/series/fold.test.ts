import { describe, expect, it } from 'vitest';
import { foldRows } from './fold';

describe('foldRows', () => {
	const many = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}` }));
	const ids = (r: { shown: { id: string }[] }) => r.shown.map((s) => s.id);
	it('shows the first few in the table’s order and counts the rest', () => {
		const r = foldRows(many, null, false, 6);
		expect(ids(r)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5']);
		expect(r.hidden).toBe(24);
	});
	it('keeps the charted series’ row when it is further down, in its place after the first few', () => {
		const r = foldRows(many, 's20', false, 6);
		expect(ids(r)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's20']);
		expect(r.hidden).toBe(23);
		expect(ids(foldRows(many, 's3', false, 6))).toHaveLength(6);
		expect(ids(foldRows(many, 'gone', false, 6))).toHaveLength(6);
	});
	it('shows everything when open, or when only one row would fold away', () => {
		expect(foldRows(many, null, true, 6)).toEqual({ shown: many, hidden: 0 });
		expect(foldRows(many.slice(0, 7), null, false, 6).hidden).toBe(0);
		expect(foldRows(many.slice(0, 8), null, false, 6).hidden).toBe(2);
		expect(foldRows([], null, false, 6)).toEqual({ shown: [], hidden: 0 });
	});
});
