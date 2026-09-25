// Percentile bands over an ensemble's accepted members (docs/model.md §2.10e).
// A band has no percentiles below MIN_BAND_MEMBERS members: with fewer, the
// 5th and 95th percentiles are set by one or two members and read as far
// more certain than they are.

/** Fewest accepted members a band shows percentiles for. */
export const MIN_BAND_MEMBERS = 30;
/** The percentiles every band reports. */
export const BAND_PERCENTILES = [5, 50, 95] as const;

export interface Band {
	/** Members with a value. */
	n: number;
	/** null below MIN_BAND_MEMBERS members. */
	p5: number | null;
	p50: number | null;
	p95: number | null;
	/** The ensemble's extremes; null without members. Not a band: never shown as one. */
	min: number | null;
	max: number | null;
}

/**
 * The value at percentile p (0–100) of ascending `sorted`: linear between
 * order statistics at (n − 1) × p ÷ 100 (Hyndman & Fan 1996 type 7, the
 * spreadsheet PERCENTILE.INC rule). null for no values.
 */
export function quantileSorted(sorted: ArrayLike<number>, p: number): number | null {
	const n = sorted.length;
	if (n === 0) return null;
	const h = ((n - 1) * p) / 100;
	const i = Math.floor(h);
	if (i >= n - 1) return sorted[n - 1]!;
	return sorted[i]! + (h - i) * (sorted[i + 1]! - sorted[i]!);
}

/** The band of `values`; non-finite and null values are left out. */
export function band(values: readonly (number | null | undefined)[], minMembers = MIN_BAND_MEMBERS): Band {
	const v = Float64Array.from(values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))).sort();
	const n = v.length;
	const gated = n < minMembers;
	return {
		n,
		p5: gated ? null : quantileSorted(v, 5),
		p50: gated ? null : quantileSorted(v, 50),
		p95: gated ? null : quantileSorted(v, 95),
		min: n ? v[0]! : null,
		max: n ? v[n - 1]! : null
	};
}

/** Does [p5, p95] of the band hold `x` (float tolerance)? null when the band has no percentiles. */
export function bandHolds(b: Band, x: number): boolean | null {
	if (b.p5 === null || b.p95 === null) return null;
	const tol = 1e-9 * Math.max(1, Math.abs(x));
	return x >= b.p5 - tol && x <= b.p95 + tol;
}
