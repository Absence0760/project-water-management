// Plain-data helpers for model-state snapshots (./snapshot.ts): a stable
// JSON form (sorted keys) for fingerprints, a deep copy, and a JSON-safe
// encoding of numbers. No dependencies, so ../prepare.ts can use them too.

/** A number JSON can't carry exactly (JSON.stringify writes NaN and ±Infinity as null, and −0 as 0), as a token. */
export interface NumberToken {
	$n: 'NaN' | 'Infinity' | '-Infinity' | '-0';
}

/** `T` with every number that JSON can't carry exactly allowed as a NumberToken. */
export type Encoded<T> = T extends number
	? number | NumberToken
	: T extends readonly (infer U)[]
		? Encoded<U>[]
		: T extends object
			? { [K in keyof T]: Encoded<T[K]> }
			: T;

function tokenOf(v: number): NumberToken | null {
	if (Number.isNaN(v)) return { $n: 'NaN' };
	if (v === Infinity) return { $n: 'Infinity' };
	if (v === -Infinity) return { $n: '-Infinity' };
	if (v === 0 && 1 / v < 0) return { $n: '-0' };
	return null;
}

const isToken = (v: unknown): v is NumberToken =>
	!!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as { $n?: unknown }).$n === 'string';

/** A deep copy of plain data (arrays, plain objects, typed arrays as number[]), every number JSON-safe. */
export function encodePlain<T>(v: T): Encoded<T> {
	if (typeof v === 'number') return (tokenOf(v) ?? v) as Encoded<T>;
	if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>, (x) => tokenOf(x) ?? x) as Encoded<T>;
	if (Array.isArray(v)) return v.map((x) => encodePlain(x)) as Encoded<T>;
	if (v && typeof v === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = encodePlain(x);
		return out as Encoded<T>;
	}
	return v as Encoded<T>;
}

/** encodePlain's inverse: a fresh deep copy with every token back to its number. */
export function decodePlain<T>(v: Encoded<T> | unknown): T {
	if (isToken(v)) {
		switch (v.$n) {
			case 'NaN':
				return NaN as T;
			case 'Infinity':
				return Infinity as T;
			case '-Infinity':
				return -Infinity as T;
			case '-0':
				return -0 as T;
		}
		throw new Error(`unknown number token ${JSON.stringify(v)}`);
	}
	if (Array.isArray(v)) return v.map((x) => decodePlain(x)) as T;
	if (v && typeof v === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) out[k] = decodePlain(x);
		return out as T;
	}
	return v as T;
}

/** A deep copy of plain data. */
export const clonePlain = <T>(v: T): T => decodePlain<T>(encodePlain(v));

/**
 * JSON with object keys sorted and undefined members left out, so two equal
 * values give the same text whatever order their keys were written in.
 * Numbers as String(v) (NaN, Infinity and −0 kept apart from null and 0).
 */
export function stableStringify(v: unknown): string {
	if (typeof v === 'number') return Object.is(v, -0) ? '-0' : Number.isFinite(v) ? String(v) : `"${String(v)}"`;
	if (v === null || typeof v !== 'object') return v === undefined ? 'null' : JSON.stringify(v);
	if (ArrayBuffer.isView(v)) return stableStringify(Array.from(v as unknown as ArrayLike<number>));
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
	const keys = Object.keys(v)
		.filter((k) => (v as Record<string, unknown>)[k] !== undefined)
		.sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

/**
 * A 64-bit FNV-1a style hash of a text, as 16 hex digits: a fingerprint, not
 * a security measure (two 32-bit lanes with different offsets and primes).
 */
export function hashText(text: string, seed = ''): string {
	let a = 0x811c9dc5 ^ 0;
	let b = 0xcbf29ce4 ^ 0;
	const s = seed + text;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		a = Math.imul(a ^ c, 0x01000193);
		b = Math.imul(b ^ c, 0x0100019d);
	}
	return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** The same hash, incrementally over numbers (their 64 bits) and short strings. */
export class Hasher {
	private a = 0x811c9dc5 ^ 0;
	private b = 0xcbf29ce4 ^ 0;
	private readonly f = new Float64Array(1);
	private readonly u = new Uint32Array(this.f.buffer);

	private mix(x: number) {
		this.a = Math.imul(this.a ^ (x & 0xffff), 0x01000193);
		this.a = Math.imul(this.a ^ (x >>> 16), 0x01000193);
		this.b = Math.imul(this.b ^ (x & 0xffff), 0x0100019d);
		this.b = Math.imul(this.b ^ (x >>> 16), 0x0100019d);
	}

	number(v: number): this {
		this.f[0] = v;
		this.mix(this.u[0]!);
		this.mix(this.u[1]!);
		return this;
	}

	text(s: string): this {
		this.mix(s.length);
		for (let i = 0; i < s.length; i++) this.mix(s.charCodeAt(i));
		return this;
	}

	digest(): string {
		return (this.a >>> 0).toString(16).padStart(8, '0') + (this.b >>> 0).toString(16).padStart(8, '0');
	}
}
