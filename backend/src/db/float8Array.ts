// A float8[] query parameter in Postgres's binary array format (array_recv),
// for the big number arrays a run stores (runs/execute.ts storeRun).
//
// node-postgres sends every parameter as text unless it is a Buffer, which it
// sends in the binary format. A client-sized run's 400-odd series of some
// 16 000 days each went over as ~95 MB of `{1.25,0.5,…}` text: ~1.2 s to build
// in Node and as long again for the server to parse 7 million numbers back (docs/followups.md § V1 run
// budget). This is 12 bytes a value, written with no number formatting, and
// read by the server with no parsing. Bind it with an explicit cast
// (`$n::float8[]`) so the server knows which type's binary input to use.
//
// The values stored are exactly the ones the text path stored, so a run's
// digest (app_run_digest's array_send, 077_run_stamp) and every reader see
// the same bits: a value that isn't finite is NULL, and -0 is 0 (the text
// path wrote `String(-0)`, which is "0").

/** Postgres's OID for float8, the element type the binary array names. */
const FLOAT8_OID = 701;

/**
 * `values` as a binary float8[] parameter: NaN and ±Infinity (and a null or
 * a non-number) become NULL, -0 becomes 0.
 */
export function float8ArrayParam(values: ArrayLike<number | null>): Buffer {
	const n = values.length;
	let nulls = false;
	for (let i = 0; i < n; i++) {
		const v = values[i];
		if (typeof v !== 'number' || !Number.isFinite(v)) {
			nulls = true;
			break;
		}
	}
	// Header: ndim, has-nulls flag, element type; then each dimension's length and lower bound (1-based).
	const header = n === 0 ? 12 : 20;
	const buf = Buffer.allocUnsafe(header + n * 12);
	buf.writeInt32BE(n === 0 ? 0 : 1, 0);
	buf.writeInt32BE(nulls ? 1 : 0, 4);
	buf.writeInt32BE(FLOAT8_OID, 8);
	if (n === 0) return buf;
	buf.writeInt32BE(n, 12);
	buf.writeInt32BE(1, 16);
	let o = header;
	for (let i = 0; i < n; i++) {
		const v = values[i];
		if (typeof v !== 'number' || !Number.isFinite(v)) {
			buf.writeInt32BE(-1, o);
			o += 4;
			continue;
		}
		buf.writeInt32BE(8, o);
		// `+ 0` turns -0 into 0, as the text format did.
		buf.writeDoubleBE(v + 0, o + 4);
		o += 12;
	}
	// A NULL takes 4 bytes, not 12: send only what was written.
	return o === buf.length ? buf : buf.subarray(0, o);
}

/**
 * The one value every element of `values` holds (finite, -0 as 0), or null
 * when they differ, one isn't finite, or there are none. A constant series
 * (a quarter of a client-sized run's: a dam that never spills, a crop's
 * unmet demand where there is none) can be bound as `array_fill(c, ARRAY[n])`,
 * which builds the same array in the server without sending it: array_send's
 * bytes, and so float8ArrayParam's, are identical.
 */
export function constantValue(values: ArrayLike<number | null>): number | null {
	const n = values.length;
	if (n === 0) return null;
	const c = values[0];
	if (typeof c !== 'number' || !Number.isFinite(c)) return null;
	for (let i = 1; i < n; i++) if (values[i] !== c) return null;
	// -0 === 0, so a mix of the two is constant too; both are stored as 0.
	return c + 0;
}
