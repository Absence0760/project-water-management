// The snapshot's plain-data helpers (./plain.ts): JSON-safe numbers, a
// stable text for fingerprints, and the hash.
import { describe, expect, it } from 'vitest';
import { clonePlain, decodePlain, encodePlain, Hasher, hashText, stableStringify } from './plain';

describe('encodePlain / decodePlain', () => {
	it('carries NaN, ±Infinity and −0 through JSON, which drops or folds them', () => {
		const v = { a: [1.5, NaN, Infinity, -Infinity, -0, 0], b: { c: -0, d: null, e: 'x', f: true }, g: Float64Array.from([2, -0]) };
		const back = decodePlain<typeof v>(JSON.parse(JSON.stringify(encodePlain(v))));
		expect(back.a.map((x) => Object.is(x, NaN) || x)).toEqual([1.5, true, Infinity, -Infinity, -0, 0]);
		expect(Object.is(back.a[4], -0)).toBe(true);
		expect(Object.is(back.a[5], 0)).toBe(true);
		expect(Object.is(back.b.c, -0)).toBe(true);
		expect(back.b).toMatchObject({ d: null, e: 'x', f: true });
		// A typed array comes back as a plain array of the same numbers.
		expect(back.g).toEqual([2, -0]);
		expect(Object.is((back.g as unknown as number[])[1], -0)).toBe(true);
	});

	it('round-trips every finite double exactly, and leaves undefined members out', () => {
		const xs = [0.1 + 0.2, 1 / 3, Number.MAX_VALUE, Number.MIN_VALUE, -1e-300, 123456789.123456789];
		expect(decodePlain<number[]>(JSON.parse(JSON.stringify(encodePlain(xs))))).toEqual(xs);
		expect(encodePlain({ a: 1, b: undefined })).toEqual({ a: 1 });
	});

	it('clonePlain is a deep copy', () => {
		const v = { a: [{ b: 1 }] };
		const c = clonePlain(v);
		c.a[0]!.b = 2;
		expect(v.a[0]!.b).toBe(1);
	});
});

describe('stableStringify and the hashes', () => {
	it('does not depend on key order, and tells −0, NaN and null apart', () => {
		expect(stableStringify({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(stableStringify({ a: [1, { c: 3, d: 2 }], b: 1 }));
		expect(new Set([stableStringify([0]), stableStringify([-0]), stableStringify([NaN]), stableStringify([null])]).size).toBe(4);
		expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
	});

	it('hashText is 16 hex digits, stable, and moves with the text', () => {
		expect(hashText('abc')).toMatch(/^[0-9a-f]{16}$/);
		expect(hashText('abc')).toBe(hashText('abc'));
		expect(hashText('abc')).not.toBe(hashText('abd'));
		expect(hashText('abc', 'x')).not.toBe(hashText('abc'));
	});

	it('Hasher tells numbers apart by their bits', () => {
		const h = (...v: number[]) => v.reduce((x, n) => x.number(n), new Hasher()).digest();
		expect(h(1, 2)).toBe(h(1, 2));
		expect(h(1, 2)).not.toBe(h(2, 1));
		expect(h(0)).not.toBe(h(-0));
		expect(h(0.1 + 0.2)).not.toBe(h(0.3));
		expect(new Hasher().text('ab').digest()).not.toBe(new Hasher().text('a').text('b').digest());
	});
});
