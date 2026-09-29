import { describe, expect, it } from 'vitest';
import { jsonDifference } from './forecastInvariants';

// The prefix-stability check names the summary figure that diverged (issue #192).
describe('jsonDifference', () => {
	it('is null for equal values, whatever their key order', () => {
		expect(jsonDifference({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 })).toBeNull();
	});

	it('names the first differing path and both values', () => {
		expect(jsonDifference({ farms: [{ id: 'f1', deficitDays: 3 }, { id: 'f2', deficitDays: 4 }] }, { farms: [{ id: 'f1', deficitDays: 3 }, { id: 'f2', deficitDays: 5 }] })).toBe(
			'summary.farms[1].deficitDays: 4 vs 5'
		);
	});

	it('says which side lacks a key or an array item', () => {
		expect(jsonDifference({ a: 1 }, { a: 1, b: 2 })).toBe('summary.b: absent vs 2');
		expect(jsonDifference([1, 2], [1])).toBe('summary[1]: 2 vs absent');
	});

	it('reports a type change at its own path, and cuts a long value', () => {
		expect(jsonDifference({ a: { x: 1 } }, { a: null })).toBe('summary.a: {"x":1} vs null');
		const long = 'x'.repeat(200);
		expect(jsonDifference({ a: long }, { a: 'y' })).toBe(`summary.a: "${'x'.repeat(116)}... vs "y"`);
	});
});
