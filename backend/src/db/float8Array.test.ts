// The binary float8[] parameter (db/float8Array.ts): Postgres's array_recv /
// array_send format, byte for byte. The database side (that the server reads
// it back as the same array, and that its array_send is these bytes) is
// float8Array.db.test.ts.
import { describe, expect, it } from 'vitest';
import { constantValue, float8ArrayParam } from './float8Array.js';

const header = (b: Buffer) => ({ ndim: b.readInt32BE(0), hasNull: b.readInt32BE(4), oid: b.readInt32BE(8) });

describe('float8ArrayParam', () => {
	it('writes a one-dimensional float8 array: header, length and lower bound 1, then length-prefixed big-endian doubles', () => {
		const b = float8ArrayParam([1.5, -2, 0.1]);
		expect(header(b)).toEqual({ ndim: 1, hasNull: 0, oid: 701 });
		expect([b.readInt32BE(12), b.readInt32BE(16)]).toEqual([3, 1]);
		expect(b.length).toBe(20 + 3 * 12);
		const values = [0, 1, 2].map((i) => {
			expect(b.readInt32BE(20 + i * 12)).toBe(8);
			return b.readDoubleBE(24 + i * 12);
		});
		expect(values).toEqual([1.5, -2, 0.1]);
	});

	it('sends a value that is not finite as NULL (4 bytes, length -1) and flags the array as holding NULLs', () => {
		const b = float8ArrayParam([1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null, 2]);
		expect(header(b).hasNull).toBe(1);
		expect(b.readInt32BE(12)).toBe(6);
		let o = 20;
		const read: (number | null)[] = [];
		for (let i = 0; i < 6; i++) {
			const len = b.readInt32BE(o);
			o += 4;
			if (len === -1) read.push(null);
			else {
				expect(len).toBe(8);
				read.push(b.readDoubleBE(o));
				o += 8;
			}
		}
		expect(read).toEqual([1, null, null, null, null, 2]);
		expect(o).toBe(b.length);
	});

	it('writes -0 as 0, as the text format did (String(-0) is "0"), so the stored bits and digests are the same', () => {
		const b = float8ArrayParam([-0]);
		expect(Object.is(b.readDoubleBE(24), 0)).toBe(true);
		expect(b.equals(float8ArrayParam([0]))).toBe(true);
	});

	it('writes an empty array as zero dimensions, as array_send does', () => {
		const b = float8ArrayParam([]);
		expect(header(b)).toEqual({ ndim: 0, hasNull: 0, oid: 701 });
		expect(b.length).toBe(12);
	});

	it('takes a Float64Array as well as a number array', () => {
		expect(float8ArrayParam(new Float64Array([3, 4])).equals(float8ArrayParam([3, 4]))).toBe(true);
	});
});

describe('constantValue', () => {
	it('is the value every element holds', () => {
		expect(constantValue([0, 0, 0])).toBe(0);
		expect(constantValue([2.5])).toBe(2.5);
	});

	it('is 0 for a mix of 0 and -0, as both are stored as 0', () => {
		expect(Object.is(constantValue([-0, 0]), 0)).toBe(true);
		expect(Object.is(constantValue([-0]), 0)).toBe(true);
	});

	it('is null when the values differ, any is not finite, or there are none', () => {
		expect(constantValue([0, 1])).toBeNull();
		expect(constantValue([Number.NaN, Number.NaN])).toBeNull();
		expect(constantValue([1, Number.POSITIVE_INFINITY])).toBeNull();
		expect(constantValue([null, null])).toBeNull();
		expect(constantValue([])).toBeNull();
	});
});
