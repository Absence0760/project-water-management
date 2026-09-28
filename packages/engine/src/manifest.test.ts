import { describe, expect, it } from 'vitest';
import { canonicalJson, seriesDigest } from './manifest';

/** A double from its IEEE 754 bit pattern, as RFC 8785 Appendix B lists them. */
const fromBits = (hex: string) => {
	const view = new DataView(new ArrayBuffer(8));
	view.setBigUint64(0, BigInt(`0x${hex}`));
	return view.getFloat64(0);
};

/** SHA-256 hex through WebCrypto, the path a browser takes (the backend uses node:crypto). */
const sha256 = async (text: string) =>
	Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, '0')).join('');

describe('canonicalJson (RFC 8785 JCS)', () => {
	it('serialises numbers as RFC 8785 Appendix B lists them', () => {
		const vectors: [string, string][] = [
			['0000000000000000', '0'],
			['8000000000000000', '0'],
			['0000000000000001', '5e-324'],
			['8000000000000001', '-5e-324'],
			['7fefffffffffffff', '1.7976931348623157e+308'],
			['ffefffffffffffff', '-1.7976931348623157e+308'],
			['4340000000000000', '9007199254740992'],
			['c340000000000000', '-9007199254740992'],
			['4430000000000000', '295147905179352830000'],
			['44b52d02c7e14af5', '9.999999999999997e+22'],
			['44b52d02c7e14af6', '1e+23'],
			['44b52d02c7e14af7', '1.0000000000000001e+23'],
			['444b1ae4d6e2ef4e', '999999999999999700000'],
			['444b1ae4d6e2ef4f', '999999999999999900000'],
			['444b1ae4d6e2ef50', '1e+21'],
			['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
			['3eb0c6f7a0b5ed8d', '0.000001'],
			['41b3de4355555553', '333333333.3333332'],
			['41b3de4355555554', '333333333.33333325'],
			['41b3de4355555555', '333333333.3333333'],
			['41b3de4355555556', '333333333.3333334'],
			['41b3de4355555557', '333333333.33333343'],
			['becbf647612f3696', '-0.0000033333333333333333'],
			['43143ff3c1cb0959', '1424953923781206.2']
		];
		for (const [bits, text] of vectors) expect(canonicalJson(fromBits(bits)), bits).toBe(text);
	});

	it('refuses the numbers JCS refuses (NaN, ±Infinity) and bigint', () => {
		for (const bits of ['7fffffffffffffff', '7ff0000000000000', 'fff0000000000000']) expect(() => canonicalJson(fromBits(bits))).toThrow(TypeError);
		expect(() => canonicalJson({ a: [1, Number.NaN] })).toThrow(/NaN/);
		expect(() => canonicalJson(10n)).toThrow(/bigint/);
	});

	it('matches the RFC 8785 §3.2.2 example (whitespace, literals, numbers, string escapes)', () => {
		const input = JSON.parse(
			'{ "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001], "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/", "literals": [null, true, false] }'
		);
		expect(canonicalJson(input)).toBe(
			'{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}'
		);
	});

	it('sorts keys by UTF-16 code units (RFC 8785 §3.2.3 example)', () => {
		const input = {
			'€': 'Euro Sign',
			'\r': 'Carriage Return',
			'דּ': 'Hebrew Letter Dalet With Dagesh',
			'1': 'One',
			'😀': 'Emoji: Grinning Face',
			'\u0080': 'Control',
			'ö': 'Latin Small Letter O With Diaeresis'
		};
		expect(canonicalJson(input)).toBe(
			'{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}'
		);
	});

	it('gives the same text whatever order the keys were written in, at any depth', () => {
		const a = { z: 1, a: { y: [3, { q: true, b: null }], x: 'x' } };
		const b = { a: { x: 'x', y: [3, { b: null, q: true }] }, z: 1 };
		expect(canonicalJson(a)).toBe(canonicalJson(b));
		expect(canonicalJson(a)).toBe('{"a":{"x":"x","y":[3,{"b":null,"q":true}]},"z":1}');
		// Array order is data, so it is kept.
		expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
	});

	it('follows JSON.stringify for undefined, holes, functions and toJSON', () => {
		// eslint-disable-next-line no-sparse-arrays
		expect(canonicalJson({ a: undefined, b: () => 1, c: [undefined, , 1] })).toBe('{"c":[null,null,1]}');
		expect(canonicalJson({ when: new Date(Date.UTC(2020, 0, 2)) })).toBe('{"when":"2020-01-02T00:00:00.000Z"}');
		expect(() => canonicalJson(undefined)).toThrow(TypeError);
	});

	it('refuses a lone surrogate (not I-JSON) and a cycle, but keeps a valid pair', () => {
		expect(() => canonicalJson('\ud83d')).toThrow(/surrogate/);
		expect(() => canonicalJson({ ['\ude00']: 1 })).toThrow(/surrogate/);
		expect(canonicalJson('😀')).toBe('"😀"');
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => canonicalJson(cyclic)).toThrow(/cyclic/);
		// A shared (not cyclic) reference is fine.
		const shared = { v: 1 };
		expect(canonicalJson([shared, shared])).toBe('[{"v":1},{"v":1}]');
	});
});

describe('seriesDigest', () => {
	it('is the legacy seriesHash input, so hashes stored in old run snapshots stay valid', async () => {
		// Hashes produced by the backend's seriesHash before seriesDigest existed
		// (sha256 of JSON.stringify(values), node:crypto): the digest must hash to them.
		const legacy: [(number | null)[], string][] = [
			[[1, 2.5, null], 'c8638c12c745b2954fa36eb374e2e2f88f31f845eea9d849fb89deda586cfd7c'],
			[[], '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'],
			[[0, -0, 1e-7, 123456789.123, null, Number.NaN, Number.POSITIVE_INFINITY], 'a8027b2c9ca36e35b7e9b80afcce5ef85c3daafabfe7ad4ccefe2d5551ca1309']
		];
		for (const [values, hash] of legacy) {
			expect(seriesDigest(values)).toBe(JSON.stringify(values));
			expect(await sha256(seriesDigest(values))).toBe(hash);
		}
	});

	it('tells a missing day from a zero and a shorter series from a longer one', () => {
		expect(seriesDigest([1, null])).not.toBe(seriesDigest([1, 0]));
		expect(seriesDigest([1])).not.toBe(seriesDigest([1, null]));
	});
});
