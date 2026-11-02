// The binary float8[] parameter against Postgres (db/float8Array.ts): the
// server reads it as the array the old text parameter gave, bit for bit, and
// its array_send is exactly the bytes sent, which is what lets storeRun sign
// a run from its own hashes (app_run_signing_digest, 304). A constant series
// bound as array_fill is the same array too.
import { describe, expect, it } from 'vitest';
import { asOwner } from '../__tests__/helpers.js';
import { constantValue, float8ArrayParam } from './float8Array.js';

// Values whose text form is easy to get wrong: a decimal fraction, a subnormal, the extremes, -0, and the non-finite ones (NULL).
const tricky = [0.1, 1 / 3, 5e-324, 1e-310, 1.7976931348623157e308, -2.2250738585072014e-308, -0, 0, 123456789.123456789, Number.NaN, Number.POSITIVE_INFINITY, -1];
/** The old storeRun parameter: a number array node-postgres sends as `{…}` text. */
const asText = (xs: number[]) => xs.map((v) => (Number.isFinite(v) ? v : null));

describe('float8ArrayParam in Postgres', () => {
	it('stores the very array the text parameter stored, and array_send gives back exactly the bytes sent', async () => {
		const bin = float8ArrayParam(tricky);
		const [row] = (await asOwner(
			`SELECT array_send($1::float8[]) = array_send($2::float8[]) AS same, array_send($1::float8[]) AS sent, $1::float8[] AS v`,
			[bin, asText(tricky)]
		)) as { same: boolean; sent: Buffer; v: (number | null)[] }[];
		expect(row!.same).toBe(true);
		expect(row!.sent.equals(bin)).toBe(true);
		expect(row!.v).toEqual(asText(tricky).map((v) => (v === null ? null : v + 0)));
		// Positive control: a changed value is told apart.
		const [other] = (await asOwner('SELECT array_send($1::float8[]) = array_send($2::float8[]) AS same', [bin, asText([...tricky.slice(0, -1), -1.0000000000000002])])) as {
			same: boolean;
		}[];
		expect(other!.same).toBe(false);
	});

	it('round-trips an array with no NULLs and an empty one', async () => {
		for (const xs of [[1, 2, 3], []]) {
			const bin = float8ArrayParam(xs);
			const [row] = (await asOwner('SELECT array_send($1::float8[]) AS sent, $1::float8[] AS v, array_send($2::float8[]) = array_send($1::float8[]) AS same', [bin, xs])) as {
				sent: Buffer;
				v: number[];
				same: boolean;
			}[];
			expect(row!.sent.equals(bin)).toBe(true);
			expect(row!.v).toEqual(xs);
			expect(row!.same).toBe(true);
		}
	});

	it("builds a constant series with array_fill as the same array the values would have sent", async () => {
		for (const xs of [Array.from({ length: 16_161 }, () => 0), [-0, 0, -0], [42.5, 42.5]]) {
			const c = constantValue(xs);
			expect(c).not.toBeNull();
			const [row] = (await asOwner('SELECT array_send(array_fill($1::float8, ARRAY[$2::int])) AS filled', [c, xs.length])) as { filled: Buffer }[];
			expect(row!.filled.equals(float8ArrayParam(xs))).toBe(true);
		}
	});
});
