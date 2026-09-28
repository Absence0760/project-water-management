// Canonical serialisation for reproducible runs (roadmap WP-3.1). Pure: the
// SHA-256 itself is taken by the caller (the backend with node:crypto, the
// browser with WebCrypto), so the engine stays free of I/O and Node APIs.

/**
 * RFC 8785 JSON Canonicalization Scheme (JCS): object keys sorted by UTF-16
 * code units, no whitespace, numbers in ECMAScript's shortest round-trip form
 * (so `1e+30`, `0.000001`, `-0` → `0`) and strings escaped as
 * `JSON.stringify` escapes them. Two values that mean the same JSON give the
 * same text, whatever order their keys were written in, so a hash of it
 * identifies content (a scenario's ops, an evidence pack's manifest).
 *
 * Follows `JSON.stringify` for what JSON can't hold: an `undefined`,
 * function or symbol member is left out, and becomes `null` in an array;
 * `toJSON` is honoured (a `Date` becomes its ISO string). Refuses what JCS
 * refuses: a non-finite number, a `bigint`, a string with a lone surrogate
 * (not I-JSON), and a cycle.
 */
export function canonicalJson(value: unknown): string {
	const out = serialize(value, new Set());
	if (out === undefined) throw new TypeError('canonicalJson: the value has no JSON form');
	return out;
}

// A lone high surrogate (not followed by a low one) or a lone low surrogate.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function serialize(value: unknown, seen: Set<object>): string | undefined {
	if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
		value = (value as { toJSON: () => unknown }).toJSON();
	}
	switch (typeof value) {
		case 'string':
			if (LONE_SURROGATE.test(value)) throw new TypeError('canonicalJson: a string holds a lone surrogate (not I-JSON)');
			return JSON.stringify(value);
		case 'number':
			if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: ${value} has no JSON form`);
			// ECMAScript Number::toString is exactly JCS's number form; -0 serialises as 0.
			return JSON.stringify(value);
		case 'boolean':
			return value ? 'true' : 'false';
		case 'bigint':
			throw new TypeError('canonicalJson: a bigint has no JSON form');
		case 'undefined':
		case 'function':
		case 'symbol':
			return undefined;
	}
	if (value === null) return 'null';
	const obj = value as object;
	if (seen.has(obj)) throw new TypeError('canonicalJson: the value is cyclic');
	seen.add(obj);
	let out: string;
	if (Array.isArray(obj)) {
		// Indexed, not .map: a hole in a sparse array is null, as in JSON.stringify.
		const items: string[] = [];
		for (let i = 0; i < obj.length; i++) items.push(serialize(obj[i], seen) ?? 'null');
		out = `[${items.join(',')}]`;
	} else {
		const rec = obj as Record<string, unknown>;
		// Default sort compares UTF-16 code units, which is JCS's order.
		const parts: string[] = [];
		for (const key of Object.keys(rec).sort()) {
			const v = serialize(rec[key], seen);
			if (v !== undefined) parts.push(`${serialize(key, seen)}:${v}`);
		}
		out = `{${parts.join(',')}}`;
	}
	seen.delete(obj);
	return out;
}

/**
 * The text whose SHA-256 identifies a daily series' values: `JSON.stringify`
 * of the array, a missing day (`null`, or a non-finite number) written as
 * `null`. It is the input of the backend's `seriesHash`, unchanged since run
 * snapshots first carried `valuesSha256`, so every stored hash stays valid and
 * doubles as the key of the series' stored values (`series_blob.sha256`).
 */
export function seriesDigest(values: readonly (number | null)[]): string {
	return JSON.stringify(values);
}
