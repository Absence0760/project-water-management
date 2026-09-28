import { describe, expect, it } from 'vitest';
import { jsonDifferences, REPRODUCE_DIFFERENCES_MAX, reproductionDifferences, type StoredSeries } from './reproduce.js';

const out = (series: { nodeId: string | null; key: string; label: string; values: number[] }[], summary: unknown = { a: 1 }) =>
	({ summary, series }) as unknown as Parameters<typeof reproductionDifferences>[1];

describe('jsonDifferences', () => {
	it('finds nothing in equal values, whatever the key order', () => {
		expect(jsonDifferences({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toEqual([]);
	});

	it('names each differing leaf by its path, a missing key and an array of another length included', () => {
		expect(jsonDifferences({ a: 1, farms: [{ d: 3 }, { d: 4 }], x: [1] }, { a: 2, farms: [{ d: 3 }, { d: 5 }], x: [1, 2], y: null })).toEqual([
			'a',
			'farms[1].d',
			'x',
			'y'
		]);
	});
});

describe('reproductionDifferences', () => {
	const stored = (series: StoredSeries[], summary: unknown = { a: 1 }) => ({ summary, startDate: '2020-01-30', series });

	it('is empty for the same summary and outputs, non-finite values stored as null', () => {
		const r = reproductionDifferences(
			stored([{ nodeId: 'n', key: 'dam_storage', label: 'Storage', values: [1, null, 3] }], { a: 1, b: null }),
			out([{ nodeId: 'n', key: 'dam_storage', label: 'Storage', values: [1, NaN, 3] }], { a: 1, b: NaN })
		);
		expect(r).toEqual({ differences: [], total: 0 });
	});

	it('counts the differing days of a series, with the first date and the largest difference', () => {
		const r = reproductionDifferences(
			stored([{ nodeId: null, key: 'outflow', label: 'Outflow', values: [1, 2, 3, 4] }]),
			out([{ nodeId: null, key: 'outflow', label: 'Outflow', values: [1, 2.5, 3, 1] }])
		);
		expect(r.differences).toEqual([{ kind: 'series', key: 'outflow', nodeId: null, label: 'Outflow', days: 2, firstDate: '2020-01-31', maxAbsDiff: 3 }]);
	});

	it('reports series missing from or extra in the reproduction, and summary paths', () => {
		const r = reproductionDifferences(
			stored([{ nodeId: 'n', key: 'old', label: null, values: [1] }], { a: 1 }),
			out([{ nodeId: 'n', key: 'new', label: 'New', values: [1] }], { a: 2 })
		);
		expect(r.differences).toEqual([
			{ kind: 'summary', path: 'a' },
			{ kind: 'series_missing', key: 'old', nodeId: 'n', label: 'old' },
			{ kind: 'series_extra', key: 'new', nodeId: 'n', label: 'New' }
		]);
	});

	it(`lists at most ${REPRODUCE_DIFFERENCES_MAX} and counts the rest`, () => {
		const many = Object.fromEntries(Array.from({ length: REPRODUCE_DIFFERENCES_MAX + 7 }, (_, i) => [`k${i}`, i]));
		const r = reproductionDifferences(stored([], many), out([], {}));
		expect(r.differences).toHaveLength(REPRODUCE_DIFFERENCES_MAX);
		expect(r.total).toBe(REPRODUCE_DIFFERENCES_MAX + 7);
	});
});
