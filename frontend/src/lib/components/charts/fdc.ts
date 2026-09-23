// Flow-duration curves: the flow equalled or exceeded a given percentage of
// the time, a standard hydrological view of a daily flow record.

/** Exceedance percentages sampled for plotting: fine at the tails, coarser in the middle. */
export function exceedanceGrid(): number[] {
	// [from, to, step] in thousandths of a percent, integer maths so there are no duplicates.
	const bands: [number, number, number][] = [
		[0, 1000, 50],
		[1000, 5000, 100],
		[5000, 95000, 500],
		[95000, 99000, 100],
		[99000, 100000, 50]
	];
	const out: number[] = [];
	for (const [from, to, step] of bands) for (let p = from; p < to; p += step) out.push(p / 1000);
	out.push(100);
	return out;
}

/** Finite values sorted from highest to lowest (nulls/NaN dropped). */
export function sortedDescending(values: ArrayLike<number | null>): Float64Array {
	const out: number[] = [];
	for (let i = 0; i < values.length; i++) {
		const v = values[i];
		if (v != null && Number.isFinite(v)) out.push(v);
	}
	const a = Float64Array.from(out);
	a.sort();
	a.reverse();
	return a;
}

/**
 * Flow equalled or exceeded `pct` % of the time, by linear interpolation on
 * Weibull plotting positions (rank / (n + 1)). `sortedDesc` from sortedDescending().
 */
export function flowAtExceedance(sortedDesc: Float64Array, pct: number): number | null {
	const n = sortedDesc.length;
	if (n === 0) return null;
	if (n === 1) return sortedDesc[0]!;
	// Rank r (1-based) has exceedance 100·r/(n+1); invert for fractional rank.
	const r = (pct / 100) * (n + 1);
	if (r <= 1) return sortedDesc[0]!;
	if (r >= n) return sortedDesc[n - 1]!;
	const lo = Math.floor(r);
	const f = r - lo;
	return sortedDesc[lo - 1]! * (1 - f) + sortedDesc[lo]! * f;
}

/** FDCs for several series on one shared exceedance axis (for a single chart). */
export function flowDurationCurves(series: ArrayLike<number | null>[], grid = exceedanceGrid()) {
	const sorted = series.map(sortedDescending);
	return {
		x: grid,
		ys: sorted.map((s) => grid.map((p) => flowAtExceedance(s, p)))
	};
}

/** The usual percentile flows: Q10 (high), Q50 (median), Q90/Q95 (low flow). */
export function percentileFlows(values: ArrayLike<number | null>) {
	const s = sortedDescending(values);
	return {
		q10: flowAtExceedance(s, 10),
		q50: flowAtExceedance(s, 50),
		q90: flowAtExceedance(s, 90),
		q95: flowAtExceedance(s, 95),
		n: s.length
	};
}
