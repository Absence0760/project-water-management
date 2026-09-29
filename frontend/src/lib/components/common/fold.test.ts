import { describe, expect, it } from 'vitest';
import { foldList } from './fold';

describe('foldList', () => {
	const many = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}` }));
	const key = (s: { id: string }) => s.id;
	const ids = (r: { shown: { id: string }[] }) => r.shown.map(key);
	it('shows the first few in the list’s order and counts the rest', () => {
		const r = foldList(many, key, null, false, 6);
		expect(ids(r)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5']);
		expect(r.hidden).toBe(24);
	});
	it('keeps the picked item when it is further down, in its place after the first few', () => {
		const r = foldList(many, key, 's20', false, 6);
		expect(ids(r)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's20']);
		expect(r.hidden).toBe(23);
		expect(ids(foldList(many, key, 's3', false, 6))).toHaveLength(6);
		expect(ids(foldList(many, key, 'gone', false, 6))).toHaveLength(6);
	});
	it('reads the item’s name through the key it is given', () => {
		const cards = Array.from({ length: 10 }, (_, i) => ({ nodeId: `d${i}` }));
		const r = foldList(cards, (c) => c.nodeId, 'd7', false, 4);
		expect(r.shown.map((c) => c.nodeId)).toEqual(['d0', 'd1', 'd2', 'd3', 'd7']);
		expect(r.hidden).toBe(5);
	});
	it('shows everything when open, or when only one item would fold away', () => {
		expect(foldList(many, key, null, true, 6)).toEqual({ shown: many, hidden: 0 });
		expect(foldList(many.slice(0, 7), key, null, false, 6).hidden).toBe(0);
		expect(foldList(many.slice(0, 8), key, null, false, 6).hidden).toBe(2);
		expect(foldList([], key, null, false, 6)).toEqual({ shown: [], hidden: 0 });
	});
});
